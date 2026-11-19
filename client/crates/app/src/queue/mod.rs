//! Persisted job queue: idempotent by job id, FIFO per printer, parallel across printers.

pub mod download;
mod intake;
pub mod record;
pub mod runner;
#[cfg(test)]
mod tests;
mod views;

pub use intake::LocalJob;
pub use views::PAUSED_PREFIX;

use crate::daemon::Outbox;
use crate::paths::Paths;
use crate::proto::{ClientMsg, JobOffer, JobStatus};
use pb_print::CancelFlag;
use record::{JobRecord, Store};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use tokio::sync::Notify;

const GIVE_UP_MS: i64 = 24 * 3600 * 1000;
const RESTARTED: &str =
    "Print Better restarted while this was printing. Check the printer, and use Retry if nothing came out.";

pub enum Outcome {
    Done(Option<u32>),
    Canceled,
    Failed(String),
    /// Transient: keep the job and try again with backoff.
    Retry(String),
}

/// A job handed to a runner. Updates are ignored if the record moved on to a newer attempt.
#[derive(Clone)]
pub struct Run {
    pub rec: JobRecord,
    pub cancel: CancelFlag,
}

pub struct Queue {
    store: Store,
    pub spool: PathBuf,
    outbox: Outbox,
    inner: Mutex<Inner>,
    wake: Notify,
}

struct Inner {
    jobs: HashMap<String, Entry>,
    /// Printer key -> id of the job printing on it.
    running: HashMap<String, String>,
    next_local: u32,
}

struct Entry {
    rec: JobRecord,
    cancel: CancelFlag,
}

impl Queue {
    pub fn open(paths: &Paths, outbox: Outbox, now: i64) -> Queue {
        let store = Store::new(paths.jobs());
        let spool = paths.spool();
        let _ = fs::create_dir_all(&spool);
        let mut inner = Inner { jobs: HashMap::new(), running: HashMap::new(), next_local: 1 };
        for mut rec in store.load_all() {
            // A half-printed job may already be on paper; reprinting could waste a stack of pages.
            if rec.status == JobStatus::Printing {
                rec.finish(JobStatus::Failed, Some(RESTARTED.into()), None, now);
                store.save(&rec);
            }
            inner.next_local = inner.next_local.max(rec.share_id.unwrap_or(0).saturating_add(1));
            inner.jobs.insert(rec.id.clone(), Entry { rec, cancel: CancelFlag::default() });
        }
        let referenced: HashSet<PathBuf> = inner.jobs.values().filter_map(|e| e.rec.file.clone()).collect();
        for path in fs::read_dir(&spool).into_iter().flatten().filter_map(Result::ok).map(|e| e.path()) {
            if !referenced.contains(&path) {
                let _ = fs::remove_file(path);
            }
        }
        Queue { store, spool, outbox, inner: Mutex::new(inner), wake: Notify::new() }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn wake(&self) {
        self.wake.notify_one();
    }

    pub async fn woken(&self) {
        self.wake.notified().await;
    }

    /// `job` from the hub: persist, then ack `dispatched`; known ids just get their latest status.
    pub fn offer(&self, offer: JobOffer, now: i64) {
        let mut inner = self.lock();
        if let Some(entry) = inner.jobs.get(&offer.id) {
            if offer.attempt <= entry.rec.attempt() {
                self.report(&entry.rec);
                return;
            }
            entry.cancel.cancel();
        }
        let rec = JobRecord::from_offer(offer, now);
        log::info!("job {} received for printer {}", rec.id, rec.printer_key);
        self.store.save(&rec);
        self.report(&rec);
        inner.jobs.insert(rec.id.clone(), Entry { rec, cancel: CancelFlag::default() });
        drop(inner);
        self.wake();
    }

    /// Cancels a job; a running one stops through its flag and reports when the engine returns.
    pub fn cancel(&self, id: &str, now: i64) -> bool {
        let mut guard = self.lock();
        let inner = &mut *guard;
        let running = inner.running.values().any(|j| j == id);
        let Some(entry) = inner.jobs.get_mut(id) else {
            drop(guard);
            self.outbox.send(ClientMsg::JobStatus {
                job_id: id.to_string(),
                status: JobStatus::Canceled,
                message: None,
                pages: None,
                attempt: None,
            });
            return false;
        };
        if !entry.rec.is_terminal() {
            entry.cancel.cancel();
            if running {
                return true;
            }
            entry.rec.finish(JobStatus::Canceled, None, None, now);
            self.store.save(&entry.rec);
        }
        self.report(&entry.rec);
        true
    }

    /// Starts the oldest waiting job of every idle printer; also returns the next retry time.
    pub fn take_runnable(&self, now: i64) -> (Vec<Run>, Option<i64>) {
        let mut guard = self.lock();
        let inner = &mut *guard;
        let mut waiting: Vec<&Entry> = inner.jobs.values().filter(|e| !e.rec.is_terminal()).collect();
        waiting.sort_by(|a, b| (a.rec.created_at, &a.rec.id).cmp(&(b.rec.created_at, &b.rec.id)));
        let mut seen = HashSet::new();
        let (mut runs, mut next) = (Vec::new(), None::<i64>);
        for entry in waiting {
            let key = entry.rec.printer_key.as_str();
            if !seen.insert(key) || inner.running.contains_key(key) {
                continue;
            }
            if entry.rec.retry_at <= now {
                runs.push(Run { rec: entry.rec.clone(), cancel: entry.cancel.clone() });
            } else {
                next = Some(next.map_or(entry.rec.retry_at, |n| n.min(entry.rec.retry_at)));
            }
        }
        for run in &runs {
            inner.running.insert(run.rec.printer_key.clone(), run.rec.id.clone());
        }
        (runs, next)
    }

    pub fn progress(&self, run: &Run, status: JobStatus, message: String, pages: Option<u32>, now: i64) {
        self.update(run, true, |rec| {
            rec.status = status;
            rec.message = Some(message);
            rec.pages = pages.or(rec.pages);
            rec.updated_at = now;
        });
    }

    pub fn set_file(&self, run: &Run, file: PathBuf) {
        self.update(run, false, |rec| rec.file = Some(file));
    }

    pub fn finish(&self, run: &Run, outcome: Outcome, now: i64) {
        let canceled = run.cancel.is_canceled();
        {
            let mut inner = self.lock();
            if inner.running.get(&run.rec.printer_key) == Some(&run.rec.id) {
                inner.running.remove(&run.rec.printer_key);
            }
        }
        self.update(run, true, |rec| match outcome {
            Outcome::Done(pages) => rec.finish(JobStatus::Completed, None, pages, now),
            Outcome::Canceled => rec.finish(JobStatus::Canceled, None, None, now),
            Outcome::Retry(_) if canceled => rec.finish(JobStatus::Canceled, None, None, now),
            Outcome::Failed(message) => rec.finish(JobStatus::Failed, Some(message), None, now),
            Outcome::Retry(message) if now - rec.created_at > GIVE_UP_MS => {
                rec.finish(JobStatus::Failed, Some(format!("Gave up after 24 hours. {message}")), None, now)
            }
            Outcome::Retry(message) => {
                // Transient errors mean nothing reached the printer, so a restart may retry it too.
                rec.status = JobStatus::Dispatched;
                rec.tries += 1;
                rec.retry_at = now + backoff_ms(rec.tries);
                rec.message = Some(message);
                rec.updated_at = now;
            }
        });
        self.wake();
    }

    fn update(&self, run: &Run, report: bool, change: impl FnOnce(&mut JobRecord)) {
        let mut inner = self.lock();
        let Some(entry) = inner.jobs.get_mut(&run.rec.id) else { return };
        if entry.rec.attempt() != run.rec.attempt() || entry.rec.is_terminal() {
            return;
        }
        change(&mut entry.rec);
        self.store.save(&entry.rec);
        if report {
            self.report(&entry.rec);
        }
    }
}

/// 5 s doubling to 5 min.
fn backoff_ms(tries: u32) -> i64 {
    (5_000i64 << tries.saturating_sub(1).min(6)).min(300_000)
}
