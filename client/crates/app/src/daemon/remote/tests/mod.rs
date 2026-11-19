//! Remote printers against fakes: a scripted Print Better server on an ephemeral port and a
//! CUPS stand-in that records lpadmin calls. Nothing touches the real print system.

mod cups;
mod default;
mod serve;
mod sink;

use super::cups::Cups;
use crate::daemon::Daemon;
use crate::proto::RemotePrinter;
use crate::store::{self, Credentials};
use crate::test_util::TempDir;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use pb_print::{Capabilities, PrinterState};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

pub const TOKEN: &str = "pbc_test";

pub fn printer(id: &str, name: &str, location: Option<&str>, client: &str, online: bool) -> RemotePrinter {
    let capabilities = Capabilities {
        formats: vec!["application/pdf".into(), "image/urf".into()],
        duplex: true,
        media: vec!["na_letter_8.5x11in".into()],
        media_default: Some("na_letter_8.5x11in".into()),
        ..Capabilities::default()
    };
    RemotePrinter {
        id: id.into(),
        name: name.into(),
        location: location.map(String::from),
        make_model: Some("Brother HL-L2350DW series".into()),
        uuid: None,
        client_name: client.into(),
        online,
        state: if online { PrinterState::Idle } else { PrinterState::Offline },
        capabilities,
        defaults: Default::default(),
        supplies: Vec::new(),
    }
}

/// A paired daemon whose session is up, talking to `server`.
pub fn daemon(dir: &TempDir, server: &str) -> Arc<Daemon> {
    let creds = Credentials {
        server: server.into(),
        client_id: "cl_mac".into(),
        workspace_id: "ws_01".into(),
        name: "Kitchen Mac".into(),
        token: TOKEN.into(),
    };
    store::save_credentials(&dir.paths(), &creds).unwrap();
    let d = Arc::new(Daemon::new(dir.paths(), false, false));
    d.outbox.set_online(true);
    d
}

/// Waits up to 5 s for `done`.
pub async fn until(what: &str, done: impl Fn() -> bool) {
    for _ in 0..500 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

/// Records lpadmin calls and keeps a set of existing queues the way CUPS would.
#[derive(Default)]
pub struct FakeCups {
    pub calls: Mutex<Vec<Vec<String>>>,
    pub queues: Mutex<HashSet<String>>,
    /// Every lpadmin call fails with this.
    pub refuse: Mutex<Option<String>>,
    /// Whether the device URI of each add answered when lpadmin ran.
    pub reachable: Mutex<Vec<bool>>,
    /// Queues whose PPD was marked AirPrint, in order.
    pub marked: Mutex<Vec<String>>,
    /// The system default queue; `lpadmin -d` sets it and removing that queue clears it.
    pub default: Mutex<Option<String>>,
    /// Queues set up outside Print Better, with their device URIs.
    pub devices: Mutex<Vec<(String, String)>>,
    pub last_used: Mutex<bool>,
    /// Queue descriptions, as `lpstat -l -p` reports them.
    pub descriptions: Mutex<Vec<(String, String)>>,
}

impl FakeCups {
    pub fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }

    pub fn calls_starting(&self, flag: &str) -> Vec<Vec<String>> {
        self.calls().into_iter().filter(|c| c[0] == flag).collect()
    }
}

impl Cups for FakeCups {
    fn lpadmin(&self, args: &[String]) -> Result<(), String> {
        self.calls.lock().unwrap().push(args.to_vec());
        if let Some(why) = self.refuse.lock().unwrap().clone() {
            return Err(why);
        }
        let queue = args[1].clone();
        let mut default = self.default.lock().unwrap();
        if args[0] == "-d" {
            *default = Some(queue);
        } else if args[0] == "-x" {
            self.queues.lock().unwrap().remove(&queue);
            if default.as_ref() == Some(&queue) {
                *default = None;
            }
        } else if args.contains(&"everywhere".to_string()) {
            let uri = &args[args.iter().position(|a| a == "-v").unwrap() + 1];
            let authority = uri.trim_start_matches("ipp://").split('/').next().unwrap();
            self.reachable.lock().unwrap().push(std::net::TcpStream::connect(authority).is_ok());
            self.queues.lock().unwrap().insert(queue);
        }
        Ok(())
    }

    fn exists(&self, queue: &str) -> bool {
        self.queues.lock().unwrap().contains(queue) || self.devices.lock().unwrap().iter().any(|(q, _)| q == queue)
    }

    fn default_queue(&self) -> Result<Option<String>, String> {
        Ok(self.default.lock().unwrap().clone())
    }

    fn devices(&self) -> Vec<(String, String)> {
        self.devices.lock().unwrap().clone()
    }

    fn description(&self, queue: &str) -> Option<String> {
        self.descriptions.lock().unwrap().iter().find(|(q, _)| q == queue).map(|(_, d)| d.clone())
    }

    fn last_printer_used(&self) -> bool {
        *self.last_used.lock().unwrap()
    }

    fn mark_airprint(&self, queue: &str) -> Result<(), String> {
        self.marked.lock().unwrap().push(queue.to_string());
        Ok(())
    }
}

pub struct Seen {
    pub method: String,
    pub path: String,
    pub auth: Option<String>,
    pub content_type: Option<String>,
    pub content_length: Option<String>,
    pub body: Vec<u8>,
}

type Script = dyn Fn(&Seen) -> (u16, Value) + Send + Sync;

/// A Print Better server answering from a closure; records every request.
pub struct FakeServer {
    pub origin: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    task: JoinHandle<()>,
}

impl FakeServer {
    pub async fn start(script: impl Fn(&Seen) -> (u16, Value) + Send + Sync + 'static) -> FakeServer {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (log, script): (_, Arc<Script>) = (seen.clone(), Arc::new(script));
        let task = tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let (log, script) = (log.clone(), script.clone());
                let service = service_fn(move |req| answer(req, log.clone(), script.clone()));
                tokio::spawn(async move { drop(http1::Builder::new().serve_connection(TokioIo::new(tcp), service).await) });
            }
        });
        FakeServer { origin, seen, task }
    }

    /// `METHOD path` of every request so far.
    pub fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|s| format!("{} {}", s.method, s.path)).collect()
    }

    pub fn with<R>(&self, f: impl FnOnce(&[Seen]) -> R) -> R {
        f(&self.seen.lock().unwrap())
    }
}

impl Drop for FakeServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn answer(req: Request<Incoming>, log: Arc<Mutex<Vec<Seen>>>, script: Arc<Script>) -> Result<Response<Full<Bytes>>, String> {
    let header = |name: &str| req.headers().get(name).and_then(|v| v.to_str().ok()).map(String::from);
    let (auth, content_type, content_length) = (header("authorization"), header("content-type"), header("content-length"));
    let (method, path) = (req.method().to_string(), req.uri().path().to_string());
    let body = req.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes().to_vec();
    let seen = Seen { method, path, auth, content_type, content_length, body };
    let (status, reply) = script(&seen);
    log.lock().unwrap().push(seen);
    let mut resp = Response::new(Full::new(Bytes::from(reply.to_string())));
    *resp.status_mut() = StatusCode::from_u16(status).unwrap();
    Ok(resp)
}
