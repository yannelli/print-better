//! Scheduler and per-job execution: download, print, throttled progress, retry decisions.

use super::record::Source;
use super::{Outcome, PAUSED_PREFIX, Run, download};
use crate::daemon::Daemon;
use crate::{doc, print_error};
use crate::proto::JobStatus;
use futures_util::FutureExt;
use pb_print::{Document, Error, PrintEvent};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep};

const PROGRESS_EVERY: Duration = Duration::from_secs(2);
const PURGE_EVERY: Duration = Duration::from_secs(3600);

pub async fn run(d: Arc<Daemon>) {
    let mut purged: Option<Instant> = None;
    loop {
        let now = d.server_time_ms();
        let next_retry = if d.settings().paused {
            d.queue.hold(Some(&format!("{PAUSED_PREFIX}{}", d.client_name())), now);
            None
        } else {
            d.queue.hold(None, now);
            let (runs, next) = d.queue.take_runnable(now);
            for run in runs {
                tokio::task::spawn_local(execute(d.clone(), run));
            }
            next
        };
        if purged.is_none_or(|t| t.elapsed() >= PURGE_EVERY) {
            d.queue.purge(now);
            purged = Some(Instant::now());
        }
        let wait = next_retry.map_or(PURGE_EVERY, |at| Duration::from_millis(u64::try_from(at - now).unwrap_or(0)));
        tokio::select! {
            _ = d.queue.woken() => {}
            _ = sleep(wait) => {}
            _ = d.stopping.canceled() => return,
        }
    }
}

async fn execute(d: Arc<Daemon>, run: Run) {
    // A bug in one printer path must fail this job, not leave its printer's queue stuck.
    let outcome = AssertUnwindSafe(attempt(&d, &run)).catch_unwind().await.unwrap_or_else(|_| {
        Outcome::Failed("Print Better hit an internal error while printing this. Please try again.".into())
    });
    match &outcome {
        Outcome::Done(pages) => log::info!("job {} completed ({} pages)", run.rec.id, pages.unwrap_or(0)),
        Outcome::Canceled => log::info!("job {} canceled", run.rec.id),
        Outcome::Failed(why) => log::warn!("job {} failed: {why}", run.rec.id),
        Outcome::Retry(why) => log::info!("job {} will retry: {why}", run.rec.id),
    }
    d.queue.finish(&run, outcome, d.server_time_ms());
}

async fn attempt(d: &Daemon, run: &Run) -> Outcome {
    let path = match &run.rec.file {
        Some(path) if path.exists() => path.clone(),
        _ if run.rec.source == Source::Server => match download::fetch(d, run).await {
            Ok(path) => path,
            Err(outcome) => return outcome,
        },
        _ => return Outcome::Failed("The document to print is missing.".into()),
    };
    if run.cancel.is_canceled() {
        return Outcome::Canceled;
    }
    let Some(printer) = d.printer_report(&run.rec.printer_key) else {
        return Outcome::Retry("Waiting for the printer to be found. Make sure it is on and connected.".into());
    };
    let options = run.rec.options.over(&d.printer_defaults(&run.rec.printer_key));
    let doc = Document { format: doc::detect(&path, Some(&run.rec.content_type)), path, name: run.rec.title.clone() };

    let (tx, mut events) = mpsc::unbounded_channel();
    let on_event = move |event: PrintEvent| {
        let _ = tx.send(event);
    };
    let print = d.engine.print(&printer, &doc, &options, &run.cancel, &on_event);
    tokio::pin!(print);
    let mut progress = Progress::default();
    let result = loop {
        tokio::select! {
            result = &mut print => break result,
            Some(event) = events.recv() => progress.apply(d, run, event),
        }
    };
    match result {
        Ok(done) => Outcome::Done(done.pages),
        Err(Error::Canceled) => Outcome::Canceled,
        Err(e) if e.is_transient() => Outcome::Retry(print_error::sentence(&e)),
        Err(e) => Outcome::Failed(print_error::sentence(&e)),
    }
}

/// Forwards engine events as `job_status`: state changes at once, message-only changes at most every 2 s.
#[derive(Default)]
struct Progress {
    status: Option<JobStatus>,
    message: String,
    sent_at: Option<Instant>,
}

impl Progress {
    fn apply(&mut self, d: &Daemon, run: &Run, event: PrintEvent) {
        let submitted = self.status == Some(JobStatus::Printing);
        let (status, message, pages) = match event {
            PrintEvent::Converting => (JobStatus::Dispatched, "Preparing the document".to_string(), None),
            PrintEvent::Submitting { .. } => (JobStatus::Printing, "Sending to the printer".to_string(), None),
            PrintEvent::Waiting { message } => (JobStatus::Dispatched, message, None),
            PrintEvent::Printing { pages_done } => {
                let text = pages_done.map_or("Printing".to_string(), |n| format!("Printing ({n} done)"));
                (JobStatus::Printing, text, pages_done)
            }
        };
        let status = if submitted { JobStatus::Printing } else { status };
        let changed = self.status != Some(status);
        let due = self.sent_at.is_none_or(|t| t.elapsed() >= PROGRESS_EVERY);
        if !changed && (!due || message == self.message) {
            return;
        }
        d.queue.progress(run, status, message.clone(), pages, d.server_time_ms());
        self.status = Some(status);
        self.message = message;
        self.sent_at = Some(Instant::now());
    }
}
