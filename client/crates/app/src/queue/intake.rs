//! Jobs that start on this device (LAN sharing, local CLI) and status reporting to the hub.

use super::record::{JobRecord, Source};
use super::{Entry, Queue};
use crate::proto::{ClientMsg, JobStatus};
use pb_print::share::SharedJob;
use pb_print::{CancelFlag, JobOptions};
use std::fs;
use std::path::PathBuf;

pub struct LocalJob {
    pub source: Source,
    pub printer_key: String,
    pub title: String,
    pub user: Option<String>,
    pub file: PathBuf,
    pub content_type: String,
    pub options: JobOptions,
}

impl Queue {
    /// Queues a document already on disk; returns (job id, share id).
    pub fn add_local(&self, job: LocalJob, now: i64) -> (String, u32) {
        let mut inner = self.lock();
        let share_id = inner.next_local;
        inner.next_local = inner.next_local.saturating_add(1);
        let prefix = if job.source == Source::Lan { "lan" } else { "local" };
        let rec = JobRecord {
            id: format!("{prefix}-{now}-{share_id}"),
            source: job.source,
            offer: None,
            share_id: Some(share_id),
            printer_key: job.printer_key,
            title: job.title,
            user: job.user,
            content_type: job.content_type,
            size: fs::metadata(&job.file).map_or(0, |m| m.len()),
            options: job.options,
            created_at: now,
            status: JobStatus::Dispatched,
            message: None,
            pages: None,
            file: Some(job.file),
            updated_at: now,
            tries: 0,
            retry_at: 0,
        };
        log::info!("{prefix} job {} queued for printer {}", rec.id, rec.printer_key);
        self.store.save(&rec);
        self.report(&rec);
        let id = rec.id.clone();
        inner.jobs.insert(id.clone(), Entry { rec, cancel: CancelFlag::default() });
        drop(inner);
        self.wake();
        (id, share_id)
    }

    pub fn add_shared(&self, job: SharedJob, now: i64) -> u32 {
        let local = LocalJob {
            source: Source::Lan,
            content_type: job.doc.format.mime().to_string(),
            printer_key: job.printer_key,
            title: job.title,
            user: job.user,
            file: job.doc.path,
            options: job.options,
        };
        self.add_local(local, now).1
    }

    pub(super) fn report(&self, rec: &JobRecord) {
        let msg = match rec.source {
            Source::Server => ClientMsg::JobStatus {
                job_id: rec.id.clone(),
                status: rec.status,
                message: rec.message.clone(),
                pages: rec.pages,
                attempt: Some(rec.attempt()),
            },
            Source::Lan => ClientMsg::LanJob {
                local_id: rec.id.clone(),
                printer_key: rec.printer_key.clone(),
                title: rec.title.clone(),
                user: rec.user.clone(),
                content_type: rec.content_type.clone(),
                size: rec.size,
                status: lan_status(rec.status).into(),
                message: rec.message.clone(),
            },
            Source::Local => return,
        };
        self.outbox.send(msg);
    }
}

fn lan_status(status: JobStatus) -> &'static str {
    match status {
        JobStatus::Dispatched => "queued",
        JobStatus::Printing => "printing",
        JobStatus::Completed => "completed",
        JobStatus::Failed => "failed",
        JobStatus::Canceled => "canceled",
    }
}
