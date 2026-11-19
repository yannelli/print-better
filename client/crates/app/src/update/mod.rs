//! Self-update: find the newest release for this kind of install, download it from the paired
//! server, verify it, and swap it in. Shared by the daemon's updater and `printbetter update`.

pub mod fetch;
pub mod helper;
#[cfg(any(all(test, unix), target_os = "linux"))]
mod linux;
#[cfg(any(test, target_os = "macos"))]
mod macos;
#[cfg(test)]
mod tests;
mod version;

pub use version::Version;

use crate::net::{NetError, ServerUrl, http};
use crate::platform;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// `GET /api/client/latest` (docs/protocol.md).
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Release {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

/// What the status page, tray, CLI, and doctor show.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub latest: Option<String>,
    pub available: bool,
    pub checked_at: Option<i64>,
    pub error: Option<String>,
    /// "downloading" or "installing" while an update is underway.
    pub phase: Option<&'static str>,
}

/// How this copy of Print Better was installed, which decides the artifact and the swap.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    /// Linux: the tarball's `printbetter` replaces this file.
    Binary(PathBuf),
    /// macOS machine-wide install (root LaunchDaemon): the signed pkg, run through `installer`.
    Pkg(PathBuf),
    /// macOS per-user install: this app bundle is swapped for the one in the zip.
    App(PathBuf),
}

impl Target {
    pub fn detect() -> Result<Target, String> {
        let exe = platform::current_exe().and_then(|exe| exe.canonicalize()).map_err(|e| format!("Can't find the running program: {e}"))?;
        Target::for_exe(&exe, platform::os(), platform::is_root())
    }

    pub fn for_exe(exe: &Path, os: &str, root: bool) -> Result<Target, String> {
        let app = exe.ancestors().nth(3).filter(|app| app.extension().is_some_and(|ext| ext == "app"));
        match (os, app) {
            ("linux", _) => Ok(Target::Binary(exe.to_path_buf())),
            ("macos", Some(app)) if root && app.parent() == Some(Path::new("/Applications")) => Ok(Target::Pkg(app.into())),
            ("macos", Some(_)) if root => Err("This Print Better is installed for one user. Run printbetter update without sudo.".into()),
            ("macos", Some(app)) => Ok(Target::App(app.into())),
            ("macos", None) => Err("This copy of Print Better is not inside Print Better.app, so it can't update itself.".into()),
            _ => Err("Automatic updates are not available on Windows yet. Run the install command again to update.".into()),
        }
    }

    /// The `/api/client/latest` query for this install.
    pub fn latest_path(&self) -> String {
        let kind = match self {
            Target::Binary(_) => "",
            Target::Pkg(_) => "&kind=pkg",
            Target::App(_) => "&kind=app",
        };
        format!("/api/client/latest?os={}&arch={}{kind}", platform::os(), arch())
    }

    /// Cargo build output is a development copy: it updates only when asked to.
    pub fn is_dev_build(&self) -> bool {
        let path = match self {
            Target::Binary(path) | Target::Pkg(path) | Target::App(path) => path,
        };
        cfg!(debug_assertions) || path.components().any(|c| c.as_os_str() == "target")
    }
}

/// The CPU flavor of this build: Rust reports "arm" for both 32-bit Pi builds.
fn arch() -> &'static str {
    match platform::arch() {
        "arm" if armv6_cpu() => "armv6",
        "arm" => "armv7",
        other => other,
    }
}

/// Same test as install.sh: ARMv6 boards (Pi Zero, Pi 1) run the armhf userland.
fn armv6_cpu() -> bool {
    let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default().to_ascii_lowercase();
    let part = cpuinfo.lines().any(|l| l.starts_with("cpu part") && l.trim_end().ends_with("0xb76"));
    cpuinfo.contains("armv6") || cpuinfo.contains("arm1176") || part
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    Install,
    UpToDate,
    /// A newer release exists, but this copy only installs it when asked.
    Hold(&'static str),
}

/// Never downgrades; automatic installs need `autoUpdate` and an installed (non-dev) copy.
pub fn plan(current: &str, latest: &str, manual: bool, auto_update: bool, dev_build: bool) -> Result<Plan, String> {
    let latest_v = Version::parse(latest).ok_or_else(|| format!("The server offered an invalid version \"{latest}\"."))?;
    let current_v = Version::parse(current).ok_or_else(|| format!("This build has an invalid version \"{current}\"."))?;
    Ok(if latest_v <= current_v {
        Plan::UpToDate
    } else if manual {
        Plan::Install
    } else if !auto_update {
        Plan::Hold("automatic updates are turned off")
    } else if dev_build {
        Plan::Hold("this is a development build")
    } else {
        Plan::Install
    })
}

/// The newest release for `target`; `None` when the server has nothing published for it.
pub async fn check(server: &ServerUrl, token: &str, target: &Target) -> Result<Option<Release>, String> {
    match http::get_json::<Release>(server, &target.latest_path(), Some(token)).await {
        Ok(release) => Ok(Some(release)),
        Err(NetError::Api { status: 404, .. }) => Ok(None),
        Err(e) => Err(format!("Couldn't check for updates: {e}")),
    }
}

/// Fails before any download when this process can't replace its own files.
pub fn installable(target: &Target) -> Result<(), String> {
    match target {
        Target::Binary(exe) => writable(exe).map_err(|e| format!("Can't replace {} ({e}). Run: sudo printbetter update", exe.display())),
        Target::App(app) => writable(app).map_err(|e| format!("Can't replace {} ({e}).", app.display())),
        Target::Pkg(_) => Ok(()),
    }
}

/// Whether this process may create and rename files next to `path`.
#[cfg(unix)]
fn writable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let dir = path.parent().unwrap_or(Path::new("/"));
    let dir = std::ffi::CString::new(dir.as_os_str().as_bytes()).map_err(std::io::Error::other)?;
    // SAFETY: `dir` is a valid NUL-terminated path for the duration of the call.
    if unsafe { libc::access(dir.as_ptr(), libc::W_OK) } == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

#[cfg(not(unix))]
fn writable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Catches a binary built for another CPU, or a truncated one, before it replaces anything.
#[cfg(unix)]
fn reports(binary: &Path, version: &str) -> Result<(), String> {
    let mut busy_retries = 5;
    let output = loop {
        match std::process::Command::new(binary).arg("version").output() {
            // A fork in another thread can hold the just-written file open for a moment.
            Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) && busy_retries > 0 => {
                busy_retries -= 1;
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            other => break other.map_err(|e| format!("The new version does not start: {e}"))?,
        }
    };
    let said = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && said == format!("printbetter {version}") {
        return Ok(());
    }
    Err(format!("The new version did not start correctly (it said \"{said}\")."))
}

/// Installs a downloaded, checksum-verified artifact. Blocking: run it off the async threads.
pub fn install(target: &Target, file: &Path, version: &str) -> Result<(), String> {
    match target {
        #[cfg(target_os = "linux")]
        Target::Binary(exe) => linux::install(file, exe, version),
        #[cfg(target_os = "macos")]
        Target::Pkg(app) => macos::install_pkg(file, app),
        #[cfg(target_os = "macos")]
        Target::App(app) => macos::install_app(file, app, version),
        _ => {
            let _ = (file, version);
            Err("This kind of install can't update itself.".into())
        }
    }
}
