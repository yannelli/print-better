//! Printer and job state reasons turned into sentences a non-technical person understands.

use crate::ipp::{IppJobState, JobStateKind};
use crate::model::{PrinterState, PrinterStatus};

/// Most urgent first: when several apply, the first match is shown.
const PRINTER: &[(&str, &str)] = &[
    ("media-jam", "Paper is jammed in the printer."),
    ("media-empty", "The printer is out of paper."),
    ("media-needed", "The printer needs paper loaded."),
    ("door-open", "A door on the printer is open."),
    ("cover-open", "A cover on the printer is open."),
    ("interlock-open", "A cover on the printer is open."),
    ("toner-empty", "The printer is out of toner."),
    ("marker-supply-empty", "The printer is out of ink or toner."),
    ("input-tray-missing", "A paper tray is missing from the printer."),
    ("output-area-full", "The printer's output tray is full."),
    ("marker-waste-full", "The printer's waste ink or toner container is full."),
    ("fuser-over-temp", "The printer is too hot and is cooling down."),
    ("paused", "The printer is paused."),
    ("moving-to-paused", "The printer is pausing."),
    ("shutdown", "The printer is shutting down."),
    ("timed-out", "The printer isn't responding."),
    ("offline", "The printer is offline."),
    ("spool-area-full", "The printer's memory is full."),
    ("connecting-to-device", "The printer is connecting."),
    ("media-low", "The printer is low on paper."),
    ("toner-low", "The printer is low on toner."),
    ("marker-supply-low", "The printer is low on ink or toner."),
];

const JOB: &[(&str, &str)] = &[
    ("document-format-error", "The printer couldn't read the document."),
    ("document-unprintable-error", "The printer couldn't print this document."),
    ("document-access-error", "The printer couldn't open the document."),
    ("unsupported-document-format", "The printer doesn't support this kind of document."),
    ("aborted-by-system", "The printer canceled the job."),
    ("job-hold-until-specified", "The job is on hold at the printer."),
    ("job-held-for-authorization", "The job is waiting for sign-in at the printer."),
    ("printer-stopped", "The printer is stopped and needs attention."),
];

fn keyword(reason: &str) -> &str {
    ["-error", "-warning", "-report"].iter().find_map(|s| reason.strip_suffix(s)).unwrap_or(reason)
}

fn lookup(table: &[(&str, &'static str)], reasons: &[String]) -> Option<&'static str> {
    table.iter().find(|(key, _)| reasons.iter().any(|r| keyword(r) == *key)).map(|(_, text)| *text)
}

fn own_words(message: Option<&String>) -> Option<String> {
    message.map(|m| m.trim().to_string()).filter(|m| !m.is_empty())
}

/// What is wrong with the printer, if anything worth saying.
pub(crate) fn describe(status: &PrinterStatus) -> Option<String> {
    lookup(PRINTER, &status.reasons).map(str::to_string).or_else(|| own_words(status.message.as_ref()))
}

/// Why a job must not be sent now, or None when the printer can take it.
pub(crate) fn blocking(status: &PrinterStatus) -> Option<String> {
    match status.state {
        PrinterState::Stopped => Some(describe(status).unwrap_or_else(|| "The printer is stopped and needs attention.".into())),
        PrinterState::Offline => Some(describe(status).unwrap_or_else(|| "The printer is offline.".into())),
        _ => None,
    }
}

/// Why an accepted job hasn't finished yet.
pub(crate) fn waiting(job: &IppJobState, printer: Option<&PrinterStatus>) -> String {
    let from_printer = printer.and_then(describe);
    match job.state {
        JobStateKind::Held => lookup(JOB, &job.reasons).unwrap_or("The job is on hold at the printer.").into(),
        JobStateKind::Stopped => from_printer.unwrap_or_else(|| "The printer stopped. Check it for paper, jams, or error lights.".into()),
        _ => from_printer.unwrap_or_else(|| "Waiting for the printer to start the job.".into()),
    }
}

/// Why the printer gave up on a job it had accepted.
pub(crate) fn aborted(job: &IppJobState) -> String {
    lookup(JOB, &job.reasons)
        .map(str::to_string)
        .or_else(|| own_words(job.message.as_ref()))
        .unwrap_or_else(|| "The printer stopped the job before it finished.".into())
}
