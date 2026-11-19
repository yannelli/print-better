//! A system install supersedes per-user installs, so two copies never fight over the local
//! port or the same device token: the caller unloads them, then `finish` removes them.

use super::{copy_pairing, quit_daemon, remove};
use crate::cli::Outcome;
use crate::paths::{Paths, USER_CONFIG_DIR};
use std::path::PathBuf;

pub struct UserInstall {
    /// The LaunchAgent plist or systemd user unit; its owner is the account that installed it.
    pub file: PathBuf,
    config: PathBuf,
}

/// Every home folder under `homes` holding `file` (relative to the home).
pub fn find(homes: &str, file: &str) -> Vec<UserInstall> {
    let Ok(entries) = std::fs::read_dir(homes) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|entry| {
            let home = entry.path();
            let file = home.join(file);
            file.exists().then(|| UserInstall { file, config: home.join(USER_CONFIG_DIR) })
        })
        .collect()
}

/// Deletes the (already unloaded) installs, stops a daemon still answering, and keeps the first pairing.
pub fn finish(installs: &[UserInstall]) -> Outcome {
    if installs.is_empty() {
        return Ok(());
    }
    for install in installs {
        remove(&install.file)?;
        println!("Removed the per-user install at {}.", install.file.display());
    }
    quit_daemon();
    let system = Paths::resolve().config;
    for install in installs {
        if copy_pairing(&install.config, &system)? {
            println!("Kept its pairing: this computer stays connected to the same Print Better server.");
            break;
        }
    }
    Ok(())
}
