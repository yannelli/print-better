//! HP printers print a PDF with their own duplex default whatever `sides` says (seen on a LaserJet Pro
//! M404), so the job's sides go in a PJL header around an auto-detected document.

use super::{PDF, document, engine};
use crate::backends::tests::EventLog;
use crate::convert::tests::TestDir;
use crate::engine::CancelFlag;
use crate::ipp::tags::{group, op};
use crate::ipp::tests::mock::{MockPrinter, job_created, reply};
use crate::ipp::{Attribute, Message, Value};
use crate::model::{Capabilities, JobOptions, PrinterReport, PrinterStatus, Route, RouteKind, Sides};

const HP: &str = "HP LaserJet Pro M404-M405";
const OTHER: &str = "Brother HL-L2350DW";
const PJL_AUTO: &[&str] = &["application/pdf", "application/vnd.hp-PCL", "application/octet-stream"];

/// The Print-Job a printer with `make_model` and `formats`, defaulting to two-sided, received.
async fn sent(make_model: &str, formats: &[&str], options: JobOptions) -> (String, Vec<String>, Vec<u8>) {
    let dir = TestDir::new("pjl-sides");
    let formats: Vec<String> = formats.iter().map(|f| f.to_string()).collect();
    let make_model = make_model.to_string();
    let printer = MockPrinter::start(move |req| match req.code {
        op::GET_PRINTER_ATTRIBUTES => {
            let attrs = vec![
                Attribute::new("printer-state", Value::Enum(3)),
                Attribute::new("printer-make-and-model", Value::text(&make_model)),
                Attribute::many("document-format-supported", formats.iter().map(|f| Value::mime(f)).collect()),
                Attribute::many("sides-supported", ["one-sided", "two-sided-long-edge"].map(Value::keyword).to_vec()),
                Attribute::new("sides-default", Value::keyword("two-sided-long-edge")),
                Attribute::new("copies-supported", Value::Range(1, 99)),
                Attribute::new("page-ranges-supported", Value::Boolean(true)),
            ];
            reply(req, 0, vec![(group::PRINTER, attrs)])
        }
        op::PRINT_JOB => job_created(req, 0, 7, &[]),
        _ => reply(req, 0, vec![(group::JOB, vec![Attribute::new("job-state", Value::Enum(9))])]),
    })
    .await;
    let report = PrinterReport {
        key: "net:laser".into(),
        name: "Laser".into(),
        make_model: None,
        uuid: None,
        location: None,
        local: false,
        routes: vec![Route { kind: RouteKind::Ipp, uri: printer.uri.clone() }],
        capabilities: Capabilities::default(),
        status: PrinterStatus::default(),
    };
    let outcome = engine(&dir).print(&report, &document(&dir, PDF), &options, &CancelFlag::default(), &EventLog::default().sink()).await;
    outcome.expect("printed");
    let seen = printer.seen();
    let job = &seen.iter().find(|s| s.msg.code == op::PRINT_JOB).expect("a Print-Job").msg;
    let format = job.attr(group::OPERATION, "document-format").and_then(Attribute::str).unwrap_or_default().to_string();
    let doc = seen.iter().find(|s| s.msg.code == op::PRINT_JOB).unwrap().doc.clone();
    (format, job_attrs(job), doc)
}

fn job_attrs(msg: &Message) -> Vec<String> {
    msg.groups.iter().filter(|g| g.tag == group::JOB).flat_map(|g| g.attrs.iter().map(|a| a.name.clone())).collect()
}

fn sides(sides: Sides) -> JobOptions {
    JobOptions { sides: Some(sides), ..JobOptions::default() }
}

fn wrapped(doc: &[u8], duplex: &str) -> bool {
    let text = String::from_utf8_lossy(doc);
    text.starts_with("\x1b%-12345X@PJL JOB") && text.contains(duplex) && text.contains("@PJL ENTER LANGUAGE=PDF\r\n%PDF")
}

#[tokio::test]
async fn an_hp_always_gets_the_sides_in_pjl() {
    let (format, _, doc) = sent(HP, PJL_AUTO, sides(Sides::OneSided)).await;
    assert_eq!(format, "application/octet-stream");
    assert!(wrapped(&doc, "@PJL SET DUPLEX=OFF\r\n"), "{}", String::from_utf8_lossy(&doc));
    let (format, _, doc) = sent(HP, PJL_AUTO, sides(Sides::TwoSidedLongEdge)).await;
    assert_eq!(format, "application/octet-stream", "even when it matches the printer's default");
    assert!(wrapped(&doc, "@PJL SET DUPLEX=ON\r\n@PJL SET BINDING=LONGEDGE\r\n"));
}

#[tokio::test]
async fn copies_and_pages_still_go_to_the_printer_as_attributes() {
    let options = JobOptions { copies: Some(2), page_ranges: Some("1".into()), ..sides(Sides::OneSided) };
    let (format, attrs, doc) = sent(HP, PJL_AUTO, options).await;
    assert_eq!(format, "application/octet-stream");
    assert!(attrs.contains(&"copies".to_string()) && attrs.contains(&"page-ranges".to_string()), "{attrs:?}");
    assert!(wrapped(&doc, "@PJL SET DUPLEX=OFF\r\n"), "the original PDF, not a raster");
}

#[tokio::test]
async fn no_sides_asked_leaves_the_pdf_plain() {
    let (format, _, doc) = sent(HP, PJL_AUTO, JobOptions::default()).await;
    assert_eq!((format.as_str(), doc.as_slice()), ("application/pdf", PDF));
}

#[tokio::test]
async fn other_pjl_printers_get_it_only_when_the_job_differs_from_their_default() {
    let (format, _, doc) = sent(OTHER, PJL_AUTO, sides(Sides::OneSided)).await;
    assert_eq!(format, "application/octet-stream");
    assert!(wrapped(&doc, "@PJL SET DUPLEX=OFF\r\n"));
    let (format, _, doc) = sent(OTHER, PJL_AUTO, sides(Sides::TwoSidedLongEdge)).await;
    assert_eq!((format.as_str(), doc.as_slice()), ("application/pdf", PDF));
}

#[tokio::test]
async fn a_printer_without_pjl_or_auto_detect_gets_plain_pdf() {
    for formats in [&["application/pdf", "application/octet-stream"][..], &["application/pdf", "application/vnd.hp-PCL"]] {
        let (format, _, doc) = sent(HP, formats, sides(Sides::OneSided)).await;
        assert_eq!((format.as_str(), doc.as_slice()), ("application/pdf", PDF), "{formats:?}");
    }
}
