use super::{Harness, LABEL, PDF, Sink, laser};
use crate::error::Error;
use crate::ipp::tests::TempDir;
use crate::ipp::{IppBody, IppJob};
use crate::model::JobOptions;
use crate::share::{ShareOptions, ShareServer, printer_path};
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
