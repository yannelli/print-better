//! The root update helper for the machine-wide Linux service, whose daemon (user `printbetter`)
//! can't write its binary. The daemon only drops a request file; root checks, verifies, and swaps.

use super::{Plan, Target, fetch};
use crate::clock::now_ms;
use crate::net::ServerUrl;
use crate::paths::Paths;
use crate::{VERSION, fsx, store};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Watched by printbetter-update.path (client/packaging/linux); keep the two in step.
pub const REQUEST: &str = "/var/lib/printbetter/update-request";
pub const TRIGGER_UNIT: &str = "/etc/systemd/system/printbetter-update.path";
/// The helper's own root-owned folder (`StateDirectory=printbetter-update`), readable by the daemon.
const HOME: &str = "/var/lib/printbetter-update";
const OUTCOME: &str = "result.json";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub at: i64,
    pub ok: bool,
    /// The version now installed; `None` when nothing was installed.
    pub installed: Option<String>,
    pub message: String,
}

/// Whether a daemon with these paths can hand its updates to the helper.
pub fn available(paths: &Paths) -> bool {
    cfg!(target_os = "linux") && Path::new(TRIGGER_UNIT).exists() && paths.state.join("update-request") == Path::new(REQUEST)
}

/// The daemon's side: creates the request file in its own state folder; returns when it asked.
pub fn request(paths: &Paths) -> std::io::Result<i64> {
    let at = now_ms();
    fsx::write_atomic(&paths.state.join("update-request"), at.to_string().as_bytes(), false)?;
    Ok(at)
}

pub fn last_outcome() -> Option<Outcome> {
    fsx::read_json(&Path::new(HOME).join(OUTCOME)).ok().flatten()
}

/// Root's side (`printbetter update-helper`, or `sudo printbetter update`): installs the newest
/// release if there is one, records the outcome, then restarts the service if it is running.
pub fn run() -> Outcome {
    let _ = fsx::remove_if_exists(Path::new(REQUEST));
    let home = Path::new(HOME);
    let installed = Target::detect().and_then(|target| {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
        runtime.block_on(install_latest(&Paths::resolve(), &target, &home.join("download")))
    });
    finish(installed, &home.join(OUTCOME), restart_service)
}

/// Fetches the release with the device's own credentials, then verifies and installs it.
pub async fn install_latest(paths: &Paths, target: &Target, download: &Path) -> Result<Option<String>, String> {
    let creds = store::load_credentials(paths).ok_or("This device is not paired.")?;
    let server = ServerUrl::parse(&creds.server)?;
    let Some(release) = super::check(&server, &creds.token, target).await? else { return Ok(None) };
    if super::plan(VERSION, &release.version, true, true, false)? == Plan::UpToDate {
        return Ok(None);
    }
    let _ = std::fs::remove_dir_all(download);
    let file = fetch::download(&server, &creds.token, &release, download).await?;
    let (target, version) = (target.clone(), release.version.clone());
    let installed = tokio::task::spawn_blocking(move || super::install(&target, &file, &version))
        .await
        .map_err(|e| format!("The installer stopped unexpectedly: {e}"))?;
    let _ = std::fs::remove_dir_all(download);
    installed.map(|()| Some(release.version))
}

/// Records the outcome where the daemon reads it, restarting the service after an install.
pub fn finish(installed: Result<Option<String>, String>, file: &Path, restart: impl FnOnce() -> Result<(), String>) -> Outcome {
    let mut outcome = match installed {
        Ok(Some(version)) => Outcome { at: now_ms(), ok: true, message: format!("Installed Print Better {version}."), installed: Some(version) },
        Ok(None) => Outcome { at: now_ms(), ok: true, installed: None, message: format!("Print Better {VERSION} is up to date.") },
        Err(e) => Outcome { at: now_ms(), ok: false, installed: None, message: e },
    };
    record(file, &outcome);
    if let Some(version) = outcome.installed.clone()
        && let Err(e) = restart()
    {
        outcome = Outcome { at: now_ms(), ok: false, message: format!("Installed {version}, but Print Better did not restart: {e}"), ..outcome };
        record(file, &outcome);
    }
    outcome
}

fn record(file: &Path, outcome: &Outcome) {
    if let Err(e) = fsx::write_json(file, outcome, false) {
        log::warn!("could not record the update outcome in {}: {e}", file.display());
    }
}

/// `lp` reaches CUPS and USB printers; `lpadmin` (CUPS admin on Debian and Ubuntu) lets the service
/// manage its `pb_` queues. A group this system lacks is skipped.
pub fn join_print_groups() {
    for group in ["lp", "lpadmin"] {
        let _ = std::process::Command::new("usermod").args(["-a", "-G", group, "printbetter"]).output();
    }
}

/// `try-restart` leaves a stopped service stopped. Installs from before `lpadmin` join it here.
fn restart_service() -> Result<(), String> {
    join_print_groups();
    let output = std::process::Command::new("systemctl")
        .args(["try-restart", "printbetter.service"])
        .output()
        .map_err(|e| format!("Can't run systemctl: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}
