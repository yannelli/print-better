//! Loopback API and status page on 127.0.0.1:47631, used by the CLI, tray, and browser.

#[cfg(test)]
mod tests;

mod actions;
mod api;
pub mod client;
mod reply;
mod status;

use crate::daemon::Daemon;
use crate::proto::LOCAL_PORT;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use std::convert::Infallible;
use std::io;
use std::net::TcpListener as StdListener;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::net::TcpListener;

/// The local API port; `PRINTBETTER_PORT` moves it for development and tests.
pub fn port() -> u16 {
    static PORT: OnceLock<u16> = OnceLock::new();
    *PORT.get_or_init(|| std::env::var("PRINTBETTER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(LOCAL_PORT))
}

pub fn page_url() -> String {
    format!("http://127.0.0.1:{}/", port())
}

/// Binds the local port. A restarting daemon may hold it briefly, so retry for a few seconds
/// unless a healthy daemon already answers there.
pub fn bind() -> io::Result<StdListener> {
    let mut attempts = 0;
    loop {
        match StdListener::bind(("127.0.0.1", port())) {
            Ok(listener) => {
                listener.set_nonblocking(true)?;
                return Ok(listener);
            }
            Err(e) if e.kind() == io::ErrorKind::AddrInUse && attempts < 20 && !client::is_running() => {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(e) => return Err(e),
        }
    }
}

pub async fn serve(d: Arc<Daemon>, listener: StdListener) {
    // Host and Origin checks follow the port actually bound.
    let port = listener.local_addr().map_or(port(), |addr| addr.port());
    let listener = match TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(e) => {
            log::error!("local API unavailable: {e}");
            return;
        }
    };
    let mut builder = http1::Builder::new();
    builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(10));
    loop {
        let stream = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => stream,
                Err(e) => {
                    log::warn!("local API accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
            },
            _ = d.stopping.canceled() => return,
        };
        let d = d.clone();
        let service = service_fn(move |req| {
            let d = d.clone();
            async move { Ok::<_, Infallible>(api::handle(d, req, port).await) }
        });
        let connection = builder.serve_connection(TokioIo::new(stream), service);
        tokio::task::spawn_local(async move {
            let _ = connection.await;
        });
    }
}
