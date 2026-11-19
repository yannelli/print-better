//! `printbetter update [--check] [--yes]`: through the daemon when it runs, else in this process.
//! Root on Linux installs through the same routine as the system service's root helper.

use super::{Failure, Outcome, block_on, confirm};
use crate::local::client::{self, LocalError};
use crate::net::ServerUrl;
use crate::paths::Paths;
use crate::update::{self, Plan, Release, Target, helper};
use crate::{VERSION, platform, store};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const RESTART_WAIT: Duration = Duration::from_secs(180);
const NO_TTY: &str = "Add --yes to update without being asked.";

pub fn update(check_only: bool, yes: bool) -> Outcome {
    let status = match client::post("/api/update", &json!({ "install": false })) {
        Ok(status) => status,
        Err(LocalError::NotRunning) => return standalone(check_only, yes),
        Err(e) => return Err(e.into()),
    };
    let current = status["current"].as_str().unwrap_or(VERSION);
    let Some(latest) = status["latest"].as_str().filter(|_| status["available"] == true) else {
        println!("Print Better {current} is up to date.");
        return Ok(());
    };
    println!("Print Better {latest} is available (this device has {current}).");
    if check_only || !agreed(latest, yes)? {
        return Ok(());
    }
    match client::post("/api/update", &json!({ "install": true })) {
        Ok(_) => wait_for(latest),
        Err(LocalError::Api { status: 409, .. }) if as_root_helper() => run_helper(),
        Err(e) => Err(e.into()),
    }
}

/// No daemon running: check and install with this process's own pairing and rights.
fn standalone(check_only: bool, yes: bool) -> Outcome {
    let (target, server, token) = paired()?;
    let release = block_on(update::check(&server, &token, &target))?.map_err(Failure::error)?;
    let Some(release) = release.filter(|r| update::plan(VERSION, &r.version, true, true, false) == Ok(Plan::Install)) else {
        println!("Print Better {VERSION} is up to date.");
        return Ok(());
    };
    println!("Print Better {} is available (this is {VERSION}).", release.version);
    if check_only || !agreed(&release.version, yes)? {
        return Ok(());
    }
    if as_root_helper() {
        return run_helper();
    }
    install_here(&target, &server, &token, &release)
}

/// `update-helper`: what printbetter-update.service runs when the daemon asks.
pub fn helper() -> Outcome {
    if !as_root_helper() {
        return Err(Failure::usage("update-helper is run as root by printbetter-update.service on Linux."));
    }
    run_helper()
}

/// Root on Linux downloads into its own folder, never one the service user can write.
fn as_root_helper() -> bool {
    cfg!(target_os = "linux") && platform::is_root()
}

fn run_helper() -> Outcome {
    let outcome = helper::run();
    if outcome.ok {
        println!("{}", outcome.message);
        Ok(())
    } else {
        Err(Failure::error(outcome.message))
    }
}

fn install_here(target: &Target, server: &ServerUrl, token: &str, release: &Release) -> Outcome {
    update::installable(target).map_err(Failure::error)?;
    let dir = Paths::resolve().updates();
    println!("Downloading Print Better {}...", release.version);
    let file = block_on(update::fetch::download(server, token, release, &dir))?.map_err(Failure::error)?;
    let installed = update::install(target, &file, &release.version);
    let _ = std::fs::remove_dir_all(&dir);
    installed.map_err(Failure::error)?;
    println!("Installed Print Better {}.", release.version);
    Ok(())
}

fn paired() -> Result<(Target, ServerUrl, String), Failure> {
    let creds = store::load_credentials(&Paths::resolve()).ok_or_else(Failure::not_paired)?;
    let server = ServerUrl::parse(&creds.server).map_err(Failure::error)?;
    Ok((Target::detect().map_err(Failure::error)?, server, creds.token))
}

fn agreed(version: &str, yes: bool) -> Result<bool, Failure> {
    if yes || confirm(&format!("Install {version} now? Print Better restarts when it is done. [y/N] "), NO_TTY)? {
        return Ok(true);
    }
    Err(Failure::error("Nothing changed."))
}

/// Follows the daemon through its restart until it reports the new version.
fn wait_for(version: &str) -> Outcome {
    println!("Installing Print Better {version}. It restarts when it is done...");
    let started = Instant::now();
    while started.elapsed() < RESTART_WAIT {
        std::thread::sleep(Duration::from_secs(1));
        let Ok(status) = client::get("/api/status") else { continue };
        if status["version"] == version {
            println!("Print Better {version} is running.");
            return Ok(());
        }
        if let Some(error) = failed(&status["update"]) {
            return Err(Failure::error(format!("The update did not install: {error}")));
        }
    }
    Err(Failure::error("The update is taking longer than expected. Check later with: printbetter status"))
}

fn failed(update: &Value) -> Option<&str> {
    update["error"].as_str().filter(|_| update["phase"].is_null())
}
