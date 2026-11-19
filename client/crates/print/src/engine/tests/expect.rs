//! Expected page counts, and the warnings for jobs the printer calls completed.

use crate::engine::expect::{Expected, two_sided};
use crate::engine::reasons;
use crate::ipp::{IppJobState, JobStateKind, PrinterAttrs};
use crate::model::{Capabilities, JobOptions, Sides};

fn options(copies: Option<u32>, ranges: Option<&str>) -> JobOptions {
    JobOptions { copies, page_ranges: ranges.map(str::to_string), ..JobOptions::default() }
}

fn expect(pages: u32, copies: Option<u32>, ranges: Option<&str>, two: bool) -> Option<(u32, u32)> {
    Expected::new(pages, &options(copies, ranges), two).map(|e| (e.impressions, e.sheets))
}

fn ended(state: JobStateKind, impressions: Option<u32>, sheets: Option<u32>, reasons: &[&str]) -> IppJobState {
    let reasons = reasons.iter().map(|r| r.to_string()).collect();
    IppJobState { state, reasons, message: None, impressions, sheets }
}

fn done(impressions: Option<u32>, sheets: Option<u32>, reasons: &[&str]) -> IppJobState {
    ended(JobStateKind::Completed, impressions, sheets, reasons)
}

#[test]
fn copies_and_page_ranges() {
    assert_eq!(expect(11, None, None, false), Some((11, 11)));
    assert_eq!(expect(11, Some(3), None, false), Some((33, 33)));
    assert_eq!(expect(11, Some(2), Some("1-3, 5, 10-"), false), Some((12, 12)), "6 pages, twice");
    assert_eq!(expect(11, None, Some("2-4,3-6"), false), Some((5, 5)), "overlaps count once");
    assert_eq!(expect(11, None, Some(" "), false), Some((11, 11)), "a blank selection is all pages");
    assert_eq!(expect(4, None, Some("9-12"), false), None, "nothing selected");
    assert_eq!(expect(11, None, Some("3-1"), false), None, "a range the printer can't take");
}

#[test]
fn two_sided_jobs_count_sheets_per_copy() {
    assert_eq!(expect(11, Some(2), None, true), Some((22, 12)));
    assert_eq!(expect(11, Some(2), Some("1-3"), true), Some((6, 4)));
    assert_eq!(expect(1, None, None, true), Some((1, 1)));
}

#[test]
fn two_sided_follows_the_job_then_the_printer_default() {
    let duplex = PrinterAttrs {
        capabilities: Capabilities { duplex: true, ..Capabilities::default() },
        sides_default: Some(Sides::OneSided),
        ..PrinterAttrs::default()
    };
    assert!(two_sided(Some(Sides::TwoSidedLongEdge), &duplex));
    assert!(!two_sided(None, &duplex));
    let defaults_two = PrinterAttrs { sides_default: Some(Sides::TwoSidedLongEdge), ..duplex.clone() };
    assert!(two_sided(None, &defaults_two), "the job doesn't ask, the printer defaults to two-sided");
    assert!(!two_sided(Some(Sides::OneSided), &defaults_two));
    assert!(!two_sided(Some(Sides::TwoSidedShortEdge), &PrinterAttrs::default()), "a printer that can't, doesn't");
}

#[test]
fn shortfalls_compare_impressions_or_else_sheets() {
    let eleven = Expected::new(11, &JobOptions::default(), false).unwrap();
    let short = |job: IppJobState| eleven.shortfall(&job);
    assert_eq!(short(done(Some(4), Some(4), &[])).as_deref(), Some("The printer stopped after 4 of 11 pages."));
    assert_eq!(short(done(Some(11), Some(11), &[])), None);
    assert_eq!(short(done(Some(12), None, &[])), None, "more than expected isn't a short print");
    assert_eq!(short(done(Some(0), Some(0), &[])), None, "0 means the printer doesn't count");
    assert_eq!(short(done(None, None, &[])), None);

    let duplex = Expected::new(11, &options(Some(2), None), true).unwrap();
    assert_eq!(duplex.shortfall(&done(None, Some(12), &[])), None, "12 sheets is all of it");
    assert_eq!(duplex.shortfall(&done(None, Some(5), &[])).as_deref(), Some("The printer stopped after 5 of 12 sheets."));
    let impressions_win = duplex.shortfall(&done(Some(21), Some(12), &[]));
    assert_eq!(impressions_win.as_deref(), Some("The printer stopped after 21 of 22 pages."));
}

#[test]
fn completed_jobs_warn_in_plain_words() {
    let short = || Some("The printer stopped after 4 of 11 pages.".to_string());
    let warn = |job: IppJobState, shortfall: Option<String>| reasons::completed(&job, shortfall);
    let quiet = warn(done(Some(4), None, &[]), short());
    assert_eq!(quiet.as_deref(), Some("The printer stopped after 4 of 11 pages. It didn't report an error."));
    let both = warn(done(Some(4), None, &["document-unprintable-error"]), short());
    assert_eq!(both.as_deref(), Some("The printer stopped after 4 of 11 pages. The printer couldn't print part of the document."));
    let flagged = warn(done(None, None, &["job-completed-with-errors", "document-format-error"]), None);
    assert_eq!(flagged.as_deref(), Some("The printer couldn't read part of the document."), "the specific reason wins");
    let warned = warn(done(None, None, &["job-completed-with-warnings"]), None);
    assert_eq!(warned.as_deref(), Some("The printer reported a problem while printing."));
    assert_eq!(warn(done(None, None, &["document-access-error"]), None).as_deref(), Some("The printer couldn't open part of the document."));
    assert_eq!(warn(done(Some(11), None, &["job-completed-successfully"]), None), None);
}

#[test]
fn aborted_jobs_name_document_errors() {
    let job = ended(JobStateKind::Aborted, None, None, &["document-format-error"]);
    assert_eq!(reasons::aborted(&job), "The printer couldn't read the document.");
}
