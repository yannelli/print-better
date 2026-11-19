use super::{TempDir, fixture};
use crate::error::Error;
use crate::ipp::tls::{Fingerprint, PinStore};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

fn fingerprint(identity: &str) -> Fingerprint {
    let der = fixture(&format!("tls-{identity}.crt.der"));
    ring::digest::digest(&ring::digest::SHA256, &der).as_ref().try_into().unwrap()
}

/// A loopback TLS server presenting test identity "a" or "b"; aborted on drop.
struct Server {
    addr: SocketAddr,
    task: JoinHandle<()>,
}

impl Server {
    async fn start(identity: &str) -> Server {
        let cert = CertificateDer::from(fixture(&format!("tls-{identity}.crt.der")));
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(fixture(&format!("tls-{identity}.key.der"))));
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![cert], key)
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                tokio::spawn(async move { drop(acceptor.accept(tcp).await) });
            }
        });
        Server { addr, task }
    }

    /// Handshake with this server while claiming to be `authority`, as a printer that moved would.
    async fn connect(&self, pins: &PinStore, authority: &str) -> Result<Fingerprint, Error> {
        let tcp = TcpStream::connect(self.addr).await.unwrap();
        pins.connect(tcp, "127.0.0.1", authority).await.map(|(_, fp)| fp)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn pin_file(dir: &TempDir) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(dir.path().join("ipps-pins.json")).unwrap()).unwrap()
}

fn rejected(result: Result<impl std::fmt::Debug, Error>) -> String {
    match result {
        Err(Error::Rejected(m)) => m,
        other => panic!("expected a loud Rejected, got {other:?}"),
    }
}

#[tokio::test]
async fn first_use_pins_and_a_changed_certificate_is_refused_loudly() {
    let dir = TempDir::new("pins");
    let (a, b) = (Server::start("a").await, Server::start("b").await);
    let pins = PinStore::new(dir.path());
    assert_eq!(a.connect(&pins, "printer.local:631").await.unwrap(), fingerprint("a"));
    assert_eq!(pin_file(&dir)["pins"]["printer.local:631"].as_str().map(str::len), Some(64));
    assert_eq!(a.connect(&pins, "printer.local:631").await.unwrap(), fingerprint("a"));

    let message = rejected(b.connect(&pins, "printer.local:631").await);
    assert!(message.contains("printer.local:631") && message.contains("ipps-pins.json"), "{message}");
    let reloaded = PinStore::new(dir.path());
    rejected(b.connect(&reloaded, "printer.local:631").await);
    assert_eq!(b.connect(&reloaded, "other.local:631").await.unwrap(), fingerprint("b"), "other printers are independent");
}

#[tokio::test]
async fn pins_follow_the_printer_uuid_to_a_new_address() {
    let dir = TempDir::new("pins-uuid");
    let (a, b) = (Server::start("a").await, Server::start("b").await);
    let pins = PinStore::new(dir.path());
    let fp = a.connect(&pins, "10.0.0.5:631").await.unwrap();
    pins.bind("10.0.0.5:631", "5f0c2a7e", Some(&fp)).unwrap();
    let file = pin_file(&dir);
    assert_eq!(file["pins"]["uuid:5f0c2a7e"].as_str().map(str::len), Some(64));
    assert!(file["pins"].get("10.0.0.5:631").is_none(), "the address pin moved to the uuid");

    pins.bind("10.0.0.9:631", "5f0c2a7e", None).unwrap();
    rejected(b.connect(&pins, "10.0.0.9:631").await);
    assert_eq!(a.connect(&pins, "10.0.0.9:631").await.unwrap(), fp);
}

#[test]
fn bind_refuses_a_different_certificate_for_a_known_uuid() {
    let dir = TempDir::new("pins-bind");
    let pins = PinStore::new(dir.path());
    let (one, two) = (fingerprint("a"), fingerprint("b"));
    pins.bind("10.0.0.5:631", "u1", None).unwrap();
    assert!(pin_file(&dir)["pins"].as_object().unwrap().is_empty(), "plain IPP only records the address");
    pins.bind("10.0.0.5:631", "u1", Some(&one)).unwrap();
    rejected(pins.bind("10.0.0.6:631", "u1", Some(&two)));
    pins.bind("10.0.0.6:631", "u1", Some(&one)).unwrap();
    pins.bind("10.0.0.6:631", "u2", Some(&two)).unwrap();
    assert_eq!(pin_file(&dir)["hosts"]["10.0.0.6:631"], "u2");
}

#[test]
fn a_corrupt_pin_file_starts_fresh() {
    let dir = TempDir::new("pins-corrupt");
    std::fs::write(dir.path().join("ipps-pins.json"), b"{not json").unwrap();
    let pins = PinStore::new(dir.path());
    pins.bind("10.0.0.5:631", "u1", Some(&fingerprint("a"))).unwrap();
    assert_eq!(pin_file(&dir)["hosts"]["10.0.0.5:631"], "u1");
}

#[tokio::test]
async fn a_failed_handshake_is_unreachable_and_pins_nothing() {
    let dir = TempDir::new("pins-plain");
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { drop(listener.accept().await) });
    let tcp = TcpStream::connect(addr).await.unwrap();
    let result = PinStore::new(dir.path()).connect(tcp, "127.0.0.1", "plain:631").await;
    assert!(matches!(result, Err(Error::Unreachable(_))), "{:?}", result.map(|(_, fp)| fp));
    assert!(dir.files().is_empty());
    server.abort();
}
