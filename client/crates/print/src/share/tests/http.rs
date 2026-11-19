use super::{Harness, PDF, exchange, ipp, post_head, request};
use crate::ipp::tags::{group, op, status};
use crate::ipp::{Attribute, Value};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

fn get_head(path: &str, host: &str) -> String {
    format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")
}

#[tokio::test]
async fn only_printer_paths_exist_and_only_post_is_allowed() {
    let h = Harness::start().await;
    let host = h.addr.to_string();
    for path in ["/", "/ipp/print", "/ipp/print/", "/printers/x"] {
        assert_eq!(exchange(h.addr, get_head(path, &host), Vec::new()).await.0, 404, "{path}");
    }
    let (code, head, _) = exchange(h.addr, get_head(&h.path(), &host), Vec::new()).await;
    assert_eq!(code, 405);
    assert!(head.to_ascii_lowercase().contains("allow: post"), "{head}");
}

#[tokio::test]
async fn non_ipp_bodies_are_rejected_before_parsing() {
    let h = Harness::start().await;
    let host = h.addr.to_string();
    let body = request(op::GET_PRINTER_ATTRIBUTES, &h.uri()).encode();
    let wrong_type = post_head(&h.path(), &host, "application/json", body.len());
    assert_eq!(exchange(h.addr, wrong_type, body).await.0, 415);
    let garbage = b"\x02\x00\x00\x0b\x00\x00\x00\x01\x01\x47\xff\xff".to_vec();
    assert_eq!(exchange(h.addr, post_head(&h.path(), &host, "application/ipp", garbage.len()), garbage).await.0, 400);
    let cut = request(op::GET_PRINTER_ATTRIBUTES, &h.uri()).encode()[..20].to_vec();
    assert_eq!(exchange(h.addr, post_head(&h.path(), &host, "application/ipp", cut.len()), cut).await.0, 400);
}

#[tokio::test]
async fn printer_uris_use_the_host_the_client_dialed() {
    let h = Harness::start().await;
    let uri_seen = |host: &str| {
        let body = request(op::GET_PRINTER_ATTRIBUTES, &h.uri()).encode();
        let head = post_head(&h.path(), host, "application/ipp", body.len());
        async move {
            let (code, _, reply) = exchange(h.addr, head, body).await;
            assert_eq!(code, 200);
            let msg = crate::ipp::Message::decode(&reply).unwrap().0;
            msg.attr(group::PRINTER, "printer-uri-supported").and_then(Attribute::str).map(str::to_string)
        }
    };
    let slug = h.served().slug;
    assert_eq!(uri_seen("office-mac.local:8631").await.as_deref(), Some(&*format!("ipp://office-mac.local:8631/ipp/print/{slug}")));
    let fallback = format!("ipp://{}/ipp/print/{slug}", h.addr);
    assert_eq!(uri_seen("evil/../x y").await.as_deref(), Some(&*fallback), "an unusable Host falls back to the socket address");
}

#[tokio::test]
async fn an_oversized_document_is_refused_and_not_kept() {
    let h = Harness::start().await;
    let mut msg = request(op::PRINT_JOB, &h.uri());
    msg.operation().push("document-format", Value::mime("application/pdf"));
    let mut doc = PDF.to_vec();
    doc.resize((1 << 20) + 1, b' ');
    assert_eq!(ipp(&h, &msg, &doc).await.code, status::TOO_LARGE);
    assert!(h.sink.jobs().is_empty());
    assert!(h.spooled_after_cleanup().await.is_empty());
}

#[tokio::test]
async fn an_abandoned_upload_leaves_no_spool_file() {
    let h = Harness::start().await;
    let mut msg = request(op::PRINT_JOB, &h.uri());
    msg.operation().push("document-format", Value::mime("application/pdf"));
    let head_bytes = [msg.encode(), PDF.to_vec()].concat();
    let mut tcp = TcpStream::connect(h.addr).await.unwrap();
    let head = post_head(&h.path(), &h.addr.to_string(), "application/ipp", head_bytes.len() + 4096);
    tcp.write_all(head.as_bytes()).await.unwrap();
    tcp.write_all(&head_bytes).await.unwrap();
    // Let the server start spooling, then hang up mid-document.
    tokio::time::sleep(Duration::from_millis(200)).await;
    drop(tcp);
    assert!(h.spooled_after_cleanup().await.is_empty());
    assert!(h.sink.jobs().is_empty());
}
