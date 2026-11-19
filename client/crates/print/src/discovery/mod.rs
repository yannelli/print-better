//! Printer discovery: mDNS/DNS-SD, SNMP, CUPS queues, plus USB and Windows queues
//! via `crate::backends`. Owned by the protocols implementer; signatures are frozen.

mod cups;
mod enrich;
mod found;
pub(crate) mod mdns;
mod merge;
mod snmp;
#[cfg(test)]
mod tests;

use crate::ipp::IppClient;
use crate::model::{PrinterReport, PrinterStatus};
use found::Found;
use std::future::Future;
use std::time::Duration;

/// Slack on top of the browse window for sources that finish their own queries after it.
const GRACE: Duration = Duration::from_secs(3);

#[derive(Clone, Debug)]
pub struct DiscoverOptions {
    pub mdns: bool,
    pub snmp: bool,
    pub usb: bool,
    pub os: bool,
    pub timeout: Duration,
}

impl Default for DiscoverOptions {
    fn default() -> Self {
        Self { mdns: true, snmp: true, usb: true, os: true, timeout: Duration::from_secs(4) }
    }
}

/// Runs enabled sources concurrently, queries capabilities, merges duplicates
/// (same uuid or host) into one report with ordered routes, and sorts by name.
pub async fn run(ipp: &IppClient, opts: &DiscoverOptions) -> Vec<PrinterReport> {
    let limit = opts.timeout + GRACE;
    let (mdns, cups, usb, windows, snmp) = tokio::join!(
        source("mDNS", opts.mdns, limit, mdns::browse(opts.timeout)),
        source("CUPS", opts.os, limit, cups::queues(ipp)),
        source("USB", opts.usb, limit, usb()),
        source("Windows spooler", opts.os, limit, windows()),
        source("SNMP", opts.snmp, limit, snmp::discover(opts.timeout)),
    );
    let mut printers = merge::group([mdns, cups, usb, windows, snmp].concat());
    enrich::printers(ipp, &mut printers).await;
    merge::reports(merge::group(printers))
}

/// Printer MIB status for printers reachable only by socket/LPD.
pub async fn snmp_status(host: &str) -> Option<PrinterStatus> {
    snmp::status(host).await
}

async fn source(name: &str, enabled: bool, limit: Duration, work: impl Future<Output = Vec<Found>>) -> Vec<Found> {
    if !enabled {
        return Vec::new();
    }
    match tokio::time::timeout(limit, work).await {
        Ok(found) => {
            log::debug!("discovery: {name} saw {} printer(s)", found.len());
            found
        }
        Err(_) => {
            log::warn!("discovery: {name} gave no answer within {}s", limit.as_secs());
            Vec::new()
        }
    }
}

/// Spawned so a panic in the enumerator costs only its results.
async fn usb() -> Vec<Found> {
    match tokio::spawn(crate::backends::usb::enumerate()).await {
        Ok(reports) => reports.into_iter().map(|r| Found::from_report(r, 2)).collect(),
        Err(e) => {
            log::warn!("USB printer enumeration failed: {e}");
            Vec::new()
        }
    }
}

#[cfg(windows)]
async fn windows() -> Vec<Found> {
    match tokio::task::spawn_blocking(crate::backends::windows::enumerate).await {
        Ok(reports) => reports.into_iter().map(|r| Found::from_report(r, 5)).collect(),
        Err(e) => {
            log::warn!("Windows printer enumeration failed: {e}");
            Vec::new()
        }
    }
}

#[cfg(not(windows))]
async fn windows() -> Vec<Found> {
    Vec::new()
}
