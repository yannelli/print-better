//! Queue behaviour: intake, scheduling, outcomes, restarts, and housekeeping.

mod lifecycle;
mod offers;
mod outcomes;

use super::{Queue, Run};
use crate::daemon::Outbox;
use crate::proto::{ClientMsg, JobOffer, JobStatus};
use crate::test_util::TempDir;
use pb_print::JobOptions;
use tokio::sync::mpsc::UnboundedReceiver;

pub const NOW: i64 = 1_763_500_000_000;
pub const HOUR: i64 = 3600 * 1000;

pub struct Fixture {
    pub dir: TempDir,
    pub queue: Queue,
    sent: UnboundedReceiver<ClientMsg>,
}

impl Fixture {
    pub fn new() -> Fixture {
        Fixture::open(TempDir::new())
    }

    /// Opens the queue stored in `dir`, as a daemon start does.
    fn open(dir: TempDir) -> Fixture {
        let (outbox, sent) = Outbox::new();
        outbox.set_online(true);
        let queue = Queue::open(&dir.paths(), outbox, NOW);
        Fixture { dir, queue, sent }
    }

    pub fn restart(self) -> Fixture {
        let Fixture { dir, queue, .. } = self;
        drop(queue);
        Fixture::open(dir)
    }

    /// Everything sent to the hub since the last call.
    pub fn drain(&mut self) -> Vec<ClientMsg> {
        std::iter::from_fn(|| self.sent.try_recv().ok()).collect()
    }

    /// `(job id, status, attempt)` of every `job_status` sent since the last drain.
    pub fn reports(&mut self) -> Vec<(String, JobStatus, Option<u32>)> {
        self.drain()
            .into_iter()
            .filter_map(|msg| match msg {
                ClientMsg::JobStatus { job_id, status, attempt, .. } => Some((job_id, status, attempt)),
                _ => None,
            })
            .collect()
    }

    pub fn status(&self, id: &str) -> JobStatus {
        self.queue.get(id).unwrap().status
    }

    pub fn message(&self, id: &str) -> Option<String> {
        self.queue.get(id).unwrap().message
    }

    pub fn take(&self, now: i64) -> Vec<Run> {
        self.queue.take_runnable(now).0
    }

    /// Offers a job and starts it, returning its run.
    pub fn start(&mut self, id: &str, printer: &str) -> Run {
        self.queue.offer(offer(id, printer, 1, NOW), NOW);
        let mut runs = self.take(NOW);
        assert_eq!(runs.len(), 1, "expected {id} to start");
        self.drain();
        runs.remove(0)
    }
}

pub fn offer(id: &str, printer: &str, attempt: u32, created_at: i64) -> JobOffer {
    JobOffer {
        id: id.into(),
        printer_key: printer.into(),
        title: format!("{id}.pdf"),
        content_type: "application/pdf".into(),
        size: 10,
        sha256: "00".into(),
        options: JobOptions::default(),
        file_url: format!("/api/client/jobs/{id}/document"),
        attempt,
        created_at,
    }
}

pub fn ids(runs: &[Run]) -> Vec<&str> {
    let mut ids: Vec<&str> = runs.iter().map(|r| r.rec.id.as_str()).collect();
    ids.sort_unstable();
    ids
}
