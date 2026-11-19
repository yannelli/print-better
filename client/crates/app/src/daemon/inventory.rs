//! Discovery (at start, every 10 min, on demand) and 60 s health polling of added printers.

use super::Daemon;
use crate::proto::ClientMsg;
use crate::{print_error, settings};
use pb_print::{PrinterReport, PrinterState, PrinterStatus};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::{Instant, sleep_until, timeout};

const DISCOVER_EVERY: Duration = Duration::from_secs(600);
const HEALTH_EVERY: Duration = Duration::from_secs(60);
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn run(d: Arc<Daemon>) {
    let mut next_discovery = Instant::now();
    let mut next_health = Instant::now() + HEALTH_EVERY;
    loop {
        tokio::select! {
            _ = sleep_until(next_discovery) => {}
            _ = d.wake.discover.notified() => {}
            _ = sleep_until(next_health) => {
                refresh(&d, None).await;
                next_health = Instant::now() + HEALTH_EVERY;
                continue;
            }
            _ = d.stopping.canceled() => return,
        }
        discover(&d, false, None).await;
        next_discovery = Instant::now() + DISCOVER_EVERY;
    }
}

/// Runs discovery with the enabled sources and sends `printers` when the inventory changed
/// (or always, with `force`). Returns how many printers are known.
pub async fn discover(d: &Daemon, force: bool, wait: Option<Duration>) -> usize {
    let _one_at_a_time = d.discovery_lock.lock().await;
    let found = d.engine.discover(&settings::discover_options(&d.settings(), wait)).await;
    let keep = d.added_keys();
    let (count, snapshot) = {
        let mut st = d.lock();
        let changed = st.inventory.merge(found, &keep);
        let snapshot = if changed || force { st.inventory.snapshot() } else { None };
        (st.inventory.printers.len(), snapshot)
    };
    log::info!("discovery found {count} printer(s)");
    if let Some(printers) = snapshot {
        d.outbox.send(ClientMsg::Printers { printers });
    }
    d.wake.share.notify_one();
    d.queue.wake();
    count
}

/// Polls the given printer (any known one), or every added printer, and pushes changes.
pub async fn refresh(d: &Daemon, key: Option<&str>) -> usize {
    let targets: Vec<PrinterReport> = match key {
        Some(key) => d.printer_report(key).into_iter().collect(),
        None => {
            let added = d.added_keys();
            d.with_state(|st| st.inventory.printers.values().filter(|p| added.contains(&p.key)).cloned().collect())
        }
    };
    let mut any_changed = false;
    for printer in &targets {
        let status = match timeout(STATUS_TIMEOUT, d.engine.status(printer)).await {
            Ok(Ok(status)) => status,
            Ok(Err(e)) => offline(print_error::sentence(&e)),
            Err(_) => offline("The printer did not answer.".into()),
        };
        if d.lock().inventory.set_status(&printer.key, &status) {
            any_changed = true;
            d.outbox.send(ClientMsg::PrinterStatus { key: printer.key.clone(), status });
        }
    }
    if any_changed {
        d.wake.share.notify_one();
    }
    targets.len()
}

fn offline(message: String) -> PrinterStatus {
    PrinterStatus { state: PrinterState::Offline, message: Some(message), ..PrinterStatus::default() }
}

/// Sent after every `welcome`: the hub's copy may predate changes made while offline.
pub fn snapshot_message(d: &Daemon) -> Option<ClientMsg> {
    d.with_state(|st| st.inventory.snapshot()).map(|printers| ClientMsg::Printers { printers })
}
