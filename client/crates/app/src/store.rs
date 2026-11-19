//! Persisted files: credentials (0600), local settings, and server-provided state.

use crate::fsx;
use crate::paths::Paths;
use crate::proto::{ClientSettings, DirectPrinter, PrinterConfig, RemotePrinter};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    /// Normalized server origin, e.g. `https://print.example.com`.
    pub server: String,
    pub client_id: String,
    pub workspace_id: String,
    pub name: String,
    pub token: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalConfig {
    pub settings: ClientSettings,
    pub settings_updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SavedState {
    /// Device name as last told by the server (it can be renamed in the web UI).
    pub name: Option<String>,
    pub printers: Vec<PrinterConfig>,
    /// Latest `remote_printers` snapshot; None until a server sends one.
    pub remote_printers: Option<Vec<RemotePrinter>>,
    /// The snapshot's `direct` list: printers this device reports itself.
    pub remote_direct: Vec<DirectPrinter>,
    /// The default printer this daemon last set.
    pub default_printer: Option<AppliedDefault>,
}

/// `seen` is what `lpstat -d` said right after; a different default later means someone changed it here.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppliedDefault {
    pub printer_id: String,
    pub queue: String,
    pub seen: Option<String>,
}

pub fn load_credentials(paths: &Paths) -> Option<Credentials> {
    load(&paths.credentials())
}

pub fn save_credentials(paths: &Paths, creds: &Credentials) -> io::Result<()> {
    fsx::write_json(&paths.credentials(), creds, true)
}

pub fn delete_credentials(paths: &Paths) -> io::Result<()> {
    fsx::remove_if_exists(&paths.credentials())
}

pub fn load_config(paths: &Paths) -> LocalConfig {
    load(&paths.config_file()).unwrap_or_default()
}

pub fn save_config(paths: &Paths, config: &LocalConfig) -> io::Result<()> {
    fsx::write_json(&paths.config_file(), config, false)
}

pub fn load_state(paths: &Paths) -> SavedState {
    load(&paths.state_file()).unwrap_or_default()
}

pub fn save_state(paths: &Paths, state: &SavedState) -> io::Result<()> {
    fsx::write_json(&paths.state_file(), state, false)
}

fn load<T: DeserializeOwned>(path: &Path) -> Option<T> {
    fsx::read_json(path).unwrap_or_else(|e| {
        log::warn!("ignoring unreadable {}: {e}", path.display());
        None
    })
}
