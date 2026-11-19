//! HTTP side of the share server: accept loop, hyper connections, and IPP request routing.

use super::ops::{self, Ctx};
use super::state::State;
use super::upload::{self, HeadError};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{self, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

const MAX_CONNECTIONS: usize = 64;
const HEADER_TIMEOUT: Duration = Duration::from_secs(30);

/// Accepts until aborted; dropping the JoinSet with this task aborts every open connection.
pub(super) async fn run(listener: TcpListener, state: Arc<State>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) if connections.len() < MAX_CONNECTIONS => {
                    connections.spawn(serve(stream, state.clone()));
                }
                Ok((_, peer)) => log::warn!("share: too many connections; dropping {peer}"),
                Err(e) => {
                    // Usually descriptor exhaustion; back off instead of spinning.
                    log::warn!("share: accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

async fn serve(stream: TcpStream, state: Arc<State>) {
    let local = stream.local_addr().ok();
    let service = service_fn(move |req| {
        let state = state.clone();
        async move { Ok::<_, Infallible>(handle(state, local, req).await) }
    });
    let connection = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_TIMEOUT)
        .title_case_headers(true)
        .serve_connection(TokioIo::new(stream), service);
    if let Err(e) = connection.await {
        log::debug!("share: connection ended: {e}");
    }
}

async fn handle(state: Arc<State>, local: Option<SocketAddr>, req: Request<Incoming>) -> Response<Full<Bytes>> {
    let Some(slug) = printer_slug(req.uri().path()).map(str::to_string) else { return refuse(req, StatusCode::NOT_FOUND).await };
    if req.method() != Method::POST {
        return refuse(req, StatusCode::METHOD_NOT_ALLOWED).await;
    }
    let content_type = req.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !content_type.trim().to_ascii_lowercase().starts_with("application/ipp") {
        return refuse(req, StatusCode::UNSUPPORTED_MEDIA_TYPE).await;
    }
    let host = authority(req.headers().get(header::HOST), local);
    let (msg, upload) = match upload::read_head(req.into_body()).await {
        Ok(parsed) => parsed,
        Err(HeadError::TooLarge) => return reply(StatusCode::PAYLOAD_TOO_LARGE, None, Vec::new()),
        Err(HeadError::Invalid(why)) => {
            log::debug!("share: malformed IPP request: {why}");
            return reply(StatusCode::BAD_REQUEST, None, Vec::new());
        }
        Err(HeadError::Read(e)) => {
            log::debug!("share: reading request: {e}");
            return reply(StatusCode::BAD_REQUEST, None, Vec::new());
        }
    };
    let ctx = Ctx { printer: state.printer(&slug), state, host };
    let resp = ops::dispatch(&ctx, &msg, upload).await;
    reply(StatusCode::OK, Some("application/ipp"), resp.encode())
}

/// Reads (up to a cap) what the client already sent before refusing: closing with unread data
/// makes the kernel reset the connection, and the client can lose the reply.
async fn refuse(req: Request<Incoming>, status: StatusCode) -> Response<Full<Bytes>> {
    let _ = tokio::time::timeout(Duration::from_secs(2), Limited::new(req.into_body(), 256 * 1024).collect()).await;
    reply(status, None, Vec::new())
}

/// `/ipp/print/<slug>` or a job beneath it (`/ipp/print/<slug>/jobs/<id>`).
fn printer_slug(path: &str) -> Option<&str> {
    path.strip_prefix("/ipp/print/")?.split('/').next().filter(|s| !s.is_empty())
}

/// The Host header when it looks like a host[:port]; it ends up inside printer and job URIs.
fn authority(host: Option<&HeaderValue>, local: Option<SocketAddr>) -> String {
    let valid = |h: &&str| !h.is_empty() && h.len() <= 255 && h.bytes().all(|b| b.is_ascii_alphanumeric() || b"-.:[]%_".contains(&b));
    match host.and_then(|v| v.to_str().ok()).map(str::trim).filter(valid) {
        Some(h) => h.to_string(),
        None => local.map_or_else(|| "localhost".to_string(), |a| a.to_string()),
    }
}

fn reply(status: StatusCode, content_type: Option<&'static str>, body: Vec<u8>) -> Response<Full<Bytes>> {
    let mut resp = Response::new(Full::new(Bytes::from(body)));
    *resp.status_mut() = status;
    let headers = resp.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    if let Some(content_type) = content_type {
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    }
    if status == StatusCode::METHOD_NOT_ALLOWED {
        headers.insert(header::ALLOW, HeaderValue::from_static("POST"));
    }
    resp
}
