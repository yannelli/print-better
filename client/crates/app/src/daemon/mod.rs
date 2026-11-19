//! The background service: server session, job queue, inventory, LAN sharing, local API.

mod commands;
pub mod diagnose;
mod inventory;
mod outbox;
mod pair;
mod remote;
mod run;
mod session;
mod settings_sync;
mod share;
mod state;
#[cfg(test)]
mod tests;
mod updater;

pub use inventory::discover;
pub use outbox::Outbox;
pub use remote::{NO_CUPS as REMOTE_PRINTERS_NO_CUPS, SUPPORTED as REMOTE_PRINTERS_SUPPORTED};
pub use run::run_blocking;
pub use state::{Conn, Pairing, State};
pub use updater::{can_install as can_install_update, check_now as check_update, request as request_update, status as update_status};

use crate::clock::now_ms;
use crate::paths::Paths;
use crate::platform;
use crate::proto::{ClientMsg, ClientSettings, RemotePrinter};
use crate::queue::Queue;
use crate::store::{self, Credentials};
use pb_print::{CancelFlag, Engine, EngineOptions, JobOptions, PrinterReport};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::Notify;
use tokio::sync::mpsc::UnboundedReceiver;

pub struct Daemon {
    pub paths: Paths,
    pub engine: Engine,
    pub queue: Arc<Queue>,
    pub outbox: Outbox,
    /// A GUI session exists and this build has a tray; `run --no-tray` clears it.
    pub tray_capable: bool,
    pub tray_running: bool,
    /// Set to shut down (quit, signal, or before a self-restart).
    pub stopping: CancelFlag,
    restart: AtomicBool,
    pub wake: Wake,
    state: Mutex<State>,
    outbox_rx: tokio::sync::Mutex<UnboundedReceiver<ClientMsg>>,
    discovery_lock: tokio::sync::Mutex<()>,
}

#[derive(Default)]
pub struct Wake {
    pub session: Notify,
    pub discover: Notify,
    pub share: Notify,
    pub remote: Notify,
    pub update: Notify,
}

impl Daemon {
    pub fn new(paths: Paths, tray_capable: bool, tray_running: bool) -> Daemon {
        let (outbox, outbox_rx) = Outbox::new();
        let engine = make_engine(&paths, "Print Better");
        let queue = Arc::new(Queue::open(&paths, outbox.clone(), now_ms()));
        let state = State::load(&paths);
        crate::logger::set_debug(state.config.settings.log_level == "debug");
        Daemon {
            engine,
            queue,
            outbox,
            tray_capable,
            tray_running,
            stopping: CancelFlag::default(),
            restart: AtomicBool::new(false),
            wake: Wake::default(),
            state: Mutex::new(state),
            outbox_rx: tokio::sync::Mutex::new(outbox_rx),
            discovery_lock: tokio::sync::Mutex::new(()),
            paths,
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Stops the daemon; with `restart`, the process re-executes itself afterwards.
    pub fn stop(&self, restart: bool, why: &str) {
        log::info!("{} ({why})", if restart { "restarting" } else { "stopping" });
        if restart {
            self.restart.store(true, Ordering::SeqCst);
        }
        self.stopping.cancel();
    }

    pub fn restart_requested(&self) -> bool {
        self.restart.load(Ordering::SeqCst)
    }

    pub fn settings(&self) -> ClientSettings {
        self.lock().config.settings.clone()
    }

    pub fn credentials(&self) -> Option<Credentials> {
        self.lock().creds.clone()
    }

    pub fn client_name(&self) -> String {
        let st = self.lock();
        st.saved.name.clone().or_else(|| st.creds.as_ref().map(|c| c.name.clone())).unwrap_or_else(platform::hostname)
    }

    /// Local time corrected by the offset learned from `welcome.serverTime`.
    pub fn server_time_ms(&self) -> i64 {
        now_ms() + self.lock().clock_offset_ms.unwrap_or(0)
    }

    pub fn printer_report(&self, key: &str) -> Option<PrinterReport> {
        self.lock().inventory.printers.get(key).cloned()
    }

    pub fn printer_defaults(&self, key: &str) -> JobOptions {
        let st = self.lock();
        st.saved.printers.iter().find(|p| p.key == key).map(|p| p.defaults.clone()).unwrap_or_default()
    }

    pub fn added_keys(&self) -> HashSet<String> {
        self.lock().saved.printers.iter().filter(|p| p.added).map(|p| p.key.clone()).collect()
    }

    /// Inventory with server-assigned names applied, for choosing a printer by name.
    pub fn named_printers(&self) -> Vec<PrinterReport> {
        let st = self.lock();
        st.inventory
            .printers
            .values()
            .map(|report| {
                let mut report = report.clone();
                if let Some(config) = st.saved.printers.iter().find(|c| c.key == report.key) {
                    report.name = config.name.clone();
                }
                report
            })
            .collect()
    }

    pub fn set_conn(&self, conn: Conn, detail: Option<String>) {
        let mut st = self.lock();
        st.conn = conn;
        st.conn_detail = detail;
    }

    pub fn set_share_status(&self, active: bool, error: Option<String>) {
        let mut st = self.lock();
        st.share_active = active;
        st.share_error = error;
    }

    pub fn set_remote_status(&self, status: remote::Status) {
        self.lock().remote = status;
    }

    pub fn set_remote_printers(&self, printers: Vec<RemotePrinter>) {
        {
            let mut st = self.lock();
            st.saved.remote_printers = Some(printers);
            self.save_saved_state(&st);
        }
        self.wake.remote.notify_one();
    }

    pub fn remote_printer(&self, id: &str) -> Option<RemotePrinter> {
        self.lock().saved.remote_printers.iter().flatten().find(|p| p.id == id).cloned()
    }

    pub fn hello(&self) -> ClientMsg {
        let st = self.lock();
        ClientMsg::Hello {
            protocol: crate::proto::PROTOCOL_VERSION,
            version: crate::VERSION.into(),
            os: platform::os().into(),
            arch: platform::arch().into(),
            hostname: platform::hostname(),
            features: platform::features(self.tray_running),
            settings: st.config.settings.clone(),
            settings_updated_at: st.config.settings_updated_at,
        }
    }

    /// Read-only view of the state for the status page and diagnostics.
    pub fn with_state<R>(&self, f: impl FnOnce(&State) -> R) -> R {
        f(&self.lock())
    }

    fn save_saved_state(&self, st: &State) {
        if let Err(e) = store::save_state(&self.paths, &st.saved) {
            log::warn!("could not save state: {e}");
        }
    }
}

/// The print engine with its state folder (certificate pins, conversion scratch).
pub fn make_engine(paths: &Paths, requesting_user: &str) -> Engine {
    let _ = std::fs::create_dir_all(paths.engine());
    Engine::new(EngineOptions {
        user_agent: crate::net::USER_AGENT.into(),
        requesting_user: requesting_user.into(),
        state_dir: paths.engine(),
    })
}
