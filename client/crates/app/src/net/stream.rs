use super::ServerUrl;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use std::io;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// TCP or TLS-over-TCP, so HTTP and WebSocket code works with both `https` and loopback `http`.
pub enum Stream {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

pub async fn connect(url: &ServerUrl) -> io::Result<Stream> {
    let tcp = timeout(CONNECT_TIMEOUT, TcpStream::connect((url.dial_host(), url.port)))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "connecting to the server timed out"))??;
    let _ = tcp.set_nodelay(true);
    if !url.tls {
        return Ok(Stream::Plain(tcp));
    }
    let name = ServerName::try_from(url.dial_host().to_string())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let tls = timeout(CONNECT_TIMEOUT, TlsConnector::from(tls_config()?).connect(name, tcp))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "the secure connection timed out"))??;
    Ok(Stream::Tls(Box::new(tls)))
}

/// Explicit ring provider + bundled Mozilla roots: deterministic on headless Linux.
fn tls_config() -> io::Result<Arc<ClientConfig>> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    if let Some(config) = CONFIG.get() {
        return Ok(config.clone());
    }
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut config = ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(CONFIG.get_or_init(|| Arc::new(config)).clone())
}

impl AsyncRead for Stream {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_read(cx, buf),
            Stream::Tls(s) => Pin::new(&mut **s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_write(cx, buf),
            Stream::Tls(s) => Pin::new(&mut **s).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_flush(cx),
            Stream::Tls(s) => Pin::new(&mut **s).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_shutdown(cx),
            Stream::Tls(s) => Pin::new(&mut **s).poll_shutdown(cx),
        }
    }
}
