//! A scripted IPP printer on 127.0.0.1: records every request and answers from a closure.

use crate::ipp::tags::group;
use crate::ipp::{Attribute, Message, Value};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

pub(crate) enum Answer {
    Ipp(Message),
    Http(StatusCode),
    /// 200 with this body as application/ipp.
    Raw(Vec<u8>),
    /// Close the connection without answering.
    Hangup,
}

pub(crate) struct Seen {
    pub msg: Message,
    pub doc: Vec<u8>,
}

type Script = dyn Fn(&Message) -> Answer + Send + Sync;

pub(crate) struct MockPrinter {
    pub uri: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    task: JoinHandle<()>,
}

impl MockPrinter {
    pub async fn start(script: impl Fn(&Message) -> Answer + Send + Sync + 'static) -> MockPrinter {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let uri = format!("ipp://127.0.0.1:{}/ipp/print", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let script: Arc<Script> = Arc::new(script);
        let log = seen.clone();
        let task = tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let (log, script) = (log.clone(), script.clone());
                let service = service_fn(move |req| answer(req, log.clone(), script.clone()));
                tokio::spawn(async move { drop(http1::Builder::new().serve_connection(TokioIo::new(tcp), service).await) });
            }
        });
        MockPrinter { uri, seen, task }
    }

    pub fn seen(&self) -> std::sync::MutexGuard<'_, Vec<Seen>> {
        self.seen.lock().unwrap()
    }

    /// Operation codes received so far, in order.
    pub fn ops(&self) -> Vec<u16> {
        self.seen().iter().map(|s| s.msg.code).collect()
    }
}

impl Drop for MockPrinter {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn answer(req: Request<Incoming>, log: Arc<Mutex<Vec<Seen>>>, script: Arc<Script>) -> Result<Response<Full<Bytes>>, String> {
    let body = req.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
    let (msg, offset) = Message::decode(&body).map_err(|e| e.to_string())?;
    let reply = script(&msg);
    log.lock().unwrap().push(Seen { msg, doc: body[offset..].to_vec() });
    let mut resp = match reply {
        Answer::Ipp(m) => Response::new(Full::new(Bytes::from(m.encode()))),
        Answer::Raw(bytes) => Response::new(Full::new(Bytes::from(bytes))),
        Answer::Http(status) => {
            let mut resp = Response::new(Full::new(Bytes::new()));
            *resp.status_mut() = status;
            return Ok(resp);
        }
        Answer::Hangup => return Err("hung up by script".into()),
    };
    resp.headers_mut().insert(hyper::header::CONTENT_TYPE, hyper::header::HeaderValue::from_static("application/ipp"));
    Ok(resp)
}

/// A reply to `req` with `code` and the given groups after the operation group.
pub(crate) fn reply(req: &Message, code: u16, groups: Vec<(u8, Vec<Attribute>)>) -> Answer {
    let mut msg = Message::new(req.version, code, req.request_id);
    for (tag, attrs) in groups {
        msg.groups.push(crate::ipp::Group { tag, attrs });
    }
    Answer::Ipp(msg)
}

/// A successful job-creation reply carrying `job-id`.
pub(crate) fn job_created(req: &Message, code: u16, id: i32, unsupported: &[&str]) -> Answer {
    let mut groups = vec![(group::JOB, vec![Attribute::new("job-id", Value::Integer(id))])];
    if !unsupported.is_empty() {
        groups.push((group::UNSUPPORTED, unsupported.iter().map(|n| Attribute::new(n, Value::OutOfBand(0x10))).collect()));
    }
    reply(req, code, groups)
}
