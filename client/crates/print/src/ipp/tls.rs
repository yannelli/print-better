//! Trust-on-first-use for printer certificates, which are almost always self-signed. The leaf
//! SHA-256 is pinned per printer uuid (or host:port); handshake signatures are still verified.

use crate::error::{Error, Result};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

pub type Fingerprint = [u8; 32];

#[derive(Default, Serialize, Deserialize)]
struct PinFile {
    /// "uuid:<printer-uuid>" or "host:port" -> leaf certificate SHA-256, hex.
    pins: BTreeMap<String, String>,
    /// "host:port" -> printer-uuid, learned from Get-Printer-Attributes.
    hosts: BTreeMap<String, String>,
}

pub struct PinStore {
    path: PathBuf,
    file: Mutex<Option<PinFile>>,
    provider: Arc<CryptoProvider>,
}

impl PinStore {
    pub fn new(state_dir: &Path) -> PinStore {
        PinStore {
            path: state_dir.join("ipps-pins.json"),
            file: Mutex::new(None),
            provider: Arc::new(rustls::crypto::ring::default_provider()),
        }
    }

    fn with<R>(&self, f: impl FnOnce(&mut PinFile) -> R) -> R {
        let mut guard = self.file.lock().unwrap_or_else(PoisonError::into_inner);
        let file = guard.get_or_insert_with(|| {
            std::fs::read(&self.path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
        });
        f(file)
    }

    fn save(&self, file: &PinFile) {
        let tmp = self.path.with_extension("json.tmp");
        let written = serde_json::to_vec_pretty(file)
            .map_err(std::io::Error::other)
            .and_then(|bytes| std::fs::write(&tmp, bytes))
            .and_then(|()| std::fs::rename(&tmp, &self.path));
        if let Err(e) = written {
            log::warn!("cannot persist printer certificate pins to {}: {e}", self.path.display());
        }
    }

    fn lookup(&self, authority: &str) -> (String, Option<Fingerprint>) {
        self.with(|f| {
            let key = f.hosts.get(authority).map_or_else(|| authority.to_string(), |uuid| format!("uuid:{uuid}"));
            let pin = f.pins.get(&key).and_then(|h| from_hex(h));
            (key, pin)
        })
    }

    fn trust(&self, key: &str, fp: &Fingerprint) {
        self.with(|f| {
            if !f.pins.contains_key(key) {
                log::info!("pinned TLS certificate {} for {key}", hex(fp));
                f.pins.insert(key.to_string(), hex(fp));
                self.save(f);
            }
        })
    }

    /// Records that `authority` serves the printer `uuid`, so its pin follows the printer across
    /// address changes. `fp` is the certificate seen on that connection, when it was TLS.
    pub fn bind(&self, authority: &str, uuid: &str, fp: Option<&Fingerprint>) -> Result<()> {
        self.with(|f| {
            let key = format!("uuid:{uuid}");
            let mut changed = f.hosts.get(authority).map(String::as_str) != Some(uuid);
            match (f.pins.get(&key).and_then(|h| from_hex(h)), fp) {
                (Some(pinned), Some(fp)) if pinned != *fp => return Err(mismatch(&key, &pinned, fp, &self.path)),
                (None, Some(fp)) => {
                    f.pins.insert(key, hex(fp));
                    f.pins.remove(authority);
                    changed = true;
                }
                _ => {}
            }
            if changed {
                f.hosts.insert(authority.to_string(), uuid.to_string());
                self.save(f);
            }
            Ok(())
        })
    }

    /// TLS handshake that accepts the pinned certificate, or any certificate on first use.
    pub async fn connect(&self, tcp: TcpStream, host: &str, authority: &str) -> Result<(TlsStream<TcpStream>, Fingerprint)> {
        let (key, expected) = self.lookup(authority);
        let verifier = Arc::new(PinVerifier { expected, seen: Mutex::new(None), provider: self.provider.clone() });
        let config = ClientConfig::builder_with_provider(self.provider.clone())
            .with_safe_default_protocol_versions()
            .map_err(|e| Error::Protocol(format!("TLS setup: {e}")))?
            .dangerous()
            .with_custom_certificate_verifier(verifier.clone())
            .with_no_client_auth();
        let name = ServerName::try_from(host.to_string())
            .or_else(|_| ServerName::try_from("printer.invalid".to_string()))
            .map_err(|e| Error::Protocol(format!("TLS server name: {e}")))?;
        let result = TlsConnector::from(Arc::new(config)).connect(name, tcp).await;
        let seen = *verifier.seen.lock().unwrap_or_else(PoisonError::into_inner);
        match (result, seen, expected) {
            (Ok(stream), Some(fp), _) => {
                if expected.is_none() {
                    self.trust(&key, &fp);
                }
                Ok((stream, fp))
            }
            (_, Some(fp), Some(pinned)) if fp != pinned => Err(mismatch(&key, &pinned, &fp, &self.path)),
            (Ok(_), None, _) => Err(Error::Protocol(format!("{authority} presented no TLS certificate"))),
            (Err(e), _, _) => Err(Error::Unreachable(format!("TLS handshake with {authority} failed: {e}{}", hint(&e)))),
        }
    }
}

/// Many printers (e.g. 2019-era HP LaserJets) offer only DHE or static-RSA key exchange.
fn hint(e: &std::io::Error) -> &'static str {
    let refused = e.get_ref().and_then(|inner| inner.downcast_ref::<rustls::Error>());
    if matches!(refused, Some(rustls::Error::AlertReceived(rustls::AlertDescription::HandshakeFailure))) {
        " (the printer offers no ECDHE cipher suite; use its ipp:// route)"
    } else {
        ""
    }
}

fn mismatch(key: &str, pinned: &Fingerprint, seen: &Fingerprint, path: &Path) -> Error {
    let msg = format!(
        "TLS certificate for {key} changed: pinned sha256 {} but the printer presented {}. If the printer was \
         reset or replaced, delete this entry from {} to trust the new certificate",
        hex(pinned),
        hex(seen),
        path.display()
    );
    log::error!("{msg}");
    Error::Rejected(msg)
}

#[derive(Debug)]
struct PinVerifier {
    expected: Option<Fingerprint>,
    seen: Mutex<Option<Fingerprint>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let fp = fingerprint(end_entity.as_ref());
        *self.seen.lock().unwrap_or_else(PoisonError::into_inner) = Some(fp);
        match self.expected {
            Some(pinned) if pinned != fp => Err(rustls::Error::General("certificate does not match its pin".into())),
            _ => Ok(ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

fn fingerprint(der: &[u8]) -> Fingerprint {
    let mut out = [0u8; 32];
    out.copy_from_slice(ring::digest::digest(&ring::digest::SHA256, der).as_ref());
    out
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn from_hex(s: &str) -> Option<Fingerprint> {
    let mut out = [0u8; 32];
    if s.len() != 64 {
        return None;
    }
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}
