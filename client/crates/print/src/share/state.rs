//! Server state shared by every connection: the printers being served and the job table.

use super::jobs::Jobs;
use super::{ShareOptions, ShareSink, SharedPrinter};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};
use std::time::Instant;

const FALLBACK_MEDIA: [&str; 2] = ["na_letter_8.5x11in", "iso_a4_210x297mm"];

/// A shared printer plus everything derived from it once per `set_printers`.
pub(super) struct Served {
    pub printer: SharedPrinter,
    /// URL path segment: /ipp/print/<slug>.
    pub slug: String,
    /// Bare RFC 4122 uuid, stable for this host label and printer key.
    pub uuid: String,
    /// Input formats the engine can print to this printer, natively or after conversion.
    pub formats: Vec<&'static str>,
}

impl Served {
    pub fn new(printer: SharedPrinter, host_label: &str, fixed: Option<&'static [&'static str]>) -> Served {
        let formats = fixed.map_or_else(|| crate::convert::printable_formats(&printer.report.capabilities), <[_]>::to_vec);
        Served { slug: slug(&printer.key), uuid: uuid(host_label, &printer.key), formats, printer }
    }

    pub fn accepts(&self, mime: &str) -> bool {
        self.formats.iter().any(|f| f.eq_ignore_ascii_case(mime))
    }

    /// Media names to offer; printers that report none (USB 1284-only) get Letter and A4.
    pub fn media(&self) -> Vec<String> {
        let media = &self.printer.report.capabilities.media;
        if media.is_empty() { FALLBACK_MEDIA.iter().map(|m| m.to_string()).collect() } else { media.clone() }
    }

    pub fn media_default(&self) -> String {
        let caps = &self.printer.report.capabilities;
        caps.media_default.clone().or_else(|| self.media().into_iter().next()).unwrap_or_else(|| FALLBACK_MEDIA[0].to_string())
    }

    pub fn resolutions(&self) -> Vec<u32> {
        let r = &self.printer.report.capabilities.resolutions;
        if r.is_empty() { vec![300] } else { r.clone() }
    }

    /// urf-supported keywords (also the TXT URF key); empty when URF input is not printable.
    pub fn urf(&self) -> Vec<String> {
        if !self.accepts("image/urf") {
            return Vec::new();
        }
        let caps = &self.printer.report.capabilities;
        let rs = self.resolutions().iter().map(u32::to_string).collect::<Vec<_>>().join("-");
        let mut out = vec!["V1.4".to_string(), "CP1".into(), "W8".into()];
        if caps.color {
            out.push("SRGB24".into());
        }
        out.push(format!("RS{rs}"));
        if caps.duplex {
            out.push("DM1".into());
        }
        out
    }
}

pub(super) struct State {
    pub opts: ShareOptions,
    pub sink: Arc<dyn ShareSink>,
    /// Keyed by slug.
    printers: RwLock<HashMap<String, Arc<Served>>>,
    jobs: Mutex<Jobs>,
    started: Instant,
}

impl State {
    pub fn new(opts: ShareOptions, sink: Arc<dyn ShareSink>) -> State {
        State { opts, sink, printers: RwLock::new(HashMap::new()), jobs: Mutex::new(Jobs::new()), started: Instant::now() }
    }

    pub fn printer(&self, slug: &str) -> Option<Arc<Served>> {
        self.printers.read().unwrap_or_else(PoisonError::into_inner).get(slug).cloned()
    }

    pub fn set_printers(&self, served: HashMap<String, Arc<Served>>) {
        *self.printers.write().unwrap_or_else(PoisonError::into_inner) = served;
    }

    pub fn jobs(&self) -> MutexGuard<'_, Jobs> {
        self.jobs.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// printer-up-time: seconds since start, never 0 (RFC 8011 requires a positive value).
    pub fn up_time(&self) -> i32 {
        i32::try_from(self.started.elapsed().as_secs()).unwrap_or(i32::MAX).saturating_add(1)
    }
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    for p in parts {
        ctx.update(p);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(ctx.finish().as_ref());
    out
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub(super) fn slug(key: &str) -> String {
    hex(&sha256(&[key.as_bytes()])[..6])
}

/// Name-based (version 5 style) uuid, so the same printer keeps its identity across restarts.
fn uuid(host_label: &str, key: &str) -> String {
    let mut b = sha256(&[host_label.as_bytes(), b"\0", key.as_bytes()]);
    b[6] = (b[6] & 0x0f) | 0x50;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b[..16]);
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}
