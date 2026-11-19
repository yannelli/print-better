//! Serde mirror of server/shared/protocol.ts (client <-> WorkspaceHub). Semantics: docs/protocol.md.

use pb_print::model::{Capabilities, JobOptions, PrinterReport, PrinterState, PrinterStatus, Supply};
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const PING: &str = "ping";
pub const PONG: &str = "pong";
pub const PING_INTERVAL_SECS: u64 = 25;
pub const PONG_TIMEOUT_SECS: u64 = 10;
pub const LOCAL_PORT: u16 = 47631;
pub const LAN_SHARE_PORT: u16 = 8631;
pub const REMOTE_PRINT_PORT: u16 = 8632;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscoveryToggles {
    pub mdns: bool,
    pub snmp: bool,
    pub usb: bool,
    pub os: bool,
}

impl Default for DiscoveryToggles {
    fn default() -> Self {
        Self { mdns: true, snmp: true, usb: true, os: true }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientSettings {
    pub tray: bool,
    pub lan_sharing: bool,
    /// "smart" | "all" | "none" | "inherit"
    pub auto_add: String,
    pub discovery: DiscoveryToggles,
    pub paused: bool,
    /// "info" | "debug"
    pub log_level: String,
    pub remote_printers: bool,
    pub auto_update: bool,
    /// Workspace printer ids not offered here even though `remote_printers` is on.
    pub remote_printers_hidden: Vec<String>,
    /// Workspace printer to make this computer's default; None leaves the default alone.
    pub default_printer: Option<String>,
}

impl Default for ClientSettings {
    fn default() -> Self {
        Self {
            tray: true,
            lan_sharing: false,
            auto_add: "inherit".into(),
            discovery: DiscoveryToggles::default(),
            paused: false,
            log_level: "info".into(),
            remote_printers: true,
            auto_update: true,
            remote_printers_hidden: Vec::new(),
            default_printer: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterConfig {
    pub key: String,
    pub id: String,
    pub name: String,
    pub added: bool,
    pub lan_share: bool,
    #[serde(default)]
    pub defaults: JobOptions,
}

/// An added printer on another device in the workspace, served here as a local queue.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemotePrinter {
    pub id: String,
    pub name: String,
    pub location: Option<String>,
    pub make_model: Option<String>,
    #[serde(default)]
    pub uuid: Option<String>,
    pub client_name: String,
    pub online: bool,
    pub state: PrinterState,
    pub capabilities: Capabilities,
    #[serde(default)]
    pub defaults: JobOptions,
    #[serde(default)]
    pub supplies: Vec<Supply>,
}

/// An added printer on another device (also in the snapshot) that this one finds itself.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DirectPrinter {
    pub id: String,
    pub uuid: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SystemPrinterState {
    Added,
    Hidden,
    Waiting,
    Error,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SystemPrinter {
    pub id: String,
    pub state: SystemPrinterState,
    pub queue: Option<String>,
    /// A queue for the same printer set up here without Print Better.
    pub installed: Option<String>,
    pub direct: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DefaultPrinterProblem {
    Hidden,
    Waiting,
    Unavailable,
    Failed,
}

/// Remote printers and the default printer as this computer's print system has them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemPrinters {
    pub active: bool,
    pub error: Option<String>,
    pub printers: Vec<SystemPrinter>,
    pub default_queue: Option<String>,
    pub default_printer_id: Option<String>,
    pub default_problem: Option<DefaultPrinterProblem>,
    /// macOS "Default printer: Last Printer Used" is on for the signed-in user.
    pub last_used: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobOffer {
    pub id: String,
    pub printer_key: String,
    pub title: String,
    pub content_type: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub options: JobOptions,
    pub file_url: String,
    pub attempt: u32,
    pub created_at: i64,
}

/// Job states the client may report (never "uploading" or "queued").
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Dispatched,
    Printing,
    Completed,
    Failed,
    Canceled,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ClientMsg {
    Hello {
        protocol: u32,
        version: String,
        os: String,
        arch: String,
        hostname: String,
        features: Vec<String>,
        settings: ClientSettings,
        settings_updated_at: i64,
    },
    Printers {
        printers: Vec<PrinterReport>,
    },
    PrinterStatus {
        key: String,
        status: PrinterStatus,
    },
    JobStatus {
        job_id: String,
        status: JobStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pages: Option<u32>,
        /// The `JobOffer.attempt` this report belongs to, so the hub drops superseded ones.
        #[serde(skip_serializing_if = "Option::is_none")]
        attempt: Option<u32>,
    },
    LanJob {
        local_id: String,
        printer_key: String,
        title: String,
        user: Option<String>,
        content_type: String,
        size: u64,
        /// Full JobStatus vocabulary including "queued".
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Result {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Settings {
        settings: ClientSettings,
        updated_at: i64,
    },
    SystemPrinters {
        report: SystemPrinters,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ServerMsg {
    Welcome {
        client_id: String,
        workspace_id: String,
        name: String,
        settings: ClientSettings,
        settings_updated_at: i64,
        server_time: i64,
        printers: Vec<PrinterConfig>,
    },
    Job {
        job: JobOffer,
    },
    Cancel {
        job_id: String,
    },
    Settings {
        settings: ClientSettings,
        updated_at: i64,
    },
    PrinterConfig {
        printers: Vec<PrinterConfig>,
    },
    RemotePrinters {
        printers: Vec<RemotePrinter>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        direct: Vec<DirectPrinter>,
    },
    Command {
        id: String,
        /// discover | refresh | identify | logs | diagnose | restart | update | unpair
        name: String,
        #[serde(default)]
        args: serde_json::Value,
    },
    /// Forward compatibility: newer servers may send types this client does not know.
    #[serde(other)]
    Unknown,
}

#[cfg(test)]
mod tests;
