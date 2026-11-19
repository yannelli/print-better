//! Following an accepted job on a scripted IPP printer: clean finishes, short prints the printer
//! doesn't admit, flagged jobs, and jobs Print Better loses track of.

use super::{document, engine};
use crate::backends::tests::EventLog;
use crate::convert::tests::TestDir;
use crate::convert::tests::pdfbuild::classic;
use crate::engine::expect::Expected;
use crate::engine::follow::{LOST_TRACK, STILL_PRINTING, follow};
use crate::engine::{CancelFlag, PrintOutcome};
use crate::ipp::tags::{group, op};
use crate::ipp::tests::mock::{Answer, MockPrinter, job_created, reply};
use crate::ipp::{Attribute, IppClient, Message, Value};
use crate::model::{Capabilities, JobOptions, PrinterReport, PrinterStatus, Route, RouteKind};

const SHORT: &str = "The printer stopped after 4 of 11 pages. It didn't report an error.";

/// A Get-Job-Attributes answer: job-state, then reasons and counters.
fn job(req: &Message, state: i32, reasons: &[&str], counts: &[(&str, i32)]) -> Answer {
    let mut attrs = vec![Attribute::new("job-state", Value::Enum(state))];
    if !reasons.is_empty() {
        attrs.push(Attribute::many("job-state-reasons", reasons.iter().map(|r| Value::keyword(r)).collect()));
    }
    attrs.extend(counts.iter().map(|(name, n)| Attribute::new(name, Value::Integer(*n))));
    reply(req, 0, vec![(group::JOB, attrs)])
}

async fn followed(script: impl Fn(&Message) -> Answer + Send + Sync + 'static, expected: Option<Expected>) -> PrintOutcome {
    let dir = TestDir::new("follow");
    let ipp = IppClient::new("pb-test", &dir.0);
    let printer = MockPrinter::start(script).await;
    let log = EventLog::default();
    follow(&ipp, &printer.uri, 7, RouteKind::Ipp, expected, &CancelFlag::default(), &log.sink()).await.expect("followed")
}

fn eleven() -> Option<Expected> {
    Expected::new(11, &JobOptions::default(), false)
}

#[tokio::test]
async fn a_short_print_the_printer_calls_completed_is_a_warning() {
    let counts = [("job-impressions-completed", 4), ("job-media-sheets-completed", 4)];
    let outcome = followed(move |req| job(req, 9, &["none"], &counts), eleven()).await;
    assert_eq!((outcome.pages, outcome.warning.as_deref()), (Some(4), Some(SHORT)));
}

#[tokio::test]
async fn a_full_print_is_a_clean_success() {
    let outcome = followed(|req| job(req, 9, &["job-completed-successfully"], &[("job-impressions-completed", 11)]), eleven()).await;
    assert_eq!(outcome, PrintOutcome { route: RouteKind::Ipp, pages: Some(11), warning: None });
    let uncounted = followed(|req| job(req, 9, &[], &[]), eleven()).await;
    assert_eq!(uncounted.warning, None, "no count is no evidence");
}

#[tokio::test]
async fn completed_with_errors_is_a_warning() {
    let reasons = ["job-completed-with-errors", "document-format-error"];
    let outcome = followed(move |req| job(req, 9, &reasons, &[]), None).await;
    assert_eq!(outcome.warning.as_deref(), Some("The printer couldn't read part of the document."));
}

#[tokio::test]
async fn losing_track_never_claims_it_printed() {
    let outcome = followed(|req| reply(req, 0x0500, Vec::new()), eleven()).await;
    assert_eq!(outcome.warning.as_deref(), Some(LOST_TRACK));
}

#[tokio::test]
async fn the_follow_limit_says_the_printer_was_still_going() {
    let outcome = followed(|req| job(req, 5, &["job-printing"], &[("job-impressions-completed", 2)]), eleven()).await;
    assert_eq!((outcome.pages, outcome.warning.as_deref()), (Some(2), Some(STILL_PRINTING)));
}

/// The reported case: an 11-page PDF sent as-is, and a printer that prints 4 and says completed.
#[tokio::test]
async fn print_counts_the_pdf_and_reports_the_short_print() {
    let dir = TestDir::new("follow-print");
    let printer = MockPrinter::start(|req| match req.code {
        op::GET_PRINTER_ATTRIBUTES => {
            let attrs = vec![
                Attribute::new("printer-state", Value::Enum(3)),
                Attribute::new("document-format-supported", Value::mime("application/pdf")),
            ];
            reply(req, 0, vec![(group::PRINTER, attrs)])
        }
        op::PRINT_JOB => job_created(req, 0, 7, &[]),
        _ => job(req, 9, &["none"], &[("job-impressions-completed", 4), ("job-media-sheets-completed", 4)]),
    })
    .await;
    let report = PrinterReport {
        key: "net:short".into(),
        name: "Short printer".into(),
        make_model: None,
        uuid: None,
        location: None,
        local: false,
        routes: vec![Route { kind: RouteKind::Ipp, uri: printer.uri.clone() }],
        capabilities: Capabilities::default(),
        status: PrinterStatus::default(),
    };
    let doc = document(&dir, &classic(11));
    let log = EventLog::default();
    let outcome = engine(&dir).print(&report, &doc, &JobOptions::default(), &CancelFlag::default(), &log.sink()).await;
    assert_eq!(outcome.expect("completed").warning.as_deref(), Some(SHORT));
    assert_eq!(printer.ops().iter().filter(|&&o| o == op::PRINT_JOB).count(), 1, "sent once");
}
