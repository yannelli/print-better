//! Route fallthrough: unreachable or unusable routes give way to the next one; anything that may
//! have reached the printer stops the walk.

mod expect;
mod follow;
mod pjl;

use super::{CancelFlag, Engine, EngineOptions, PrintOutcome};
use crate::backends::tests::{EventLog, closed_port, connected_within, drop_after, listener, read_all, stall};
use crate::convert::tests::TestDir;
use crate::error::Error;
use crate::model::{Capabilities, DocFormat, Document, JobOptions, PrinterReport, PrinterStatus, Route, RouteKind};
use std::time::Duration;

const PDF: &[u8] = b"%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n";

fn engine(dir: &TestDir) -> Engine {
    Engine::new(EngineOptions { user_agent: "pb-test".into(), requesting_user: "tester".into(), state_dir: dir.0.clone() })
}

fn printer(routes: Vec<String>) -> PrinterReport {
    PrinterReport {
        key: "net:test".into(),
        name: "Test printer".into(),
        make_model: None,
        uuid: None,
        location: None,
        local: false,
        routes: routes.into_iter().map(|uri| Route { kind: RouteKind::Socket, uri }).collect(),
        capabilities: Capabilities {
            formats: vec!["application/pdf".into(), "application/vnd.hp-PCL".into()],
            ..Capabilities::default()
        },
        status: PrinterStatus::default(),
    }
}

fn socket(port: u16) -> String {
    format!("socket://127.0.0.1:{port}")
}

fn document(dir: &TestDir, body: &[u8]) -> Document {
    Document { path: dir.file("doc.pdf", body), format: DocFormat::Pdf, name: "Engine test".into() }
}

#[tokio::test]
async fn unreachable_and_malformed_routes_fall_through() {
    let dir = TestDir::new("engine-fallthrough");
    let (live, port) = listener().await;
    let server = tokio::spawn(read_all(live));
    let p = printer(vec![socket(closed_port().await), "socket://".into(), socket(port)]);
    let log = EventLog::default();
    let outcome = engine(&dir).print(&p, &document(&dir, PDF), &JobOptions::default(), &CancelFlag::default(), &log.sink()).await;
    assert_eq!(outcome.expect("third route prints"), PrintOutcome { route: RouteKind::Socket, pages: None, warning: None });
    let sent = server.await.expect("server");
    assert!(sent.starts_with(b"\x1b%-12345X@PJL JOB NAME=\"Engine test\"") && sent.windows(PDF.len()).any(|w| w == PDF));
}

#[tokio::test]
async fn a_route_that_may_have_printed_stops_the_walk() {
    let dir = TestDir::new("engine-rejected");
    let (dropper, first) = listener().await;
    let (spare, second) = listener().await;
    let server = tokio::spawn(drop_after(dropper, 64 * 1024));
    let mut big = PDF.to_vec();
    big.resize(16 << 20, b' ');
    let p = printer(vec![socket(first), socket(second)]);
    let result = engine(&dir).print(&p, &document(&dir, &big), &JobOptions::default(), &CancelFlag::default(), &EventLog::default().sink()).await;
    server.await.expect("server");
    assert!(matches!(result, Err(Error::Rejected(_))), "{result:?}");
    assert!(!connected_within(&spare, Duration::from_millis(500)).await, "never resent on the next route");
}

#[tokio::test]
async fn cancel_before_and_during_the_transfer() {
    let dir = TestDir::new("engine-cancel");
    let (l, port) = listener().await;
    let p = printer(vec![socket(port)]);
    let doc = document(&dir, PDF);
    let canceled = CancelFlag::default();
    canceled.cancel();
    let result = engine(&dir).print(&p, &doc, &JobOptions::default(), &canceled, &EventLog::default().sink()).await;
    assert!(matches!(result, Err(Error::Canceled)), "{result:?}");
    assert!(!connected_within(&l, Duration::from_millis(200)).await, "nothing sent once canceled");

    let _server = tokio::spawn(stall(l));
    let mut big = PDF.to_vec();
    big.resize(32 << 20, b' ');
    let doc = document(&dir, &big);
    let (log, cancel) = (EventLog::default(), CancelFlag::default());
    let watcher = {
        let (log, cancel) = (log.clone(), cancel.clone());
        tokio::spawn(async move {
            for _ in 0..300 {
                if log.waited() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            cancel.cancel();
        })
    };
    let result = engine(&dir).print(&p, &doc, &JobOptions::default(), &cancel, &log.sink()).await;
    watcher.await.expect("watcher");
    assert!(matches!(result, Err(Error::Canceled)), "{result:?}");
}

#[tokio::test]
async fn reports_the_most_useful_failure() {
    let dir = TestDir::new("engine-failures");
    let e = engine(&dir);
    let (opts, go) = (JobOptions::default(), CancelFlag::default());
    let log = EventLog::default();
    let pdf = document(&dir, PDF);
    let none = e.print(&printer(vec![]), &pdf, &opts, &go, &log.sink()).await;
    assert!(matches!(&none, Err(Error::Unreachable(m)) if m.contains("no connection")), "{none:?}");
    let p = printer(vec!["socket://".into(), socket(closed_port().await)]);
    let result = e.print(&p, &pdf, &opts, &go, &log.sink()).await;
    assert!(matches!(&result, Err(Error::Unreachable(m)) if m.contains("refused")), "unreachable outranks a bad address: {result:?}");
    let ps = Document { path: dir.file("doc.ps", b"%!PS-Adobe-3.0\nshowpage\n"), format: DocFormat::PostScript, name: "ps".into() };
    let p = printer(vec![socket(closed_port().await), "socket://".into()]);
    let result = e.print(&p, &ps, &opts, &go, &log.sink()).await;
    assert!(matches!(&result, Err(Error::Unsupported(m)) if m.contains("PostScript")), "first unusable reason wins: {result:?}");
}
