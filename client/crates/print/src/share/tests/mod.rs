//! Share server tests: 127.0.0.1, an ephemeral port, and no advertiser, so nothing is announced.

mod http;
mod loopback;
mod ops;

use super::state::Served;
use super::{ShareOptions, ShareServer, ShareSink, SharedJob, SharedJobState, SharedPrinter};
use crate::ipp::tests::TempDir;
use crate::ipp::{IppClient, Message, Value};
use crate::model::{Capabilities, PrinterReport, PrinterState, PrinterStatus, Route, RouteKind};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const LABEL: &str = "Test Host";
const PDF: &[u8] = b"%PDF-1.7\n% shared job\n";

/// Stands in for the app's queue: records jobs; the test sets their states.
#[derive(Default)]
struct Sink {
    jobs: Mutex<Vec<SharedJob>>,
    states: Mutex<HashMap<u32, SharedJobState>>,
    canceled: Mutex<Vec<u32>>,
    refuse: Mutex<Option<String>>,
}

impl Sink {
    fn set(&self, id: u32, state: SharedJobState) {
        self.states.lock().unwrap().insert(id, state);
    }

    fn jobs(&self) -> Vec<SharedJob> {
        self.jobs.lock().unwrap().clone()
    }
}

impl ShareSink for Sink {
    fn submit(&self, job: SharedJob) -> Result<u32, String> {
        if let Some(why) = self.refuse.lock().unwrap().clone() {
            return Err(why);
        }
        let mut jobs = self.jobs.lock().unwrap();
        jobs.push(job);
        let id = 100 + u32::try_from(jobs.len()).unwrap();
        self.set(id, SharedJobState::Pending);
        Ok(id)
    }

    fn state(&self, id: u32) -> Option<(SharedJobState, Option<String>)> {
        self.states.lock().unwrap().get(&id).map(|s| (*s, None))
    }

    fn cancel(&self, id: u32) -> bool {
        self.canceled.lock().unwrap().push(id);
        self.set(id, SharedJobState::Canceled);
        true
    }
}

fn laser() -> SharedPrinter {
    let capabilities = Capabilities {
        formats: vec!["application/pdf".into(), "image/urf".into(), "image/pwg-raster".into()],
        color: false,
        duplex: true,
        media: vec!["na_letter_8.5x11in".into(), "iso_a4_210x297mm".into()],
        media_default: Some("na_letter_8.5x11in".into()),
        resolutions: vec![600],
        copies_max: 99,
        ..Capabilities::default()
    };
    let report = PrinterReport {
        key: "uuid:5f0c2a7e".into(),
        name: "HP LaserJet Pro M404-M405".into(),
        make_model: Some("HP LaserJet Pro M404-M405".into()),
        uuid: Some("5f0c2a7e".into()),
        location: Some("2nd floor".into()),
        local: false,
        routes: vec![Route { kind: RouteKind::Ipp, uri: "ipp://10.0.0.5/ipp/print".into() }],
        capabilities,
        status: PrinterStatus { state: PrinterState::Idle, ..PrinterStatus::default() },
    };
    SharedPrinter { key: report.key.clone(), name: "Office Laser".into(), report, info_url: None }
}

struct Harness {
    server: Option<ShareServer>,
    addr: SocketAddr,
    spool: TempDir,
    sink: Arc<Sink>,
    ipp: IppClient,
    _client_state: TempDir,
}

impl Harness {
    async fn start() -> Harness {
        Harness::with_formats(None).await
    }

    async fn with_formats(formats: Option<&'static [&'static str]>) -> Harness {
        let spool = TempDir::new("share-spool");
        let client_state = TempDir::new("share-client");
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let opts = ShareOptions {
            port: addr.port(),
            spool_dir: spool.path().to_path_buf(),
            host_label: LABEL.into(),
            loopback_only: true,
            formats,
        };
        let sink = Arc::new(Sink::default());
        let server = ShareServer::serve(listener, None, opts, sink.clone());
        server.set_printers(vec![laser()]);
        let ipp = IppClient::new("pb-test", client_state.path());
        Harness { server: Some(server), addr, spool, sink, ipp, _client_state: client_state }
    }

    fn served(&self) -> Served {
        Served::new(laser(), LABEL, None)
    }

    fn path(&self) -> String {
        format!("/ipp/print/{}", self.served().slug)
    }

    fn uri(&self) -> String {
        format!("ipp://{}{}", self.addr, self.path())
    }

    /// Spool files, waiting briefly for abandoned uploads to be cleaned up.
    async fn spooled_after_cleanup(&self) -> Vec<String> {
        for _ in 0..40 {
            if self.spool.files().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.spool.files()
    }
}

/// An IPP request to `uri` from user "bob".
fn request(op: u16, uri: &str) -> Message {
    let mut msg = Message::new((2, 0), op, 1);
    msg.operation().push("printer-uri", Value::uri(uri));
    msg.operation().push("requesting-user-name", Value::name("bob"));
    msg
}

/// One HTTP/1.1 exchange on a fresh connection: (status, response head, body).
async fn exchange(addr: SocketAddr, head: String, body: Vec<u8>) -> (u16, String, Vec<u8>) {
    let tcp = TcpStream::connect(addr).await.unwrap();
    let (mut read, mut write) = tcp.into_split();
    // Written concurrently: the server may answer before it has read everything.
    let writer = tokio::spawn(async move {
        let _ = write.write_all(head.as_bytes()).await;
        let _ = write.write_all(&body).await;
        write
    });
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), read.read_to_end(&mut response)).await.expect("response in time").unwrap();
    drop(writer.await);
    split(&response)
}

fn split(response: &[u8]) -> (u16, String, Vec<u8>) {
    let end = response.windows(4).position(|w| w == b"\r\n\r\n").expect("complete head");
    let head = String::from_utf8_lossy(&response[..end]).into_owned();
    let status = head.get(9..12).and_then(|s| s.parse().ok()).expect("status line");
    (status, head, response[end + 4..].to_vec())
}

fn post_head(path: &str, host: &str, content_type: &str, len: usize) -> String {
    format!("POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n")
}

/// Posts `msg` plus document bytes and decodes the IPP reply.
async fn ipp(h: &Harness, msg: &Message, doc: &[u8]) -> Message {
    let body = [msg.encode(), doc.to_vec()].concat();
    let (status, _, reply) = exchange(h.addr, post_head(&h.path(), &h.addr.to_string(), "application/ipp", body.len()), body).await;
    assert_eq!(status, 200);
    Message::decode(&reply).unwrap().0
}
