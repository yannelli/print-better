//! Lookups and housekeeping: status listings, LAN-share job state, pause notes, retention.

use super::Queue;
use super::record::JobRecord;
use crate::proto::JobStatus;
use pb_print::share::SharedJobState;
use std::fs;

const KEEP_FINISHED_MS: i64 = 7 * 24 * 3600 * 1000;
const RECENT_FINISHED: usize = 20;
pub const PAUSED_PREFIX: &str = "Paused on ";

impl Queue {
    pub fn get(&self, id: &str) -> Option<JobRecord> {
        self.lock().jobs.get(id).map(|e| e.rec.clone())
    }

    /// Unfinished jobs plus the most recently finished ones, newest first.
    pub fn list(&self) -> Vec<JobRecord> {
        let mut all: Vec<JobRecord> = self.lock().jobs.values().map(|e| e.rec.clone()).collect();
        all.sort_by_key(|rec| std::cmp::Reverse(rec.updated_at));
        let mut finished = 0;
        all.retain(|rec| {
            if rec.is_terminal() {
                finished += 1;
            }
            !rec.is_terminal() || finished <= RECENT_FINISHED
        });
        all
    }

    /// A job is being downloaded, converted, or printed right now.
    pub fn is_busy(&self) -> bool {
        !self.lock().running.is_empty()
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.lock().running.values().any(|j| j == id)
    }

    pub fn shared_state(&self, share_id: u32) -> Option<(SharedJobState, Option<String>)> {
        let inner = self.lock();
        let entry = inner.jobs.values().find(|e| e.rec.share_id == Some(share_id))?;
        let running = inner.running.values().any(|j| *j == entry.rec.id);
        let state = match entry.rec.status {
            JobStatus::Dispatched if running => SharedJobState::Processing,
            JobStatus::Dispatched => SharedJobState::Pending,
            JobStatus::Printing => SharedJobState::Processing,
            JobStatus::Completed => SharedJobState::Completed,
            JobStatus::Canceled => SharedJobState::Canceled,
            JobStatus::Failed => SharedJobState::Aborted,
        };
        Some((state, entry.rec.message.clone()))
    }

    pub fn cancel_shared(&self, share_id: u32, now: i64) -> bool {
        let id = self.lock().jobs.values().find(|e| e.rec.share_id == Some(share_id)).map(|e| e.rec.id.clone());
        id.is_some_and(|id| self.cancel(&id, now))
    }

    /// While paused, waiting jobs carry `message`; `None` clears the pause note on resume.
    pub fn hold(&self, message: Option<&str>, now: i64) {
        let mut guard = self.lock();
        let inner = &mut *guard;
        for entry in inner.jobs.values_mut() {
            if entry.rec.is_terminal() || inner.running.values().any(|j| *j == entry.rec.id) {
                continue;
            }
            let next = match (message, entry.rec.message.as_deref()) {
                (Some(note), current) if current != Some(note) => Some(note.to_string()),
                (None, Some(current)) if current.starts_with(PAUSED_PREFIX) => None,
                _ => continue,
            };
            entry.rec.message = next;
            entry.rec.updated_at = now;
            self.store.save(&entry.rec);
            self.report(&entry.rec);
        }
    }

    /// After reconnecting: reports made while offline were dropped, so send every job's latest state
    /// (the hub only re-offers queued and dispatched jobs, never ones it last saw printing).
    pub fn resync(&self) {
        let inner = self.lock();
        inner.jobs.values().for_each(|entry| self.report(&entry.rec));
    }

    /// Forgets finished jobs after 7 days (their ids are kept that long for dedup).
    pub fn purge(&self, now: i64) {
        let mut inner = self.lock();
        inner.jobs.retain(|id, entry| {
            let keep = !entry.rec.is_terminal() || now - entry.rec.updated_at < KEEP_FINISHED_MS;
            if !keep {
                self.store.remove(id);
            }
            keep
        });
    }

    /// Unpairing: stop and forget every job.
    pub fn clear(&self) {
        let mut inner = self.lock();
        for entry in inner.jobs.values_mut() {
            entry.cancel.cancel();
            if let Some(file) = entry.rec.file.take() {
                let _ = fs::remove_file(file);
            }
            self.store.remove(&entry.rec.id);
        }
        inner.jobs.clear();
    }
}
