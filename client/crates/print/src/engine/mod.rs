//! Engine: the one entry point the app uses. Owned by the print-path implementer;
//! the public signatures below are frozen (additive changes only).

mod follow;
mod print;
mod reasons;
#[cfg(windows)]
mod spooler;
mod status;
#[cfg(test)]
mod tests;

use crate::discovery::DiscoverOptions;
use crate::error::Result;
use crate::ipp::IppClient;
use crate::model::{Document, JobOptions, PrinterReport, PrinterStatus, Route, RouteKind};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Clone, Debug)]
pub struct EngineOptions {
    /// HTTP User-Agent for IPP, e.g. "PrintBetter/0.1.0".
    pub user_agent: String,
    /// IPP requesting-user-name.
    pub requesting_user: String,
    /// Writable directory for certificate pins and conversion scratch files.
    pub state_dir: PathBuf,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PrintEvent {
    Converting,
    Submitting { route: RouteKind },
    /// Printer reachable but blocked (out of paper, offline); human-readable reason.
    Waiting { message: String },
    Printing { pages_done: Option<u32> },
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrintOutcome {
    pub route: RouteKind,
    pub pages: Option<u32>,
}

#[derive(Default)]
struct CancelInner {
    flag: AtomicBool,
    notify: Notify,
}

#[derive(Clone, Default)]
pub struct CancelFlag(Arc<CancelInner>);

impl CancelFlag {
    pub fn cancel(&self) {
        self.0.flag.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }

    pub fn is_canceled(&self) -> bool {
        self.0.flag.load(Ordering::SeqCst)
    }

    /// Resolves once `cancel` has been called.
    pub async fn canceled(&self) {
        loop {
            let notified = self.0.notify.notified();
            if self.is_canceled() {
                return;
            }
            notified.await;
        }
    }
}

pub struct Engine {
    pub(crate) opts: EngineOptions,
    pub(crate) ipp: IppClient,
}

impl Engine {
    pub fn new(opts: EngineOptions) -> Engine {
        let ipp = IppClient::new(&opts.user_agent, &opts.state_dir);
        crate::convert::spool::sweep(&opts.state_dir);
        Engine { opts, ipp }
    }

    pub fn ipp(&self) -> &IppClient {
        &self.ipp
    }

    /// Runs every enabled discovery source and returns merged, deduplicated printers.
    pub async fn discover(&self, opts: &DiscoverOptions) -> Vec<PrinterReport> {
        crate::discovery::run(&self.ipp, opts).await
    }

    /// Current state, reasons, and supply levels via the best available route.
    /// Unreachable printers report state Offline rather than an error.
    pub async fn status(&self, printer: &PrinterReport) -> Result<PrinterStatus> {
        status::status(self, printer).await
    }

    /// Makes the printer beep/flash (IPP Identify-Printer); Unsupported otherwise.
    pub async fn identify(&self, printer: &PrinterReport) -> Result<()> {
        status::identify(self, printer).await
    }

    /// Converts as needed, submits over the first working route, and follows the job to the end.
    pub async fn print(
        &self,
        printer: &PrinterReport,
        doc: &Document,
        options: &JobOptions,
        cancel: &CancelFlag,
        on_event: &(dyn Fn(PrintEvent) + Send + Sync),
    ) -> Result<PrintOutcome> {
        print::print(self, printer, doc, options, cancel, on_event).await
    }

    /// Connectivity check of every route, for `diagnose`.
    pub async fn probe(&self, printer: &PrinterReport) -> Vec<(Route, std::result::Result<(), String>)> {
        status::probe(self, printer).await
    }
}
