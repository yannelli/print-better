use super::{Harness, LABEL, PDF, Sink, ipp, laser, request};
use crate::error::Error;
use crate::ipp::tags::{group, op, status};
use crate::ipp::tests::TempDir;
use crate::ipp::{Attribute, IppBody, IppJob, Value};
use crate::model::{JobOptions, Quality, Supply, SupplyKind};
use crate::share::{ShareOptions, ShareServer, SharedPrinter, printer_path};
use std::sync::Arc;

const SERVER_TYPES: &[&str] = &["application/pdf", "image/jpeg", "image/png"];

#[tokio::test]
async fn a_loopback_instance_listens_on_localhost_and_is_never_advertised() {
    let spool = TempDir::new("share-loopback");
    let opts = ShareOptions {
        port: 0,
        spool_dir: spool.path().to_path_buf(),
        host_label: LABEL.into(),
        loopback_only: true,
        formats: Some(SERVER_TYPES),
    };
    let server = ShareServer::start(opts, Arc::new(Sink::default())).await.unwrap();
    let addr = server.local_addr().unwrap();
    assert!(addr.ip().is_loopback() && addr.port() != 0, "{addr}");
    assert!(server.advertiser.lock().unwrap().is_none());
    server.stop().await;
}

#[tokio::test]
async fn fixed_formats_replace_what_the_printer_could_take() {
    let h = Harness::with_formats(Some(SERVER_TYPES)).await;
    let a = h.ipp.get_printer_attributes(&h.uri()).await.unwrap();
    let offered: Vec<&str> = a.capabilities.formats.iter().map(String::as_str).filter(|f| *f != "application/octet-stream").collect();
    assert_eq!(offered, SERVER_TYPES);
    let urf = IppJob { name: "Scan".into(), user: "alice".into(), format: "image/urf".into(), options: JobOptions::default() };
    let refused = h.ipp.print_job(&h.uri(), &urf, IppBody::Bytes(b"UNIRAST\0".to_vec())).await;
    assert!(matches!(refused, Err(Error::Unsupported(_))), "{refused:?}");
    let pdf = IppJob { format: "application/pdf".into(), ..urf };
    h.ipp.print_job(&h.uri(), &pdf, IppBody::Bytes(PDF.to_vec())).await.unwrap();
    assert_eq!(h.sink.jobs().len(), 1);
}

#[tokio::test]
async fn printer_path_is_where_the_printer_is_served() {
    let h = Harness::start().await;
    assert_eq!(printer_path(&laser().key), h.path());
}

const PAGE: &str = "https://print.example.com/w/ws_01/printers/pr_07";

/// The laser as another device's printer: trays, paper types, two qualities, toner, and its web page.
fn remote_laser() -> SharedPrinter {
    let mut p = laser();
    let caps = &mut p.report.capabilities;
    caps.sources = ["tray-1", "tray-2", "auto"].map(String::from).to_vec();
    caps.media_types = ["stationery", "com.example.glossy", "labels"].map(String::from).to_vec();
    caps.qualities = vec![Quality::Normal, Quality::High];
    let toner = Supply { name: "black cartridge".into(), kind: SupplyKind::Toner, color: Some("#000000".into()), level: 73 };
    p.report.status.supplies = vec![toner];
    p.info_url = Some(PAGE.into());
    p
}

async fn remote() -> Harness {
    let h = Harness::with_formats(Some(SERVER_TYPES)).await;
    h.server.as_ref().unwrap().set_printers(vec![remote_laser()]);
    h
}

#[tokio::test]
async fn a_loopback_printer_offers_what_the_remote_one_has_and_its_supplies() {
    let h = remote().await;
    let g = h.ipp.printer_group(&h.uri(), &["all"]).await.unwrap();
    let strs = |name: &str| g.get(name).map(|a| a.strs().map(String::from).collect::<Vec<_>>()).unwrap_or_default();
    let ints = |name: &str| g.get(name).map(|a| a.ints().collect::<Vec<_>>()).unwrap_or_default();
    assert_eq!(strs("media-source-supported"), ["tray-1", "tray-2", "auto"]);
    assert_eq!(strs("media-type-supported"), ["stationery", "labels"], "CUPS has no label for vendor types");
    assert_eq!((ints("print-quality-supported"), ints("print-quality-default")), (vec![4, 5], vec![4]));
    assert_eq!((strs("printer-more-info"), strs("printer-supply-info-uri")), (vec![PAGE.to_string()], vec![PAGE.to_string()]));
    assert_eq!((strs("marker-names"), ints("marker-levels")), (vec!["black cartridge".to_string()], vec![73]));
    assert!(!strs("urf-supported").is_empty(), "macOS reads supply levels only from printers that list it");
    assert!(!strs("document-format-supported").iter().any(|f| f == "image/urf"), "yet URF is never sent");
    let col = g.get("media-col-default").and_then(|a| a.values.first()?.as_collection()).unwrap();
    let member = |name| crate::ipp::value::find(col, name).and_then(Attribute::str);
    assert_eq!((member("media-source"), member("media-type")), (Some("auto"), Some("stationery")));
}

#[tokio::test]
async fn a_tray_and_paper_type_picked_in_the_print_dialog_reach_the_job() {
    let h = remote().await;
    let mut msg = request(op::PRINT_JOB, &h.uri());
    msg.operation().push("document-format", Value::mime("application/pdf"));
    let size = [("x-dimension", 21590), ("y-dimension", 27940)].map(|(n, v)| Attribute::new(n, Value::Integer(v))).to_vec();
    let col = vec![
        Attribute::new("media-size", Value::Collection(size)),
        Attribute::new("media-source", Value::keyword("tray-2")),
        Attribute::new("media-type", Value::keyword("labels")),
    ];
    msg.group_mut(group::JOB).attrs = vec![Attribute::new("media-col", Value::Collection(col))];
    assert_eq!(ipp(&h, &msg, PDF).await.code, status::OK);
    let o = h.sink.jobs()[0].options.clone();
    assert_eq!((o.media.as_deref(), o.source.as_deref(), o.media_type.as_deref()), (Some("na_letter_8.5x11in"), Some("tray-2"), Some("labels")));
}

#[tokio::test]
async fn a_cups_command_file_is_refused_and_never_becomes_a_job() {
    let h = remote().await;
    for format in ["application/vnd.cups-command", "application/octet-stream"] {
        let mut msg = request(op::PRINT_JOB, &h.uri());
        msg.operation().push("document-format", Value::mime(format));
        let reply = ipp(&h, &msg, b"#CUPS-COMMAND\nReportLevels\n").await;
        assert_eq!(reply.code, status::DOCUMENT_FORMAT_NOT_SUPPORTED, "{format}");
    }
    assert!(h.sink.jobs().is_empty());
}
