//! Follows an accepted IPP job to a final state. An accepted job is never sent again: losing
//! track of it ends as completed with a warning instead of an error that would cause a reprint.

use super::expect::Expected;
use super::{CancelFlag, PrintEvent, PrintOutcome, reasons};
use crate::backends::Events;
use crate::error::{Error, Result};
use crate::ipp::{IppClient, IppJobState, JobStateKind};
use crate::model::{PrinterStatus, RouteKind};
use std::future::Future;
use std::time::{Duration, Instant};

pub(crate) const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const FIRST_POLL: Duration = if cfg!(test) { Duration::from_millis(10) } else { Duration::from_millis(500) };
const MAX_POLL: Duration = if cfg!(test) { Duration::from_millis(20) } else { Duration::from_secs(5) };
/// A job still unfinished after this long is reported done rather than holding the queue forever.
const FOLLOW_LIMIT: Duration = if cfg!(test) { Duration::from_millis(300) } else { Duration::from_secs(2 * 3600) };
/// The printer may reboot or sleep mid-job; after this long without answers, stop asking.
const SILENCE_LIMIT: Duration = Duration::from_secs(10 * 60);
/// Printers that drop finished jobs (or can't report them) answer with errors instead.
const GONE_AFTER: u32 = 3;
const PRINTER_CHECK: Duration = Duration::from_secs(30);
pub(crate) const LOST_TRACK: &str =
    "Print Better lost track of this job at the printer, so it can't tell if everything printed. Check the printer.";
pub(crate) const STILL_PRINTING: &str =
    "The printer was still on this job after 2 hours, so Print Better stopped checking. Check the printer.";

/// Runs an IPP call with a deadline; a missed deadline counts as unreachable.
pub(crate) async fn timed<T>(call: impl Future<Output = Result<T>>) -> Result<T> {
    match tokio::time::timeout(CALL_TIMEOUT, call).await {
        Ok(result) => result,
        Err(_) => Err(Error::Unreachable("The printer stopped answering.".into())),
    }
}

fn transport(e: &Error) -> bool {
    matches!(e, Error::Unreachable(_) | Error::Io(_))
}

pub(crate) async fn follow(
    ipp: &IppClient,
    uri: &str,
    job: i32,
    route: RouteKind,
    expected: Option<Expected>,
    cancel: &CancelFlag,
    on_event: Events<'_>,
) -> Result<PrintOutcome> {
    let started = Instant::now();
    let mut answered = Instant::now();
    let mut errors = 0;
    let mut delay = FIRST_POLL;
    let mut pages = None;
    let mut last: Option<PrintEvent> = None;
    let mut printer: Option<(Instant, PrinterStatus)> = None;
    let mut emit = |event: PrintEvent| {
        if last.as_ref() != Some(&event) {
            on_event(event.clone());
            last = Some(event);
        }
    };
    let finished = |pages: Option<u32>, warning: &str| Ok(PrintOutcome { route, pages, warning: Some(warning.into()) });

    loop {
        tokio::select! {
            _ = cancel.canceled() => return cancel_job(ipp, uri, job, route, expected).await,
            _ = tokio::time::sleep(delay) => {}
        }
        delay = (delay * 2).min(MAX_POLL);
        let state = match timed(ipp.job_state(uri, job)).await {
            Ok(state) => state,
            Err(e) => {
                errors = if transport(&e) { errors } else { errors + 1 };
                if errors >= GONE_AFTER || answered.elapsed() > SILENCE_LIMIT {
                    log::info!("job {job} at {uri}: lost track ({e}); treating as done");
                    return finished(pages, LOST_TRACK);
                }
                continue;
            }
        };
        answered = Instant::now();
        errors = 0;
        pages = state.pages().or(pages);
        match state.state {
            JobStateKind::Completed => return Ok(PrintOutcome { pages, ..completed(&state, route, expected) }),
            JobStateKind::Canceled => return Err(Error::Canceled),
            JobStateKind::Aborted => return Err(Error::Rejected(reasons::aborted(&state))),
            JobStateKind::Processing => emit(PrintEvent::Printing { pages_done: state.pages() }),
            JobStateKind::Pending | JobStateKind::Held | JobStateKind::Stopped => {
                let stale = printer.as_ref().is_none_or(|(at, _)| at.elapsed() > PRINTER_CHECK);
                if stale && let Ok(attrs) = timed(ipp.get_printer_attributes(uri)).await {
                    printer = Some((Instant::now(), attrs.status));
                }
                emit(PrintEvent::Waiting { message: reasons::waiting(&state, printer.as_ref().map(|(_, s)| s)) });
            }
        }
        if started.elapsed() > FOLLOW_LIMIT {
            log::info!("job {job} at {uri}: still {:?} after the follow limit; treating as done", state.state);
            return finished(pages, STILL_PRINTING);
        }
    }
}

/// The outcome of a job the printer calls completed; the count it reports with that state is final.
fn completed(state: &IppJobState, route: RouteKind, expected: Option<Expected>) -> PrintOutcome {
    let warning = reasons::completed(state, expected.and_then(|e| e.shortfall(state)));
    PrintOutcome { route, pages: state.pages(), warning }
}

/// Cancels at the printer; a job that already finished is reported as completed.
async fn cancel_job(ipp: &IppClient, uri: &str, job: i32, route: RouteKind, expected: Option<Expected>) -> Result<PrintOutcome> {
    let _ = timed(ipp.cancel_job(uri, job)).await;
    match timed(ipp.job_state(uri, job)).await {
        Ok(state) if state.state == JobStateKind::Completed => Ok(completed(&state, route, expected)),
        _ => Err(Error::Canceled),
    }
}
