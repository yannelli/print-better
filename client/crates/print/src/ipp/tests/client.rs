use super::TempDir;
use super::mock::{Answer, MockPrinter, job_created, reply};
use crate::error::Error;
use crate::ipp::tags::{group, op};
use crate::ipp::{Attribute, IppBody, IppClient, IppJob, JobStateKind, Message, Value};
use crate::model::{ColorMode, JobOptions, Sides};
use hyper::StatusCode;

const PDF: &[u8] = b"%PDF-1.7 not really a document";
const UUID: &str = "11111111-2222-3333-4444-555555555555";

fn client() -> (TempDir, IppClient) {
    let dir = TempDir::new("ipp-client");
    let ipp = IppClient::new("pb-test", dir.path());
    (dir, ipp)
}

fn job(options: JobOptions) -> IppJob {
    IppJob { name: "Quarterly report".into(), user: "alice".into(), format: "application/pdf".into(), options }
}

/// Get-Printer-Attributes reply for a monochrome duplex printer.
fn supported(req: &Message, page_ranges: bool) -> Answer {
    let keywords = |name: &str, v: &[&str]| Attribute::many(name, v.iter().map(|k| Value::keyword(k)).collect());
    let attrs = vec![
        Attribute::new("printer-uuid", Value::uri(&format!("urn:uuid:{UUID}"))),
        Attribute::new("copies-supported", Value::Range(1, 99)),
        keywords("media-supported", &["na_letter_8.5x11in", "iso_a4_210x297mm"]),
        keywords("sides-supported", &["one-sided", "two-sided-long-edge"]),
        keywords("print-color-mode-supported", &["monochrome"]),
        Attribute::new("page-ranges-supported", Value::Boolean(page_ranges)),
    ];
    reply(req, 0, vec![(group::PRINTER, attrs)])
}

fn job_attrs(msg: &Message) -> Vec<String> {
    msg.group(group::JOB).map(|g| g.attrs.iter().map(|a| a.name.clone()).collect()).unwrap_or_default()
}

fn text(msg: &Message, name: &str) -> Option<String> {
    msg.attr(group::OPERATION, name).and_then(Attribute::str).map(str::to_string)
}

async fn print(ipp: &IppClient, printer: &MockPrinter, options: JobOptions) -> Result<i32, Error> {
    ipp.print_job(&printer.uri, &job(options), IppBody::Bytes(PDF.to_vec())).await
}

fn ranges(r: &str) -> JobOptions {
    JobOptions { copies: Some(2), media: Some("iso_a4_210x297mm".into()), page_ranges: Some(r.into()), ..JobOptions::default() }
}

#[tokio::test]
async fn print_job_sends_supported_options_and_the_document() {
    let (_dir, ipp) = client();
    let printer = MockPrinter::start(|req| match req.code {
        op::GET_PRINTER_ATTRIBUTES => supported(req, true),
        _ => job_created(req, 0, 77, &[]),
    })
    .await;
    let options = JobOptions { sides: Some(Sides::TwoSidedLongEdge), color_mode: Some(ColorMode::Color), ..ranges("2-3") };
    assert_eq!(print(&ipp, &printer, options).await.unwrap(), 77);
    assert_eq!(printer.ops(), [op::GET_PRINTER_ATTRIBUTES, op::PRINT_JOB]);
    let seen = printer.seen();
    let sent = &seen[1];
    assert_eq!(sent.doc, PDF);
    assert_eq!(job_attrs(&sent.msg), ["copies", "media", "sides", "page-ranges"], "color is not supported, so not sent");
    assert_eq!(text(&sent.msg, "requesting-user-name").as_deref(), Some("alice"));
    assert_eq!(text(&sent.msg, "job-name").as_deref(), Some("Quarterly report"));
    assert_eq!(text(&sent.msg, "document-format").as_deref(), Some("application/pdf"));
    assert_eq!(text(&sent.msg, "printer-uri"), Some(printer.uri.clone()));
    assert!(sent.msg.attr(group::OPERATION, "ipp-attribute-fidelity").is_none());
}

#[tokio::test]
async fn refused_options_are_resent_without_the_named_ones() {
    let (_dir, ipp) = client();
    let printer = MockPrinter::start(|req| match req.code {
        op::GET_PRINTER_ATTRIBUTES => supported(req, true),
        _ if job_attrs(req).iter().any(|n| n == "media") => {
            reply(req, 0x040B, vec![(group::UNSUPPORTED, vec![Attribute::new("media", Value::keyword("iso_a4_210x297mm"))])])
        }
        _ => job_created(req, 0, 5, &[]),
    })
    .await;
    assert_eq!(print(&ipp, &printer, ranges("1")).await.unwrap(), 5);
    let seen = printer.seen();
    assert_eq!(seen.len(), 3);
    assert_eq!(job_attrs(&seen[2].msg), ["copies", "page-ranges"]);
    assert_eq!(seen[2].doc, PDF);
}

#[tokio::test]
async fn refused_page_ranges_fail_the_route_without_a_resend() {
    let (_dir, ipp) = client();
    let printer = MockPrinter::start(|req| match req.code {
        op::GET_PRINTER_ATTRIBUTES => supported(req, true),
        _ => reply(req, 0x040B, vec![(group::UNSUPPORTED, vec![Attribute::new("page-ranges", Value::Range(1, 1))])]),
    })
    .await;
    assert!(matches!(print(&ipp, &printer, ranges("1")).await, Err(Error::Unsupported(_))));
    assert_eq!(printer.ops(), [op::GET_PRINTER_ATTRIBUTES, op::PRINT_JOB]);
}

#[tokio::test]
async fn ignored_page_ranges_cancel_the_job() {
    for (cancel_status, wanted) in [(0, "so the job was canceled"), (0x0507, "canceling failed")] {
        let (_dir, ipp) = client();
        let printer = MockPrinter::start(move |req| match req.code {
            op::GET_PRINTER_ATTRIBUTES => supported(req, true),
            op::PRINT_JOB => job_created(req, 0x0001, 9, &["page-ranges"]),
            _ => reply(req, cancel_status, Vec::new()),
        })
        .await;
        match print(&ipp, &printer, ranges("1-2")).await {
            Err(Error::Rejected(m)) => assert!(m.contains("ignored the page selection") && m.contains(wanted), "{m}"),
            other => panic!("expected Rejected, got {other:?}"),
        }
        let seen = printer.seen();
        let cancel = &seen[2].msg;
        assert_eq!(cancel.code, op::CANCEL_JOB);
        assert_eq!(cancel.attr(group::OPERATION, "job-id").and_then(Attribute::int), Some(9));
        assert_eq!(text(cancel, "requesting-user-name").as_deref(), Some("alice"));
    }
}

#[tokio::test]
async fn ignored_copies_only_warn() {
    let (_dir, ipp) = client();
    let printer = MockPrinter::start(|req| match req.code {
        op::GET_PRINTER_ATTRIBUTES => supported(req, true),
        _ => job_created(req, 0x0001, 9, &["copies"]),
    })
    .await;
    assert_eq!(print(&ipp, &printer, ranges("1")).await.unwrap(), 9);
    assert_eq!(printer.ops(), [op::GET_PRINTER_ATTRIBUTES, op::PRINT_JOB]);
}

#[tokio::test]
async fn options_that_cannot_be_honored_send_no_job() {
    let (_dir, ipp) = client();
    let printer = MockPrinter::start(|req| supported(req, false)).await;
    assert!(matches!(print(&ipp, &printer, ranges("1")).await, Err(Error::Unsupported(_))));
    let copies = JobOptions { copies: Some(200), ..JobOptions::default() };
    assert!(matches!(print(&ipp, &printer, copies).await, Err(Error::Unsupported(_))));
    assert_eq!(printer.ops(), [op::GET_PRINTER_ATTRIBUTES, op::GET_PRINTER_ATTRIBUTES]);
}

#[tokio::test]
async fn ipp_1_1_fallback_is_remembered_per_printer() {
    let (_dir, ipp) = client();
    let printer = MockPrinter::start(|req| if req.version == (2, 0) { reply(req, 0x0503, Vec::new()) } else { supported(req, true) }).await;
    ipp.get_printer_attributes(&printer.uri).await.unwrap();
    ipp.get_printer_attributes(&printer.uri).await.unwrap();
    let versions: Vec<(u8, u8)> = printer.seen().iter().map(|s| s.msg.version).collect();
    assert_eq!(versions, [(2, 0), (1, 1), (1, 1)]);
}

#[tokio::test]
async fn purged_jobs_read_as_completed() {
    let (_dir, ipp) = client();
    let printer = MockPrinter::start(|req| match req.attr(group::OPERATION, "job-id").and_then(Attribute::int) {
        Some(1) => reply(req, 0x0406, Vec::new()),
        Some(2) => reply(req, 0x0407, Vec::new()),
        _ => {
            let job = vec![Attribute::new("job-state", Value::Enum(5)), Attribute::new("job-impressions-completed", Value::Integer(3))];
            reply(req, 0, vec![(group::JOB, job)])
        }
    })
    .await;
    for id in [1, 2] {
        let s = ipp.job_state(&printer.uri, id).await.unwrap();
        assert_eq!((s.state, s.pages()), (JobStateKind::Completed, None), "job {id}");
    }
    let s = ipp.job_state(&printer.uri, 3).await.unwrap();
    assert_eq!((s.state, s.pages()), (JobStateKind::Processing, Some(3)));
}

#[derive(Clone, Copy, Debug)]
enum Failure {
    Http(u16),
    Garbage,
    Hangup,
}

fn fail(how: Failure) -> Answer {
    match how {
        Failure::Http(code) => Answer::Http(StatusCode::from_u16(code).unwrap()),
        Failure::Garbage => Answer::Raw(b"<html>not ipp</html>".to_vec()),
        Failure::Hangup => Answer::Hangup,
    }
}

#[tokio::test]
async fn failures_without_a_document_keep_their_transport_meaning() {
    let (_dir, ipp) = client();
    for how in [Failure::Http(404), Failure::Http(503), Failure::Http(500), Failure::Garbage, Failure::Hangup] {
        let printer = MockPrinter::start(move |_| fail(how)).await;
        let got = ipp.get_printer_attributes(&printer.uri).await.map(|_| ());
        let ok = match how {
            Failure::Http(404) => matches!(got, Err(Error::Rejected(_))),
            Failure::Http(503) => matches!(got, Err(Error::NotReady(_))),
            Failure::Hangup => matches!(got, Err(Error::Unreachable(_))),
            _ => matches!(got, Err(Error::Protocol(_))),
        };
        assert!(ok, "{how:?} -> {got:?}");
    }
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let got = ipp.get_printer_attributes(&format!("ipp://{closed}/ipp/print")).await;
    assert!(matches!(got, Err(Error::Unreachable(_))), "{:?}", got.map(|_| ()));
}

#[tokio::test]
async fn print_job_failures_after_sending_may_have_printed() {
    let (_dir, ipp) = client();
    let cases = [Some(Failure::Hangup), Some(Failure::Garbage), None];
    for how in cases {
        let printer = MockPrinter::start(move |req| match (req.code, how) {
            (op::GET_PRINTER_ATTRIBUTES, _) => supported(req, true),
            (_, Some(how)) => fail(how),
            (_, None) => reply(req, 0, Vec::new()),
        })
        .await;
        match print(&ipp, &printer, JobOptions::default()).await {
            Err(Error::Rejected(m)) => assert!(m.contains("may have printed"), "{how:?}: {m}"),
            other => panic!("{how:?}: expected Rejected, got {other:?}"),
        }
        assert_eq!(printer.ops().len(), 2, "{how:?}: never resent");
    }
    let busy = MockPrinter::start(|req| if req.code == op::PRINT_JOB { reply(req, 0x0506, Vec::new()) } else { supported(req, true) }).await;
    assert!(matches!(print(&ipp, &busy, JobOptions::default()).await, Err(Error::NotReady(_))), "an explicit refusal is retryable");
}

#[tokio::test]
async fn cancel_identify_and_uuid_binding() {
    let (dir, ipp) = client();
    let printer = MockPrinter::start(|req| match req.code {
        op::GET_PRINTER_ATTRIBUTES => supported(req, true),
        _ => reply(req, 0, Vec::new()),
    })
    .await;
    ipp.cancel_job(&printer.uri, 12).await.unwrap();
    ipp.identify(&printer.uri).await.unwrap();
    let attrs = ipp.get_printer_attributes(&printer.uri).await.unwrap();
    assert_eq!(attrs.uuid.as_deref(), Some(UUID));
    assert_eq!(printer.ops(), [op::CANCEL_JOB, op::IDENTIFY_PRINTER, op::GET_PRINTER_ATTRIBUTES]);
    assert_eq!(printer.seen()[0].msg.attr(group::OPERATION, "job-id").and_then(Attribute::int), Some(12));
    let pins: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.path().join("ipps-pins.json")).unwrap()).unwrap();
    let authority = printer.uri.trim_start_matches("ipp://").trim_end_matches("/ipp/print");
    assert_eq!(pins["hosts"][authority], UUID, "the address is bound to the printer's uuid");
}
