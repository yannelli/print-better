//! One sighting of a printer by one discovery source, before merging.

use crate::model::{Capabilities, PrinterReport, PrinterStatus, Route, RouteKind};

/// Trust in a source's value for a field; the highest rank wins when sightings merge.
pub type Rank = u8;

/// Bit set of the sources behind a sighting. Two sightings from one source are distinct printers
/// unless an identity says otherwise (e.g. two queues on one print server).
pub const MDNS: u8 = 1;
pub const SNMP: u8 = 2;
pub const CUPS: u8 = 4;
pub const BACKEND: u8 = 8;

#[derive(Clone, Debug, Default)]
pub struct Found {
    pub origins: u8,
    /// Source-provided key (`usb:…`, `os:…`), used when the printer has no uuid.
    pub key: Option<String>,
    pub name: Option<(Rank, String)>,
    pub make_model: Option<(Rank, String)>,
    /// Bare printer-uuid of the device itself.
    pub uuid: Option<String>,
    /// Identifiers that prove two sightings are one printer: `uuid:<queue uuid>`, `serial:<usb serial>`.
    pub ids: Vec<String>,
    pub location: Option<String>,
    /// Lowercase host names and IP literals the printer answers on.
    pub hosts: Vec<String>,
    pub local: bool,
    pub routes: Vec<Route>,
    pub capabilities: Option<(Rank, Capabilities)>,
    pub status: Option<(Rank, PrinterStatus)>,
}

impl Found {
    /// A report from a backend enumerator (USB, Windows spooler).
    pub fn from_report(r: PrinterReport, name_rank: Rank) -> Found {
        let serial = r.routes.iter().filter(|route| route.kind == RouteKind::Usb).find_map(|route| usb_serial(&route.uri));
        let hosts = r.routes.iter().filter_map(|route| uri_host(&route.uri)).collect();
        Found {
            origins: BACKEND,
            key: Some(r.key),
            name: Some((name_rank, r.name)),
            make_model: r.make_model.map(|m| (2, m)),
            uuid: r.uuid,
            ids: serial.map(|s| format!("serial:{s}")).into_iter().collect(),
            location: r.location,
            hosts,
            local: r.local,
            routes: r.routes,
            capabilities: Some((3, r.capabilities)),
            status: Some((3, r.status)),
        }
    }

    pub fn add_host(&mut self, host: &str) {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        if !host.is_empty() && !self.hosts.contains(&host) {
            self.hosts.push(host);
        }
    }

    pub fn add_route(&mut self, kind: RouteKind, uri: String) {
        if !self.routes.iter().any(|r| r.uri == uri) {
            self.routes.push(Route { kind, uri });
        }
    }
}

/// Keeps the higher-ranked of two values (the existing one on ties).
pub fn better<T>(a: Option<(Rank, T)>, b: Option<(Rank, T)>) -> Option<(Rank, T)> {
    match (a, b) {
        (Some(a), Some(b)) => Some(if b.0 > a.0 { b } else { a }),
        (a, b) => a.or(b),
    }
}

/// Serial from `usb://VVVV:PPPP/SERIAL?if=N` (`-` means none).
fn usb_serial(uri: &str) -> Option<String> {
    let path = uri.strip_prefix("usb://")?.split(['?', '#']).next()?;
    let serial = percent_decode(path.split_once('/')?.1);
    (!serial.is_empty() && serial != "-").then_some(serial)
}

/// Host of a network URI (`ipp://h:631/x`, `socket://h`, `lpd://[v6]/q`), lowercased.
pub fn uri_host(uri: &str) -> Option<String> {
    let (scheme, rest) = uri.split_once("://")?;
    if !matches!(scheme.to_ascii_lowercase().as_str(), "ipp" | "ipps" | "http" | "https" | "socket" | "lpd") {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next()?,
        None => authority.rsplit_once(':').map_or(authority, |(h, _)| h),
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// Value of `name=` in a URI query string, percent-decoded.
pub fn query_param(uri: &str, name: &str) -> Option<String> {
    let query = uri.split_once('?')?.1.split('#').next()?;
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        k.eq_ignore_ascii_case(name).then(|| percent_decode(v))
    })
}

pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .filter(|h| h.iter().all(u8::is_ascii_hexdigit))
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
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
