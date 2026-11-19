//! Route backends (socket, LPD, USB, OS spoolers) and their enumerators.
//! Owned by the print-path implementer; `usb::enumerate` and `windows::enumerate` are frozen.

pub(crate) mod lpd;
pub(crate) mod os;
pub(crate) mod pjl;
pub(crate) mod socket;
pub mod usb;
#[cfg(not(windows))]
pub(crate) mod usb_io;
#[cfg(test)]
pub(crate) mod tests;
#[cfg(windows)]
pub mod windows;

use crate::engine::{CancelFlag, PrintEvent};
use crate::error::{Error, Result};
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

pub(crate) type Events<'a> = &'a (dyn Fn(PrintEvent) + Send + Sync);

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const STALL_NOTICE: Duration = if cfg!(test) { Duration::from_millis(300) } else { Duration::from_secs(20) };
const CHUNK: usize = 64 * 1024;

/// Bytes for a raw channel: `prefix`, the file, `suffix`, all sent `repeat` times.
#[derive(Clone, Debug)]
pub(crate) struct Payload {
    pub prefix: Vec<u8>,
    pub path: PathBuf,
    pub suffix: Vec<u8>,
    pub repeat: u32,
}

impl Payload {
    /// Size of one copy.
    pub fn len(&self) -> Result<u64> {
        Ok(std::fs::metadata(&self.path)?.len() + (self.prefix.len() + self.suffix.len()) as u64)
    }
}

pub(crate) struct Endpoint {
    pub host: String,
    pub port: u16,
    /// Path after the authority, without the leading slash or query.
    pub path: String,
}

/// Parses `scheme://host[:port][/path]`, including bracketed IPv6 hosts.
pub(crate) fn endpoint(uri: &str, default_port: u16) -> Result<Endpoint> {
    let bad = || Error::Unsupported(format!("The printer address \"{uri}\" isn't valid."));
    let rest = uri.split_once("://").map(|(_, r)| r).ok_or_else(bad)?;
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (host, after) = v6.split_once(']').ok_or_else(bad)?;
        (host, after.strip_prefix(':'))
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };
    let port = port.map_or(Ok(default_port), |p| p.parse().map_err(|_| bad()))?;
    if host.is_empty() {
        return Err(bad());
    }
    let path = path.split('?').next().unwrap_or("").to_string();
    Ok(Endpoint { host: host.to_string(), port, path })
}

pub(crate) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub(crate) async fn connect(host: &str, port: u16) -> Result<TcpStream> {
    let unreachable = |why: &str| Error::Unreachable(format!("Can't reach the printer at {host}{why}."));
    match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port))).await {
        Ok(Ok(stream)) => {
            let _ = stream.set_nodelay(true);
            Ok(stream)
        }
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => Err(unreachable(" (it refused the connection)")),
        Ok(Err(_)) => Err(unreachable("")),
        Err(_) => Err(unreachable(" (no answer)")),
    }
}

pub(crate) fn lost_midway() -> Error {
    Error::Rejected("The connection to the printer dropped partway through. Some pages may have printed; print again if needed.".into())
}

/// Tracks transfer progress: reports stalls as Waiting and recovery as Printing.
pub(crate) struct Progress<'a> {
    pub on_event: Events<'a>,
    pub cancel: &'a CancelFlag,
    waiting: bool,
    sent: u64,
}

impl<'a> Progress<'a> {
    pub fn new(on_event: Events<'a>, cancel: &'a CancelFlag) -> Progress<'a> {
        Progress { on_event, cancel, waiting: false, sent: 0 }
    }

    pub fn stalled(&mut self, message: String) {
        if !self.waiting {
            self.waiting = true;
            (self.on_event)(PrintEvent::Waiting { message });
        }
    }

    pub fn moved(&mut self, bytes: usize) {
        self.sent += bytes as u64;
        if self.waiting {
            self.waiting = false;
            (self.on_event)(PrintEvent::Printing { pages_done: None });
        }
    }

    /// A failed transfer: safe to try elsewhere only if nothing reached the printer.
    pub fn failed(&self) -> Error {
        if self.sent == 0 {
            Error::Unreachable("The printer closed the connection before taking the job.".into())
        } else {
            lost_midway()
        }
    }
}

pub(crate) const STALLED: &str = "The printer isn't taking data right now. Check it for paper, jams, or error lights.";

async fn write_all<W: AsyncWrite + Unpin>(w: &mut W, mut data: &[u8], p: &mut Progress<'_>) -> Result<()> {
    while !data.is_empty() {
        tokio::select! {
            r = w.write(data) => match r {
                Ok(n) if n > 0 => {
                    data = &data[n..];
                    p.moved(n);
                }
                _ => return Err(p.failed()),
            },
            _ = p.cancel.canceled() => return Err(Error::Canceled),
            _ = tokio::time::sleep(STALL_NOTICE) => p.stalled(STALLED.into()),
        }
    }
    Ok(())
}

/// Streams `copies` copies of the payload into `w`.
pub(crate) async fn pump<W: AsyncWrite + Unpin>(w: &mut W, payload: &Payload, copies: u32, p: &mut Progress<'_>) -> Result<()> {
    let mut buf = vec![0u8; CHUNK];
    for _ in 0..copies.max(1) {
        write_all(w, &payload.prefix, p).await?;
        let mut file = tokio::fs::File::open(&payload.path).await?;
        loop {
            let n = file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            write_all(w, &buf[..n], p).await?;
        }
        write_all(w, &payload.suffix, p).await?;
    }
    w.flush().await.map_err(|_| p.failed())
}
