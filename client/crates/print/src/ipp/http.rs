//! One HTTP/1.1 POST per IPP request over TCP, TLS, or the CUPS domain socket. Documents stream
//! from disk with a Content-Length; a printer that stops reading or answering is cut off.

use super::client::IppBody;
use super::tls::{Fingerprint, PinStore};
use super::uri::Target;
use crate::error::{Error, Result};
use bytes::Bytes;
use http_body_util::{BodyExt, Limited};
use hyper::body::{Body, Frame, SizeHint};
use hyper::{Method, Request, StatusCode, header};
use hyper_util::rt::TokioIo;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_RESPONSE: usize = 32 << 20;
const CHUNK: usize = 64 << 10;

/// Request document; cheap to clone for a retry.
#[derive(Clone)]
pub enum Doc {
    Bytes(Bytes),
    File { head: Bytes, path: PathBuf, tail: Bytes },
}

impl From<IppBody> for Doc {
    fn from(body: IppBody) -> Doc {
        match body {
            IppBody::Bytes(b) => Doc::Bytes(Bytes::from(b)),
            IppBody::File(path) => Doc::File { head: Bytes::new(), path, tail: Bytes::new() },
            IppBody::Wrapped { head, path, tail } => Doc::File { head: head.into(), path, tail: tail.into() },
        }
    }
}

pub struct Reply {
    pub body: Bytes,
    /// Certificate fingerprint when the connection was TLS.
    pub cert: Option<Fingerprint>,
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// POSTs an encoded IPP request plus optional document; gives up when nothing moves for `idle`.
pub async fn post(target: &Target, pins: &PinStore, user_agent: &str, head: Vec<u8>, doc: Option<&Doc>, idle: Duration) -> Result<Reply> {
    let at = target.authority();
    let progress = Arc::new(Progress::new());
    let body = ReqBody::open(head, doc, progress.clone()).await?;
    let len = body.len();
    let (io, cert) = connect(target, pins).await?;
    let (mut sender, conn) = hyper::client::conn::http1::Builder::new()
        .title_case_headers(true)
        .handshake(TokioIo::new(io))
        .await
        .map_err(|e| Error::Unreachable(format!("{at}: {e}")))?;
    progress.touch();
    let req = Request::builder()
        .method(Method::POST)
        .uri(target.path.as_str())
        .header(header::HOST, &at)
        .header(header::CONTENT_TYPE, "application/ipp")
        .header(header::CONTENT_LENGTH, len)
        .header(header::USER_AGENT, user_agent)
        .header(header::CONNECTION, "close")
        .body(body)
        .map_err(|e| Error::Protocol(format!("{at}: bad request: {e}")))?;
    // Requests without a document are safe to repeat, so their failures keep the transport meaning.
    let lost = |why: String| if doc.is_some() { may_have_printed(why) } else { Error::Unreachable(why) };
    let exchange = async {
        let resp = sender.send_request(req).await.map_err(|e| lost(format!("{at}: connection lost mid-request: {e}")))?;
        let status = resp.status();
        let body = Limited::new(resp.into_body(), MAX_RESPONSE)
            .collect()
            .await
            .map_err(|e| lost(format!("{at}: reading response: {e}")))?;
        Ok::<_, Error>((status, body.to_bytes()))
    };
    tokio::pin!(exchange);
    tokio::pin!(conn);
    let mut conn_done = false;
    let (status, body) = loop {
        tokio::select! {
            result = &mut exchange => break result?,
            // A failed connection also fails the exchange, which may still hold an early response.
            done = &mut conn, if !conn_done => {
                conn_done = true;
                if let Err(e) = done {
                    log::debug!("{at}: connection ended: {e}");
                }
            }
            () = tokio::time::sleep(Duration::from_millis(500)) => {
                if progress.idle() > idle {
                    return Err(lost(format!("{at} stopped responding for {}s", idle.as_secs())));
                }
            }
        }
    };
    http_status(status, target)?;
    Ok(Reply { body, cert })
}

/// A document request with an unknown outcome. Rejected is the one class the engine and queue
/// neither retry nor send down another route, so the job cannot print twice.
pub fn may_have_printed(why: String) -> Error {
    Error::Rejected(format!("{why}; the job may have printed, so it won't be sent again"))
}

fn http_status(status: StatusCode, target: &Target) -> Result<()> {
    let at = target.authority();
    match status.as_u16() {
        200..=299 => Ok(()),
        401 | 403 => Err(Error::Rejected(format!("{at} requires authentication (HTTP {status})"))),
        404 => Err(Error::Rejected(format!("{at} has no printer at {} (HTTP 404)", target.path))),
        413 => Err(Error::Rejected(format!("{at} refused the document as too large (HTTP 413)"))),
        426 => Err(Error::Rejected(format!("{at} only accepts encrypted ipps connections (HTTP 426)"))),
        502..=504 => Err(Error::NotReady(format!("{at} is busy (HTTP {status})"))),
        500..=599 => Err(Error::Protocol(format!("{at} failed with HTTP {status}"))),
        _ => Err(Error::Rejected(format!("{at} refused the request (HTTP {status})"))),
    }
}

async fn connect(target: &Target, pins: &PinStore) -> Result<(Box<dyn Io>, Option<Fingerprint>)> {
    let tcp = match tcp(target).await {
        Ok(tcp) => tcp,
        Err(e) => {
            #[cfg(unix)]
            if target.is_local_cups()
                && let Some(socket) = cups_socket().await
            {
                return Ok((Box::new(socket), None));
            }
            return Err(e);
        }
    };
    if !target.tls {
        return Ok((Box::new(tcp), None));
    }
    let at = target.authority();
    let (tls, fp) = tokio::time::timeout(CONNECT_TIMEOUT, pins.connect(tcp, &target.host, &at))
        .await
        .map_err(|_| Error::Unreachable(format!("TLS handshake with {at} timed out")))??;
    Ok((Box::new(tls), Some(fp)))
}

/// Whether `target` completes a TLS handshake with us: Some(false) when it refuses, None when that
/// cannot be told (unreachable, timed out, or its certificate no longer matches the pin).
pub async fn tls_handshake_ok(target: &Target, pins: &PinStore) -> Option<bool> {
    let tcp = tcp(target).await.ok()?;
    match tokio::time::timeout(CONNECT_TIMEOUT, pins.connect(tcp, &target.host, &target.authority())).await {
        Ok(Ok(_)) => Some(true),
        Ok(Err(Error::Unreachable(_))) => Some(false),
        _ => None,
    }
}

async fn tcp(target: &Target) -> Result<TcpStream> {
    let addrs = super::resolve::resolve(&target.host, target.port).await?;
    let mut last = String::from("no addresses");
    for addr in addrs.into_iter().take(4) {
        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
            Ok(Ok(stream)) => {
                if let Err(e) = stream.set_nodelay(true) {
                    log::debug!("{addr}: TCP_NODELAY: {e}");
                }
                return Ok(stream);
            }
            Ok(Err(e)) => last = e.to_string(),
            Err(_) => last = "connection timed out".into(),
        }
    }
    Err(Error::Unreachable(format!("{}: {last}", target.authority())))
}

#[cfg(unix)]
async fn cups_socket() -> Option<tokio::net::UnixStream> {
    for path in ["/run/cups/cups.sock", "/var/run/cups/cups.sock", "/private/var/run/cupsd"] {
        if let Ok(Ok(socket)) = tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::UnixStream::connect(path)).await {
            return Some(socket);
        }
    }
    None
}

/// Last time the request body was pulled by the connection, i.e. the printer accepted data.
struct Progress {
    start: Instant,
    last_ms: AtomicU64,
}

impl Progress {
    fn new() -> Progress {
        Progress { start: Instant::now(), last_ms: AtomicU64::new(0) }
    }

    fn touch(&self) {
        let ms = u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last_ms.store(ms, Ordering::Relaxed);
    }

    fn idle(&self) -> Duration {
        self.start.elapsed().saturating_sub(Duration::from_millis(self.last_ms.load(Ordering::Relaxed)))
    }
}

/// IPP message followed by the document, streamed from disk in chunks between its own head and tail.
struct ReqBody {
    head: Option<Bytes>,
    data: Option<Bytes>,
    file: Option<tokio::fs::File>,
    remaining: u64,
    tail: Option<Bytes>,
    buf: Vec<u8>,
    progress: Arc<Progress>,
}

impl ReqBody {
    async fn open(head: Vec<u8>, doc: Option<&Doc>, progress: Arc<Progress>) -> Result<ReqBody> {
        let mut body =
            ReqBody { head: Some(head.into()), data: None, file: None, remaining: 0, tail: None, buf: Vec::new(), progress };
        match doc {
            None => {}
            Some(Doc::Bytes(b)) => body.data = Some(b.clone()),
            Some(Doc::File { head, path, tail }) => {
                let file = tokio::fs::File::open(path).await?;
                body.remaining = file.metadata().await?.len();
                body.file = Some(file);
                body.buf = vec![0; CHUNK];
                body.data = Some(head.clone()).filter(|b| !b.is_empty());
                body.tail = Some(tail.clone()).filter(|b| !b.is_empty());
            }
        }
        Ok(body)
    }

    fn len(&self) -> u64 {
        let bytes = |b: &Option<Bytes>| b.as_ref().map_or(0, |b| b.len() as u64);
        bytes(&self.head) + bytes(&self.data) + self.remaining + bytes(&self.tail)
    }
}

impl Body for ReqBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<std::io::Result<Frame<Bytes>>>> {
        let this = self.get_mut();
        this.progress.touch();
        if let Some(b) = this.head.take().or_else(|| this.data.take()) {
            return Poll::Ready(Some(Ok(Frame::data(b))));
        }
        let Some(file) = this.file.as_mut().filter(|_| this.remaining > 0) else {
            return Poll::Ready(this.tail.take().map(|b| Ok(Frame::data(b))));
        };
        let want = usize::try_from(this.remaining).unwrap_or(usize::MAX).min(this.buf.len());
        let mut read = ReadBuf::new(&mut this.buf[..want]);
        match Pin::new(file).poll_read(cx, &mut read) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(e)) => Poll::Ready(Some(Err(e))),
            Poll::Ready(Ok(())) if read.filled().is_empty() => {
                Poll::Ready(Some(Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "document shrank while sending"))))
            }
            Poll::Ready(Ok(())) => {
                this.remaining -= read.filled().len() as u64;
                Poll::Ready(Some(Ok(Frame::data(Bytes::copy_from_slice(read.filled())))))
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.head.is_none() && self.data.is_none() && self.remaining == 0 && self.tail.is_none()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.len())
    }
}
