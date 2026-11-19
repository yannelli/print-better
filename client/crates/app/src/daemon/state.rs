use crate::clock::now_ms;
use crate::paths::Paths;
use crate::store::{self, Credentials, LocalConfig, SavedState};
use pb_print::{CancelFlag, PrinterReport, PrinterStatus};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Conn {
    Unpaired,
    Connecting,
    Online,
    Offline,
    /// The server rejected the token (401/4401); waits for the user to pair again.
    Revoked,
    /// Another process connected with the same token (4409); not fought over.
    Replaced,
}

/// Device-code pairing started from the status page.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    /// "waiting" | "failed"
    pub state: &'static str,
    pub server: String,
    pub user_code: Option<String>,
    pub verification_uri: Option<String>,
    pub verification_uri_complete: Option<String>,
    pub message: Option<String>,
    #[serde(skip)]
    pub id: i64,
    #[serde(skip)]
    pub cancel: CancelFlag,
}

pub struct State {
    pub creds: Option<Credentials>,
    pub config: LocalConfig,
    pub saved: SavedState,
    pub conn: Conn,
    pub conn_detail: Option<String>,
    /// Token the server rejected or another session took over; the session waits for a new one.
    pub halted_token: Option<String>,
    pub clock_offset_ms: Option<i64>,
    pub pairing: Option<Pairing>,
    pub inventory: Inventory,
    pub share_active: bool,
    pub share_error: Option<String>,
    pub remote: super::remote::Status,
    pub update: crate::update::Status,
    /// A release someone asked to install; the updater takes it.
    pub pending_update: Option<crate::update::Release>,
}

impl State {
    pub fn load(paths: &Paths) -> State {
        State {
            creds: store::load_credentials(paths),
            config: store::load_config(paths),
            saved: store::load_state(paths),
            conn: Conn::Connecting,
            conn_detail: None,
            halted_token: None,
            clock_offset_ms: None,
            pairing: None,
            inventory: Inventory::default(),
            share_active: false,
            share_error: None,
            remote: Default::default(),
            update: Default::default(),
            pending_update: None,
        }
    }
}

#[derive(Default)]
pub struct Inventory {
    pub printers: BTreeMap<String, PrinterReport>,
    pub discovered_at: Option<i64>,
    /// Last snapshot with statuses blanked: status-only changes travel as `printer_status`.
    identity: Option<Vec<PrinterReport>>,
}

impl Inventory {
    /// Replaces the inventory with a discovery result, keeping added printers that this
    /// round missed (mDNS is lossy). Returns whether the inventory itself changed.
    pub fn merge(&mut self, found: Vec<PrinterReport>, keep: &HashSet<String>) -> bool {
        let mut next: BTreeMap<String, PrinterReport> = found.into_iter().map(|p| (p.key.clone(), p)).collect();
        for (key, old) in &self.printers {
            if keep.contains(key) && !next.contains_key(key) {
                next.insert(key.clone(), old.clone());
            }
        }
        self.printers = next;
        self.discovered_at = Some(now_ms());
        let identity: Vec<PrinterReport> = self
            .printers
            .values()
            .map(|p| PrinterReport { status: PrinterStatus::default(), ..p.clone() })
            .collect();
        let changed = self.identity.as_ref() != Some(&identity);
        self.identity = Some(identity);
        changed
    }

    pub fn snapshot(&self) -> Option<Vec<PrinterReport>> {
        self.discovered_at.map(|_| self.printers.values().cloned().collect())
    }

    /// Stores a polled status; true when it differs from the last one.
    pub fn set_status(&mut self, key: &str, status: &PrinterStatus) -> bool {
        match self.printers.get_mut(key) {
            Some(report) if report.status != *status => {
                report.status = status.clone();
                true
            }
            _ => false,
        }
    }
}
