//! The updater subsystem: asks the paired server for a newer release shortly after start, every
//! 6 hours, and on request; installs it (`crate::update`) and restarts into the new version.

use super::{Daemon, State};
use crate::VERSION;
use crate::clock::now_ms;
use crate::net::ServerUrl;
use crate::update::{self, Plan, Release, Target, Version, helper};
use serde_json::{Value, json};
use std::hash::BuildHasher;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::{Instant, sleep, sleep_until};

#[cfg(test)]
mod tests;

const FIRST_CHECK: Duration = Duration::from_secs(120);
const EVERY: Duration = Duration::from_secs(6 * 3600);
/// Automatic installs restart Print Better, so they give running jobs this long to finish.
const IDLE_WAIT: Duration = Duration::from_secs(30 * 60);
const HELPER_WAIT: Duration = Duration::from_secs(15 * 60);

/// Who swaps the files: this process, or the root helper of the machine-wide Linux service.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Route {
    Here,
    Helper,
}

pub async fn run(d: Arc<Daemon>) {
    // Whatever is here was left by an update that never finished.
    let _ = std::fs::remove_dir_all(d.paths.updates());
    let target = Target::detect();
    if let Err(why) = &target {
        d.update_status(|s| s.error = Some(why.clone()));
    }
    let mut next = Instant::now() + FIRST_CHECK;
    loop {
        tokio::select! {
            _ = sleep_until(next) => {
                next = Instant::now() + jittered(EVERY);
                if let Ok(target) = &target {
                    automatic(&d, target).await;
                }
            }
            _ = d.wake.update.notified() => {
                let requested = d.lock().pending_update.take();
                if let (Some(release), Ok(target)) = (requested, &target) {
                    install(&d, target, release, true).await;
                }
            }
            _ = d.stopping.canceled() => return,
        }
    }
}

async fn automatic(d: &Arc<Daemon>, target: &Target) {
    let Ok(Some(release)) = check(d, target).await else { return };
    match update::plan(VERSION, &release.version, false, d.settings().auto_update, target.is_dev_build()) {
        Ok(Plan::Install) => install(d, target, release, false).await,
        Ok(Plan::Hold(why)) => log::info!("Print Better {} is available; not installing it: {why}", release.version),
        Ok(Plan::UpToDate) | Err(_) => {}
    }
}

/// Server `update` command, `printbetter update`, and the tray: check now, then install in the
/// background when there is something newer. Returns `(from, to)`.
pub async fn request(d: &Daemon) -> Result<(String, String), String> {
    request_for(d, &Target::detect()?).await
}

async fn request_for(d: &Daemon, target: &Target) -> Result<(String, String), String> {
    route(d, target)?;
    if let Some(phase) = d.with_state(|st| st.update.phase) {
        return Err(format!("An update is already {phase}."));
    }
    let release = check(d, target).await?.ok_or("No Print Better release is published for this computer yet.")?;
    if update::plan(VERSION, &release.version, true, true, false)? == Plan::UpToDate {
        return Err(format!("Print Better {VERSION} is up to date."));
    }
    let to = release.version.clone();
    d.lock().pending_update = Some(release);
    d.wake.update.notify_one();
    Ok((VERSION.to_string(), to))
}

/// Whether a newer release could be installed now (the local API answers 409 when not).
pub fn can_install(d: &Daemon) -> Result<(), String> {
    route(d, &Target::detect()?).map(drop)
}

fn route(d: &Daemon, target: &Target) -> Result<Route, String> {
    match update::installable(target) {
        Ok(()) => Ok(Route::Here),
        Err(_) if helper::available(&d.paths) => Ok(Route::Helper),
        Err(_) if cfg!(target_os = "linux") && crate::platform::is_system() => {
            Err("Updates need the system updater, which this install lacks. Run: sudo printbetter service install --system".into())
        }
        Err(e) => Err(e),
    }
}

/// A fresh check for `printbetter update --check`; returns the status view.
pub async fn check_now(d: &Daemon) -> Result<Value, String> {
    check(d, &Target::detect()?).await?;
    Ok(d.with_state(status))
}

/// The `update` part of `/api/status`.
pub fn status(st: &State) -> Value {
    let s = &st.update;
    json!({
        "current": VERSION,
        "latest": s.latest,
        "available": s.available,
        "checkedAt": s.checked_at,
        "error": s.error,
        "autoUpdate": st.config.settings.auto_update,
        "phase": s.phase,
    })
}

async fn check(d: &Daemon, target: &Target) -> Result<Option<Release>, String> {
    let creds = d.credentials().ok_or("This device is not paired.")?;
    let server = ServerUrl::parse(&creds.server)?;
    let result = update::check(&server, &creds.token, target).await;
    d.update_status(|s| {
        s.checked_at = Some(now_ms());
        match &result {
            Ok(found) => {
                s.latest = found.as_ref().map(|r| r.version.clone());
                s.available = found.as_ref().is_some_and(|r| newer(&r.version));
                s.error = None;
            }
            Err(e) => s.error = Some(e.clone()),
        }
    });
    if let Err(e) = &result {
        log::warn!("{e}");
    }
    result
}

async fn install(d: &Daemon, target: &Target, release: Release, manual: bool) {
    if !manual && !wait_for_idle(d).await {
        return;
    }
    log::info!("updating Print Better {VERSION} to {}", release.version);
    let result = match route(d, target) {
        Ok(Route::Here) => download_and_install(d, target, &release).await.map(|()| true),
        Ok(Route::Helper) => via_helper(d).await,
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_dir_all(d.paths.updates());
    match result {
        Ok(restart_here) => {
            d.update_status(|s| s.phase = None);
            // A pkg's postinstall, or the root helper, restarts the service; that stops this process.
            if restart_here && !d.stopping.is_canceled() {
                log::info!("installed Print Better {}", release.version);
                d.stop(true, &format!("updated to {}", release.version));
            }
        }
        Err(e) => {
            log::warn!("could not update to {}: {e}", release.version);
            d.update_status(|s| {
                s.phase = None;
                s.error = Some(e);
            });
        }
    }
}

async fn download_and_install(d: &Daemon, target: &Target, release: &Release) -> Result<(), String> {
    let creds = d.credentials().ok_or("This device is not paired.")?;
    let server = ServerUrl::parse(&creds.server)?;
    d.update_status(|s| {
        s.phase = Some("downloading");
        s.error = None;
    });
    let file = update::fetch::download(&server, &creds.token, release, &d.paths.updates()).await?;
    d.update_status(|s| s.phase = Some("installing"));
    let (target, version) = (target.clone(), release.version.clone());
    tokio::task::spawn_blocking(move || update::install(&target, &file, &version))
        .await
        .map_err(|e| format!("The installer stopped unexpectedly: {e}"))?
}

/// Asks the root helper and waits for its outcome; returns false since it restarts the service.
async fn via_helper(d: &Daemon) -> Result<bool, String> {
    let asked = helper::request(&d.paths).map_err(|e| format!("Couldn't ask the system updater: {e}"))?;
    d.update_status(|s| {
        s.phase = Some("installing");
        s.error = None;
    });
    let deadline = Instant::now() + HELPER_WAIT;
    while Instant::now() < deadline {
        tokio::select! {
            _ = sleep(Duration::from_secs(2)) => {}
            _ = d.stopping.canceled() => return Ok(false),
        }
        if let Some(outcome) = helper::last_outcome().filter(|o| o.at >= asked) {
            log::info!("system updater: {}", outcome.message);
            return if outcome.ok { Ok(false) } else { Err(outcome.message) };
        }
    }
    Err("The system updater did not answer. Run: sudo printbetter service install --system".into())
}

async fn wait_for_idle(d: &Daemon) -> bool {
    let deadline = Instant::now() + IDLE_WAIT;
    while d.queue.is_busy() && Instant::now() < deadline {
        tokio::select! {
            _ = sleep(Duration::from_secs(10)) => {}
            _ = d.stopping.canceled() => return false,
        }
    }
    !d.stopping.is_canceled()
}

fn newer(version: &str) -> bool {
    matches!((Version::parse(version), Version::parse(VERSION)), (Some(latest), Some(current)) if latest > current)
}

/// Within 30 minutes either side of `base`, so a fleet of devices doesn't ask all at once.
fn jittered(base: Duration) -> Duration {
    let spread = base.as_secs() / 6;
    let offset = std::collections::hash_map::RandomState::new().hash_one(now_ms()) % (spread + 1);
    base - Duration::from_secs(spread / 2) + Duration::from_secs(offset)
}

impl Daemon {
    fn update_status(&self, change: impl FnOnce(&mut update::Status)) {
        change(&mut self.lock().update);
    }
}
