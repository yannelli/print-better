//! Jobs received over IPP: our job-ids, the sink ids they map to, and their IPP view.

use super::{ShareSink, SharedJobState};
use crate::ipp::tags::job_state as js;
use crate::ipp::{Attribute, Value};
use crate::model::{Document, JobOptions};
use std::collections::VecDeque;

const KEEP: usize = 200;
/// multiple-operation-time-out: how long a Create-Job may wait for its document.
pub(super) const DOCUMENT_WAIT_SECS: i32 = 300;

#[derive(Clone)]
pub(super) struct Job {
    pub id: i32,
    pub slug: String,
    pub name: String,
    pub user: String,
    pub options: JobOptions,
    /// printer-up-time at creation.
    pub created: i32,
    pub sink_id: Option<u32>,
    /// Set when the job ended before the sink owned it.
    pub ended: Option<SharedJobState>,
    /// Document received with last-document=false, held until the job is closed.
    pub doc: Option<Document>,
}

impl Job {
    pub fn new(slug: &str, name: String, user: String, options: JobOptions, created: i32) -> Job {
        Job { id: 0, slug: slug.to_string(), name, user, options, created, sink_id: None, ended: None, doc: None }
    }

    /// Created but neither submitted nor ended: still accepting its document.
    pub fn incoming(&self) -> bool {
        self.sink_id.is_none() && self.ended.is_none()
    }

    pub fn status(&self, sink: &dyn ShareSink) -> Status {
        match (self.ended, self.sink_id) {
            (Some(state), _) => Status::of(state, None),
            // The sink forgets finished jobs eventually; by then the job has long completed.
            (None, Some(id)) => sink.state(id).map_or(Status::of(SharedJobState::Completed, None), |(s, m)| Status::of(s, m)),
            (None, None) => Status { state: js::PENDING_HELD, reason: "job-incoming", message: None },
        }
    }

    /// Ends a job the sink never saw, deleting any held document.
    pub fn end(&mut self, state: SharedJobState) {
        self.ended = Some(state);
        if let Some(doc) = self.doc.take() {
            remove(&doc);
        }
    }
}

pub(super) struct Status {
    pub state: i32,
    pub reason: &'static str,
    pub message: Option<String>,
}

impl Status {
    fn of(state: SharedJobState, message: Option<String>) -> Status {
        let (state, reason) = match state {
            SharedJobState::Pending => (js::PENDING, "job-queued"),
            SharedJobState::Processing => (js::PROCESSING, "job-printing"),
            // A completed job with a message finished with a warning, e.g. a short print.
            SharedJobState::Completed if message.is_some() => (js::COMPLETED, "job-completed-with-warnings"),
            SharedJobState::Completed => (js::COMPLETED, "job-completed-successfully"),
            SharedJobState::Canceled => (js::CANCELED, "job-canceled-by-user"),
            SharedJobState::Aborted => (js::ABORTED, "aborted-by-system"),
        };
        Status { state, reason, message }
    }

    pub fn active(&self) -> bool {
        self.state < js::CANCELED
    }
}

pub(super) struct Jobs {
    next: i32,
    list: VecDeque<Job>,
}

impl Jobs {
    pub fn new() -> Jobs {
        Jobs { next: 1, list: VecDeque::new() }
    }

    pub fn add(&mut self, mut job: Job) -> i32 {
        let id = self.next;
        self.next = id.checked_add(1).unwrap_or(1);
        job.id = id;
        let now = job.created;
        self.list.push_back(job);
        self.prune(now);
        id
    }

    pub fn get(&self, slug: &str, id: i32) -> Option<&Job> {
        self.list.iter().find(|j| j.id == id && j.slug == slug)
    }

    pub fn get_mut(&mut self, slug: &str, id: i32) -> Option<&mut Job> {
        self.list.iter_mut().find(|j| j.id == id && j.slug == slug)
    }

    pub fn on(&self, slug: &str) -> Vec<Job> {
        self.list.iter().filter(|j| j.slug == slug).cloned().collect()
    }

    fn prune(&mut self, now: i32) {
        for job in self.list.iter_mut().filter(|j| j.incoming() && now - j.created > DOCUMENT_WAIT_SECS) {
            log::info!("share: job {} never received its document; aborting", job.id);
            job.end(SharedJobState::Aborted);
        }
        while self.list.len() > KEEP {
            if let Some(mut old) = self.list.pop_front() {
                old.end(SharedJobState::Aborted);
            }
        }
    }
}

pub(super) fn remove(doc: &Document) {
    if let Err(e) = std::fs::remove_file(&doc.path) {
        log::debug!("share: removing {}: {e}", doc.path.display());
    }
}

/// Job Description and Status attributes for one job.
pub(super) fn attributes(job: &Job, status: &Status, printer_uri: &str, up_time: i32) -> Vec<Attribute> {
    let mut out = vec![
        Attribute::new("job-id", Value::Integer(job.id)),
        Attribute::new("job-uri", Value::uri(&format!("{printer_uri}/jobs/{}", job.id))),
        Attribute::new("job-printer-uri", Value::uri(printer_uri)),
        Attribute::new("job-name", Value::name(&job.name)),
        Attribute::new("job-originating-user-name", Value::name(&job.user)),
        Attribute::new("job-state", Value::Enum(status.state)),
        Attribute::new("job-state-reasons", Value::keyword(status.reason)),
        Attribute::new("time-at-creation", Value::Integer(job.created)),
        Attribute::new("job-printer-up-time", Value::Integer(up_time)),
    ];
    if let Some(message) = status.message.as_deref().filter(|m| !m.is_empty()) {
        out.push(Attribute::new("job-state-message", Value::text(message)));
    }
    out
}
