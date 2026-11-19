//! Backend tests against in-process fake printers, plus the address codecs.

mod codecs;
mod lpd;
mod socket;

use super::Payload;
use crate::convert::tests::TestDir;
use crate::engine::PrintEvent;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};

/// Ports other parts of Print Better listen on during tests.
const RESERVED: [u16; 2] = [47631, 8631];

pub(crate) async fn listener() -> (TcpListener, u16) {
    loop {
        let l = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = l.local_addr().expect("addr").port();
        if !RESERVED.contains(&port) {
            return (l, port);
        }
    }
}

/// A port nothing listens on, so connecting is refused.
pub(crate) async fn closed_port() -> u16 {
    listener().await.1
}

/// Accepts one connection and returns all bytes until the sender closes.
pub(crate) async fn read_all(l: TcpListener) -> Vec<u8> {
    let (mut s, _) = l.accept().await.expect("accept");
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.expect("read");
    buf
}

/// Accepts one connection, reads `bytes`, then hangs up with data still unread.
pub(crate) async fn drop_after(l: TcpListener, bytes: usize) {
    let (mut s, _) = l.accept().await.expect("accept");
    let mut buf = vec![0u8; bytes];
    let _ = s.read_exact(&mut buf).await;
}

/// Accepts one connection and holds it open without reading, like a jammed printer.
pub(crate) async fn stall(l: TcpListener) -> TcpStream {
    let (s, _) = l.accept().await.expect("accept");
    tokio::time::sleep(Duration::from_secs(30)).await;
    s
}

/// Whether anything connects within `wait`.
pub(crate) async fn connected_within(l: &TcpListener, wait: Duration) -> bool {
    tokio::time::timeout(wait, l.accept()).await.is_ok()
}

#[derive(Clone, Default)]
pub(crate) struct EventLog(Arc<Mutex<Vec<PrintEvent>>>);

impl EventLog {
    pub fn sink(&self) -> impl Fn(PrintEvent) + Send + Sync + use<> {
        let log = self.0.clone();
        move |e| log.lock().expect("event log").push(e)
    }

    pub fn list(&self) -> Vec<PrintEvent> {
        self.0.lock().expect("event log").clone()
    }

    pub fn waited(&self) -> bool {
        self.list().iter().any(|e| matches!(e, PrintEvent::Waiting { .. }))
    }
}

pub(crate) fn payload(dir: &TestDir, body: &[u8], prefix: &[u8], suffix: &[u8], repeat: u32) -> Payload {
    Payload { prefix: prefix.to_vec(), path: dir.file("payload", body), suffix: suffix.to_vec(), repeat }
}
