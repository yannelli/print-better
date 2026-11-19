//! Printers this computer can reach right now without Print Better (seen on Bonjour). Their remote
//! copies are left out so the print dialog never lists a printer twice; away from that network
//! the copy comes back, so printing from anywhere keeps working.

use crate::proto::RemotePrinter;
use pb_print::{DiscoverOptions, Engine};
use std::collections::HashSet;
use std::time::{Duration, Instant};

const SCAN: Duration = Duration::from_secs(3);
const FRESH: Duration = Duration::from_secs(180);

#[derive(Default)]
pub struct Native {
    uuids: HashSet<String>,
    scanned: Option<Instant>,
}

impl Native {
    /// Rescans when stale or when `force`; skipped when no remote printer has a uuid to match.
    pub async fn refresh(&mut self, engine: &Engine, printers: &[RemotePrinter], force: bool) {
        if printers.iter().all(|p| p.uuid.is_none()) || (!force && self.scanned.is_some_and(|t| t.elapsed() < FRESH)) {
            return;
        }
        // Bonjour only: an installed queue lingers off-network. Nothing found here is reported.
        let opts = DiscoverOptions { mdns: true, os: false, snmp: false, usb: false, timeout: SCAN };
        self.uuids = engine.discover(&opts).await.into_iter().filter_map(|r| r.uuid).map(|u| u.to_ascii_lowercase()).collect();
        self.scanned = Some(Instant::now());
    }

    pub fn reaches(&self, printer: &RemotePrinter) -> bool {
        printer.uuid.as_deref().is_some_and(|u| self.uuids.contains(&u.to_ascii_lowercase()))
    }

    #[cfg(test)]
    pub fn with(uuids: &[&str]) -> Native {
        Native { uuids: uuids.iter().map(|u| u.to_string()).collect(), scanned: Some(Instant::now()) }
    }
}
