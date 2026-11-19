//! `printbetter service ...`: start Print Better automatically (docs/cli.md, Service install).
//! Every action is idempotent and never prompts, so install scripts can re-run it.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(unix)]
mod takeover;
mod templates;
#[cfg(test)]
mod tests;
#[cfg(windows)]
mod windows;

use crate::cli::{Failure, Outcome};
use crate::local::client;
use crate::paths::{CONFIG_FILE, CREDENTIALS_FILE};
use crate::{fsx, platform};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Printed (exit 0) by a per-user install on a machine the system service already serves.
pub const SYSTEM_ALREADY: &str =
    "Print Better already runs for everyone on this computer (machine-wide service), so there is nothing to install for your account.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Install,
    Uninstall,
    Start,
    Stop,
    Restart,
    Status,
}

pub fn run(action: Action, system: bool, no_tray: bool) -> Outcome {
    #[cfg(target_os = "macos")]
    return macos::run(action, system, no_tray);
    #[cfg(target_os = "linux")]
    return linux::run(action, system, no_tray);
    #[cfg(windows)]
    return windows::run(action, system, no_tray);
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = (action, system, no_tray);
        Err(Failure::error("Service install is not supported on this system."))
    }
}

/// Runs a helper program; on failure the error carries its output.
pub fn command(program: &str, args: &[&str]) -> Result<String, Failure> {
    let output = command_for(program)
        .args(args)
        .output()
        .map_err(|e| Failure::error(format!("Could not run {program}: {e}")))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let detail = String::from_utf8_lossy(if output.stderr.is_empty() { &output.stdout } else { &output.stderr }).trim().to_string();
    Err(Failure::error(format!("{program} {} failed: {detail}", args.join(" "))))
}

/// Standard output regardless of exit status (status queries exit non-zero for "inactive").
#[cfg(unix)]
pub fn output(program: &str, args: &[&str]) -> String {
    command_for(program)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

#[cfg(windows)]
fn command_for(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(windows))]
fn command_for(program: &str) -> Command {
    Command::new(program)
}

/// The binary the service should start, with symlinks resolved (e.g. ~/.local/bin -> the .app).
pub fn exe() -> Result<PathBuf, Failure> {
    let exe = platform::current_exe().map_err(|e| Failure::error(format!("Can't find the printbetter binary: {e}")))?;
    if cfg!(windows) {
        return Ok(exe);
    }
    exe.canonicalize().map_err(|e| Failure::error(format!("Can't resolve {}: {e}", exe.display())))
}

pub fn write(path: &Path, contents: &[u8]) -> Outcome {
    fsx::write_atomic(path, contents, false).map_err(|e| Failure::error(format!("Can't write {}: {e}", path.display())))
}

#[cfg(unix)]
pub fn remove(path: &Path) -> Outcome {
    fsx::remove_if_exists(path).map_err(|e| Failure::error(format!("Can't remove {}: {e}", path.display())))
}

#[cfg(unix)]
pub fn require_root(what: &str) -> Outcome {
    if platform::is_root() {
        Ok(())
    } else {
        Err(Failure::error(format!("{what} needs administrator rights. Run it again with sudo.")))
    }
}

/// Hands a user install's pairing to the system service unless that already has its own.
/// Returns whether anything was copied.
pub fn copy_pairing(from: &Path, to: &Path) -> Result<bool, Failure> {
    if from == to || to.join(CREDENTIALS_FILE).exists() || !from.join(CREDENTIALS_FILE).exists() {
        return Ok(false);
    }
    for (name, private) in [(CREDENTIALS_FILE, true), (CONFIG_FILE, false)] {
        if let Ok(data) = std::fs::read(from.join(name)) {
            fsx::write_atomic(&to.join(name), &data, private).map_err(|e| Failure::error(format!("Can't copy {name}: {e}")))?;
        }
    }
    Ok(true)
}

/// Asks whatever daemon answers on the local port to exit, and waits up to 10 s for it.
pub fn quit_daemon() {
    if client::post("/api/quit", &json!({})).is_err() {
        return;
    }
    for _ in 0..20 {
        if !client::is_running() {
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Status lines shared by every platform; "installed but stopped" exits like a stopped daemon.
pub fn report(kind: &str, running: Option<bool>, detail: &str) -> Outcome {
    match running {
        None => Err(Failure::error("Print Better is not installed as a service. Run: printbetter service install")),
        Some(true) => {
            println!("Installed ({kind}). Running{detail}.");
            Ok(())
        }
        Some(false) => Err(Failure {
            code: crate::cli::EXIT_NO_DAEMON,
            message: format!("Installed ({kind}). Not running. Start it with: printbetter service start"),
        }),
    }
}
