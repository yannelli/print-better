//! Remote printers (docs/remote-printers.md): printers on other devices in the workspace,
//! offered here as system print queues that point at a loopback IPP server.

mod api;
mod cups;
mod default;
mod native;
mod report;
mod sink;
mod system;
#[cfg(test)]
mod tests;

use super::Daemon;
use crate::proto::{ClientMsg, ClientSettings, REMOTE_PRINT_PORT, RemotePrinter, SystemPrinters};
use cups::{Cups, Op, Queue};
use pb_print::share::{ShareOptions, ShareServer, SharedPrinter};
use pb_print::{PrinterReport, PrinterState, PrinterStatus};
use sink::RemoteSink;
use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::time::sleep;

const RECHECK: Duration = Duration::from_secs(60);
const RETRY: Duration = Duration::from_secs(300);
/// What the server accepts for jobs (`DOC_TYPES` minus text, which no print dialog sends).
const FORMATS: &[&str] = &["application/pdf", "image/jpeg", "image/png"];
const HOST_LABEL: &str = "Print Better remote printers";
pub const SUPPORTED: bool = cfg!(not(windows));

/// What the status page, tray, and doctor show.
#[derive(Default)]
pub struct Status {
    pub active: bool,
    pub error: Option<String>,
    /// Printer id to the system queue this daemon created for it.
    pub queues: BTreeMap<String, String>,
    /// What the server was told last (`system_printers`).
    pub report: Option<SystemPrinters>,
}

/// The loopback port; `PRINTBETTER_REMOTE_PORT` moves it so a development daemon can run beside an installed one.
pub fn port() -> u16 {
    static PORT: OnceLock<u16> = OnceLock::new();
    *PORT.get_or_init(|| std::env::var("PRINTBETTER_REMOTE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(REMOTE_PRINT_PORT))
}

pub async fn run(d: Arc<Daemon>) {
    match cups::system(d.paths.remote_spool()) {
        Some(cups) => serve(d, Arc::new(cups), port()).await,
        None => unavailable(d).await,
    }
}

/// Headless Linux (servers, Raspberry Pi) usually has no CUPS; that is expected, not a fault.
pub const NO_CUPS: &str = "Not used here: this computer has no CUPS print system";

async fn unavailable(d: Arc<Daemon>) {
    let why = if SUPPORTED { NO_CUPS } else { "Not available on Windows yet" };
    loop {
        let wanted = d.credentials().is_some() && d.settings().remote_printers;
        let error = wanted.then(|| why.to_string());
        let report = SystemPrinters { error: error.clone(), ..SystemPrinters::default() };
        d.set_remote_status(Status { error, report: Some(report), ..Status::default() });
        tokio::select! {
            _ = d.wake.remote.notified() => {}
            _ = d.stopping.canceled() => return,
        }
    }
}

async fn serve(d: Arc<Daemon>, cups: Arc<dyn Cups>, port: u16) {
    // Jobs do not survive a restart, so neither do their spooled documents.
    let _ = std::fs::remove_dir_all(d.paths.remote_spool());
    let sink = RemoteSink::new(d.clone());
    let mut managed = cups::load(&d.paths);
    let mut server: Option<ShareServer> = None;
    let mut served: Option<Vec<RemotePrinter>> = None;
    let mut native = native::Native::default();
    loop {
        let settings = d.settings();
        let wanted = d.credentials().is_some() && settings.remote_printers;
        let snapshot = d.with_state(|st| st.saved.remote_printers.clone());
        let (mut error, mut lpadmin_failed) = (None, false);
        let list_changed = served.as_ref() != snapshot.as_ref();
        if wanted && server.is_none() {
            match start(&d, sink.clone(), port).await {
                Ok(started) => server = Some(started),
                Err(e) => error = Some(e),
            }
            served = None;
        } else if !wanted && let Some(running) = server.take() {
            running.stop().await;
            log::info!("remote printers: stopped");
        }
        let listening = server.as_ref().and_then(ShareServer::local_addr).map(|a| a.port());
        if let (Some(running), Some(printers)) = (&server, &snapshot)
            && served.as_ref() != Some(printers)
        {
            let pages = d.credentials().map(|c| format!("{}/w/{}/printers", c.server.trim_end_matches('/'), c.workspace_id));
            running.set_printers(printers.iter().map(|p| shared(p, pages.as_deref())).collect());
            served = Some(printers.clone());
        }
        if wanted && let Some(printers) = &snapshot {
            native.refresh(&d.engine, printers, list_changed).await;
        }
        // lpadmin -m everywhere asks the loopback server about the printer, so it must be listening.
        let desired: Option<Vec<Queue>> = match (wanted, listening, &snapshot) {
            (false, _, _) => Some(Vec::new()),
            (true, Some(port), Some(printers)) => {
                let shown = printers.iter().filter(|p| !native.reaches(p) && !settings.remote_printers_hidden.contains(&p.id));
                Some(shown.map(|p| Queue::for_printer(p, port)).collect())
            }
            _ => None,
        };
        if let Some(desired) = desired {
            let ops = cups::plan(&managed, &desired);
            if !ops.is_empty() {
                let (next, failed) = sync(cups.clone(), managed.clone(), ops).await;
                if next != managed {
                    cups::save(&d.paths, &next);
                    managed = next;
                }
                lpadmin_failed = failed.is_some();
                error = error.or(failed);
            }
        }
        let queues = managed.iter().map(|q| (q.printer_id.clone(), q.name.clone())).collect();
        let wait = if lpadmin_failed { RETRY } else { RECHECK };
        let mut report = SystemPrinters::default();
        if wanted {
            let reached = snapshot.iter().flatten().filter(|p| native.reaches(p)).map(|p| p.id.clone()).collect();
            report = survey(&d, cups.clone(), &settings, snapshot.unwrap_or_default(), reached, managed.clone(), lpadmin_failed).await;
            error = error.or(report.error.take());
        }
        report.active = server.is_some();
        report.error.clone_from(&error);
        d.set_remote_status(Status { active: report.active, error, queues, report: Some(report) });
        tokio::select! {
            _ = d.wake.remote.notified() => {}
            _ = sleep(wait) => {}
            _ = d.stopping.canceled() => {
                // Queues stay: CUPS holds jobs until the daemon is back.
                if let Some(running) = server.take() {
                    running.stop().await;
                }
                return;
            }
        }
    }
}

async fn start(d: &Daemon, sink: RemoteSink, port: u16) -> Result<ShareServer, String> {
    let opts = ShareOptions {
        port,
        spool_dir: d.paths.remote_spool(),
        host_label: HOST_LABEL.into(),
        loopback_only: true,
        formats: Some(FORMATS),
    };
    match ShareServer::start(opts, Arc::new(sink)).await {
        Ok(started) => {
            log::info!("remote printers: serving on {}", started.local_addr().map_or_else(|| port.to_string(), |a| a.to_string()));
            Ok(started)
        }
        Err(e) => {
            log::warn!("remote printers: could not listen on 127.0.0.1:{port}: {e}");
            Err(format!("Could not listen on 127.0.0.1:{port}: {e}"))
        }
    }
}

/// Runs lpadmin off the async threads; returns the updated managed list and the first failure.
async fn sync(cups: Arc<dyn Cups>, mut managed: Vec<Queue>, ops: Vec<Op>) -> (Vec<Queue>, Option<String>) {
    let before = managed.clone();
    tokio::task::spawn_blocking(move || {
        let error = cups::apply(cups.as_ref(), &mut managed, ops);
        (managed, error)
    })
    .await
    .unwrap_or_else(|e| (before, Some(format!("Updating system printers failed: {e}"))))
}

/// Per-printer states and the default printer, asked of CUPS off the async threads.
async fn survey(
    d: &Daemon,
    cups: Arc<dyn Cups>,
    settings: &ClientSettings,
    snapshot: Vec<RemotePrinter>,
    reached: std::collections::HashSet<String>,
    managed: Vec<Queue>,
    failed: bool,
) -> SystemPrinters {
    let (direct, applied) = d.with_state(|st| (st.saved.remote_direct.clone(), st.saved.default_printer.clone()));
    let want = settings.default_printer.clone();
    let hidden = settings.remote_printers_hidden.clone();
    let s = report::Survey { snapshot, direct, hidden, reached, managed, failed, want: want.clone(), applied };
    let found = match tokio::task::spawn_blocking(move || report::survey(cups.as_ref(), s)).await {
        Ok(found) => found,
        Err(e) => return SystemPrinters { error: Some(format!("Checking system printers failed: {e}")), ..SystemPrinters::default() },
    };
    d.set_default_applied(found.applied);
    let now = d.settings();
    if found.released && now.default_printer == want {
        let _ = d.change_settings(ClientSettings { default_printer: None, ..now });
    }
    found.report
}

/// Sent after every `welcome`: reports made while offline never reached the server.
pub fn report_message(d: &Daemon) -> Option<ClientMsg> {
    d.with_state(|st| st.remote.report.clone()).map(|report| ClientMsg::SystemPrinters { report })
}

/// The printer as the loopback server describes it to CUPS; `pages` is where the web app shows printers.
fn shared(p: &RemotePrinter, pages: Option<&str>) -> SharedPrinter {
    // Always accepting: a job for an offline device waits on the server, not in CUPS.
    let state = if p.state == PrinterState::Printing { PrinterState::Printing } else { PrinterState::Idle };
    let report = PrinterReport {
        key: p.id.clone(),
        name: p.name.clone(),
        make_model: p.make_model.clone(),
        uuid: None,
        location: Some(p.location.clone().unwrap_or_else(|| p.client_name.clone())),
        local: false,
        routes: Vec::new(),
        capabilities: p.capabilities.clone(),
        status: PrinterStatus {
            state,
            message: (!p.online).then(|| format!("Waiting for {}", p.client_name)),
            supplies: p.supplies.clone(),
            ..PrinterStatus::default()
        },
    };
    let info_url = pages.map(|pages| format!("{pages}/{}", p.id));
    SharedPrinter { key: p.id.clone(), name: p.name.clone(), report, info_url }
}
