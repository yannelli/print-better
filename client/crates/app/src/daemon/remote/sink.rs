//! Jobs CUPS hands the loopback server: each goes to the Print Better server, which routes it
//! to the device that owns the printer; its progress is mirrored back for the system queue.

use super::api::{Server, ServerJob, ipp_state};
use crate::daemon::Daemon;
use crate::net::{NetError, ServerUrl};
use pb_print::CancelFlag;
use pb_print::share::{ShareSink, SharedJob, SharedJobState};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tokio::time::sleep;

const POLL: Duration = if cfg!(test) { Duration::from_millis(20) } else { Duration::from_secs(2) };
const KEEP: usize = 200;
pub const NOT_READY: &str = "Not ready: Print Better is not connected to its server.";
const TERMINAL: [&str; 4] = ["completed", "failed", "canceled", "held"];

#[derive(Clone)]
pub struct RemoteSink(Arc<Inner>);

struct Inner {
    d: Arc<Daemon>,
    jobs: Mutex<Jobs>,
}

#[derive(Default)]
struct Jobs {
    next: u32,
    list: BTreeMap<u32, Entry>,
}

struct Entry {
    printer_id: String,
    state: SharedJobState,
    message: Option<String>,
    server_id: Option<String>,
    cancel: CancelFlag,
}

fn active(state: SharedJobState) -> bool {
    matches!(state, SharedJobState::Pending | SharedJobState::Processing)
}

/// Printer access refuses with 403, or 404 when the printer is hidden from this computer. A rule or limit refuses with its own message.
fn not_sent(e: NetError) -> String {
    match e {
        NetError::Api { status: 403 | 404, code, .. } if code == "printer_access_denied" => "You can't print to this printer from this computer".into(),
        NetError::Api { status: 403, code, message } if code == "policy_blocked" => message,
        e => format!("Couldn't send the job to Print Better: {e}"),
    }
}

impl RemoteSink {
    pub fn new(d: Arc<Daemon>) -> RemoteSink {
        RemoteSink(Arc::new(Inner { d, jobs: Mutex::new(Jobs::default()) }))
    }

    fn jobs(&self) -> MutexGuard<'_, Jobs> {
        self.0.jobs.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn server(&self) -> Option<Server> {
        let creds = self.0.d.credentials()?;
        Some(Server { url: ServerUrl::parse(&creds.server).ok()?, token: creds.token })
    }

    fn set(&self, id: u32, state: SharedJobState, message: Option<String>) {
        if let Some(entry) = self.jobs().list.get_mut(&id) {
            entry.state = state;
            entry.message = message;
        }
    }

    fn mirror(&self, id: u32, job: &ServerJob) {
        let Some(printer_id) = self.jobs().list.get(&id).map(|e| e.printer_id.clone()) else { return };
        let (state, message) = ipp_state(job, self.0.d.remote_printer(&printer_id).as_ref());
        self.set(id, state, message);
    }

    async fn deliver(self, id: u32, server: Server, job: SharedJob, cancel: CancelFlag) {
        let handed = tokio::select! {
            handed = self.hand_over(id, &server, &job) => Some(handed),
            _ = cancel.canceled() => None,
        };
        if let Err(e) = tokio::fs::remove_file(&job.doc.path).await {
            log::debug!("remote job {id}: removing {}: {e}", job.doc.path.display());
        }
        let (state, message) = match handed {
            Some(Ok(created)) => return self.follow(id, &server, created, cancel).await,
            Some(Err(message)) => {
                log::warn!("remote job {id}: {message}");
                (SharedJobState::Aborted, Some(message))
            }
            None => (SharedJobState::Canceled, None),
        };
        // A job created but never fully uploaded would otherwise linger on the server.
        let server_id = self.jobs().list.get(&id).and_then(|e| e.server_id.clone());
        if let Some(server_id) = server_id
            && let Err(e) = server.cancel(&server_id).await
        {
            log::warn!("remote job {id}: could not cancel it on the server: {e}");
        }
        self.set(id, state, message);
    }

    /// Creates the server job and uploads the document.
    async fn hand_over(&self, id: u32, server: &Server, job: &SharedJob) -> Result<ServerJob, String> {
        let size = tokio::fs::metadata(&job.doc.path).await.map_err(|e| format!("Couldn't read the document: {e}"))?.len();
        let (created, path) = server.create(&job.printer_key, job, size).await.map_err(not_sent)?;
        log::info!("remote job {id}: sent as {} to printer {}", created.id, job.printer_key);
        if let Some(entry) = self.jobs().list.get_mut(&id) {
            entry.server_id = Some(created.id.clone());
        }
        server.upload(&path, job).await.map_err(not_sent)
    }

    /// Polls the server job until it ends, passing a cancel from CUPS on.
    async fn follow(&self, id: u32, server: &Server, mut job: ServerJob, cancel: CancelFlag) {
        let mut cancel_sent = false;
        loop {
            self.mirror(id, &job);
            if TERMINAL.contains(&job.status.as_str()) {
                log::info!("remote job {id}: {}", job.status);
                return;
            }
            let wants_cancel = tokio::select! {
                _ = sleep(POLL) => false,
                _ = cancel.canceled(), if !cancel_sent => true,
            };
            cancel_sent |= wants_cancel;
            let next = if wants_cancel { server.cancel(&job.id).await } else { server.get(&job.id).await };
            match next {
                Ok(next) => job = next,
                Err(NetError::Api { status: 401 | 403 | 404, message, .. }) => {
                    self.set(id, SharedJobState::Aborted, Some(message));
                    return;
                }
                Err(e) => log::debug!("remote job {id}: checking on it failed: {e}"),
            }
        }
    }
}

impl ShareSink for RemoteSink {
    fn submit(&self, job: SharedJob) -> Result<u32, String> {
        let server = self.server().filter(|_| self.0.d.outbox.is_online()).ok_or_else(|| NOT_READY.to_string())?;
        let cancel = CancelFlag::default();
        let id = {
            let mut jobs = self.jobs();
            jobs.next = jobs.next.wrapping_add(1).max(1);
            let id = jobs.next;
            let entry = Entry {
                printer_id: job.printer_key.clone(),
                state: SharedJobState::Pending,
                message: Some("Sending to Print Better".into()),
                server_id: None,
                cancel: cancel.clone(),
            };
            jobs.list.insert(id, entry);
            while jobs.list.len() > KEEP {
                let Some(old) = jobs.list.iter().find(|(_, e)| !active(e.state)).map(|(id, _)| *id) else { break };
                jobs.list.remove(&old);
            }
            id
        };
        tokio::spawn(self.clone().deliver(id, server, job, cancel));
        Ok(id)
    }

    fn state(&self, id: u32) -> Option<(SharedJobState, Option<String>)> {
        self.jobs().list.get(&id).map(|e| (e.state, e.message.clone()))
    }

    fn cancel(&self, id: u32) -> bool {
        match self.jobs().list.get(&id).filter(|e| active(e.state)) {
            Some(entry) => {
                entry.cancel.cancel();
                true
            }
            None => false,
        }
    }
}
