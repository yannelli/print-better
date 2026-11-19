//! HP printers that default to two-sided can ignore `sides` on a PDF, so a job asking for other sides
//! goes out PJL-wrapped as an auto-detected document. Seen on a LaserJet Pro M404.

use super::{PDF, document, engine};
use crate::backends::tests::EventLog;
use crate::convert::tests::TestDir;
use crate::engine::CancelFlag;
use crate::ipp::tags::{group, op};
use crate::ipp::tests::mock::{MockPrinter, job_created, reply};
use crate::ipp::{Attribute, Value};
use crate::model::{Capabilities, JobOptions, PrinterReport, PrinterStatus, Route, RouteKind, Sides};

/// What one Print-Job carried: its document-format and the document bytes.
async fn sent(sides: Option<Sides>, formats: &[&str]) -> (String, Vec<u8>) {
    let dir = TestDir::new("pjl-sides");
    let formats: Vec<String> = formats.iter().map(|f| f.to_string()).collect();
    let printer = MockPrinter::start(move |req| match req.code {
        op::GET_PRINTER_ATTRIBUTES => {
            let attrs = vec![
                Attribute::new("printer-state", Value::Enum(3)),
                Attribute::many("document-format-supported", formats.iter().map(|f| Value::mime(f)).collect()),
                Attribute::many("sides-supported", ["one-sided", "two-sided-long-edge"].map(Value::keyword).to_vec()),
                Attribute::new("sides-default", Value::keyword("two-sided-long-edge")),
            ];
            reply(req, 0, vec![(group::PRINTER, attrs)])
        }
        op::PRINT_JOB => job_created(req, 0, 7, &[]),
        _ => reply(req, 0, vec![(group::JOB, vec![Attribute::new("job-state", Value::Enum(9))])]),
    })
    .await;
    let report = PrinterReport {
        key: "net:hp".into(),
        name: "LaserJet".into(),
        make_model: None,
        uuid: None,
        location: None,
        local: false,
        routes: vec![Route { kind: RouteKind::Ipp, uri: printer.uri.clone() }],
        capabilities: Capabilities::default(),
        status: PrinterStatus::default(),
    };
    let options = JobOptions { sides, ..JobOptions::default() };
    let outcome = engine(&dir).print(&report, &document(&dir, PDF), &options, &CancelFlag::default(), &EventLog::default().sink()).await;
    outcome.expect("printed");
    let seen = printer.seen();
    let job = seen.iter().find(|s| s.msg.code == op::PRINT_JOB).expect("a Print-Job");
    let format = job.msg.attr(group::OPERATION, "document-format").and_then(Attribute::str).unwrap_or_default().to_string();
    (format, job.doc.clone())
}

const HP: &[&str] = &["application/pdf", "application/vnd.hp-PCL", "application/octet-stream"];

#[tokio::test]
async fn one_sided_on_a_two_sided_hp_goes_out_with_pjl_duplex_off() {
    let (format, doc) = sent(Some(Sides::OneSided), HP).await;
    assert_eq!(format, "application/octet-stream");
    let text = String::from_utf8_lossy(&doc);
    assert!(text.starts_with("\x1b%-12345X@PJL JOB"), "{text}");
    assert!(text.contains("@PJL SET DUPLEX=OFF\r\n") && text.contains("@PJL ENTER LANGUAGE=PDF\r\n%PDF"), "{text}");
}

#[tokio::test]
async fn sides_the_printer_already_defaults_to_stay_plain_pdf() {
    for sides in [None, Some(Sides::TwoSidedLongEdge)] {
        let (format, doc) = sent(sides, HP).await;
        assert_eq!((format.as_str(), doc.as_slice()), ("application/pdf", PDF), "{sides:?}");
    }
}

#[tokio::test]
async fn a_printer_without_pjl_or_auto_detect_gets_plain_pdf() {
    for formats in [&["application/pdf", "application/octet-stream"][..], &["application/pdf", "application/vnd.hp-PCL"]] {
        let (format, doc) = sent(Some(Sides::OneSided), formats).await;
        assert_eq!((format.as_str(), doc.as_slice()), ("application/pdf", PDF), "{formats:?}");
    }
}
