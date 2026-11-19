//! An IPP Everywhere/AirPrint server that hands received jobs to the app: LAN sharing with
//! DNS-SD advertisement, or a loopback-only instance behind the app's own system print queues.

mod attrs;
mod dnssd;
mod jobops;
mod jobs;
mod media;
mod ops;
mod server;
mod state;
mod upload;
#[cfg(test)]
mod tests;

use crate::error::Result;
use crate::model::{Document, JobOptions, PrinterReport};
use dnssd::Advertiser;
use state::{Served, State};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

#[derive(Clone, Debug)]
pub struct SharedPrinter {
    pub key: String,
    /// Name shown to phones and laptops.
    pub name: String,
    pub report: PrinterReport,
}

#[derive(Clone, Debug)]
pub struct SharedJob {
    pub printer_key: String,
    pub title: String,
    pub user: Option<String>,
    /// Spooled file inside `ShareOptions::spool_dir`; the sink takes ownership.
    pub doc: Document,
    pub options: JobOptions,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SharedJobState {
    Pending,
    Processing,
    Completed,
    Canceled,
    Aborted,
}

/// Implemented by the app: queues the job and reports its progress back to IPP clients.
pub trait ShareSink: Send + Sync + 'static {
    fn submit(&self, job: SharedJob) -> std::result::Result<u32, String>;
    fn state(&self, id: u32) -> Option<(SharedJobState, Option<String>)>;
    fn cancel(&self, id: u32) -> bool;
}

#[derive(Clone, Debug)]
pub struct ShareOptions {
    pub port: u16,
    pub spool_dir: PathBuf,
    /// Host label used in service names, e.g. "Kitchen Pi".
    pub host_label: String,
    /// Listen on 127.0.0.1 only and never advertise over DNS-SD.
    pub loopback_only: bool,
    /// Accept exactly these document formats instead of what each printer can print.
    pub formats: Option<&'static [&'static str]>,
}

pub struct ShareServer {
    state: Arc<State>,
    /// None when mDNS is unavailable; printers stay reachable by URI.
    advertiser: Mutex<Option<Advertiser>>,
    accept: JoinHandle<()>,
    addr: Option<SocketAddr>,
}

impl ShareServer {
    pub async fn start(opts: ShareOptions, sink: Arc<dyn ShareSink>) -> Result<ShareServer> {
        tokio::fs::create_dir_all(&opts.spool_dir).await?;
        let ip = if opts.loopback_only { Ipv4Addr::LOCALHOST } else { Ipv4Addr::UNSPECIFIED };
        let listener = TcpListener::bind((ip, opts.port)).await?;
        let advertiser = if opts.loopback_only { None } else { Advertiser::new(&opts.host_label, opts.port) };
        Ok(Self::serve(listener, advertiser, opts, sink))
    }

    /// Serves on a bound listener; without an advertiser nothing is announced (tests rely on that).
    fn serve(listener: TcpListener, advertiser: Option<Advertiser>, opts: ShareOptions, sink: Arc<dyn ShareSink>) -> ShareServer {
        let addr = listener.local_addr().ok();
        let state = Arc::new(State::new(opts, sink));
        let accept = tokio::spawn(server::run(listener, state.clone()));
        ShareServer { state, advertiser: Mutex::new(advertiser), accept, addr }
    }

    pub fn local_addr(&self) -> Option<SocketAddr> {
        self.addr
    }

    /// Replaces the served set and updates DNS-SD registrations.
    pub fn set_printers(&self, printers: Vec<SharedPrinter>) {
        let opts = &self.state.opts;
        let served: Vec<Arc<Served>> =
            printers.into_iter().map(|p| Arc::new(Served::new(p, &opts.host_label, opts.formats))).collect();
        self.state.set_printers(served.iter().map(|s| (s.slug.clone(), s.clone())).collect());
        if let Some(advertiser) = self.advertiser.lock().unwrap_or_else(PoisonError::into_inner).as_mut() {
            advertiser.update(&served);
        }
    }

    /// Withdraws advertisements and stops listening.
    pub async fn stop(mut self) {
        let advertiser = self.advertiser.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(advertiser) = advertiser {
            advertiser.withdraw().await;
        }
        self.accept.abort();
        // The listener closes only when the aborted task is dropped; wait so a restart can rebind.
        if let Err(e) = (&mut self.accept).await
            && e.is_panic()
        {
            log::warn!("share: server task panicked: {e}");
        }
    }
}

/// URL path a printer with this key is served under, e.g. `/ipp/print/1a2b3c4d5e6f`.
pub fn printer_path(key: &str) -> String {
    format!("/ipp/print/{}", state::slug(key))
}

impl Drop for ShareServer {
    fn drop(&mut self) {
        self.accept.abort();
    }
}
