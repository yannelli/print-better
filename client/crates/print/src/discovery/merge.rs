//! Folds sightings of one physical printer into one report: stable key, best name, routes in
//! preference order.

use super::found::{Found, better, uri_host};
use crate::model::{PrinterReport, RouteKind};
use std::collections::HashMap;

/// Sightings sharing an identity (uuid, serial) are one printer; failing that, sightings from
/// different sources sharing exactly one host are. Disagreeing uuids never merge.
pub(crate) fn group(found: Vec<Found>) -> Vec<Found> {
    let mut groups: Vec<Found> = Vec::new();
    for f in found {
        let compatible: Vec<usize> = (0..groups.len()).filter(|&i| !conflict(&groups[i], &f)).collect();
        let strong: Vec<usize> = compatible.iter().copied().filter(|&i| shares_id(&groups[i], &f)).collect();
        let weak: Vec<usize> = compatible
            .iter()
            .copied()
            .filter(|&i| groups[i].origins & f.origins == 0 && shares_host(&groups[i], &f))
            .collect();
        let targets = if !strong.is_empty() { strong } else if weak.len() == 1 { weak } else { Vec::new() };
        let mut merged = f;
        for &i in targets.iter().rev() {
            if !conflict(&groups[i], &merged) {
                merged = absorb(groups.remove(i), merged);
            }
        }
        groups.push(merged);
    }
    groups
}

pub(crate) fn reports(found: Vec<Found>) -> Vec<PrinterReport> {
    let mut out: Vec<(PrinterReport, String)> = found.into_iter().filter_map(report).collect();
    dedupe_names(&mut out);
    let mut reports: Vec<PrinterReport> = out.into_iter().map(|(r, _)| r).collect();
    reports.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.key.cmp(&b.key)));
    reports
}

fn identities(f: &Found) -> impl Iterator<Item = String> + '_ {
    f.uuid.iter().map(|u| format!("uuid:{u}")).chain(f.ids.iter().cloned())
}

fn conflict(a: &Found, b: &Found) -> bool {
    matches!((&a.uuid, &b.uuid), (Some(x), Some(y)) if x != y)
}

fn shares_id(a: &Found, b: &Found) -> bool {
    let theirs: Vec<String> = identities(b).collect();
    identities(a).any(|id| theirs.contains(&id))
}

fn shares_host(a: &Found, b: &Found) -> bool {
    a.hosts.iter().any(|h| b.hosts.contains(h))
}

/// `a` wins ties; keys follow model.rs precedence (uuid, usb, os, net).
fn absorb(mut a: Found, b: Found) -> Found {
    a.key = match (a.key.take(), b.key) {
        (Some(x), Some(y)) => Some(if key_rank(&y) < key_rank(&x) { y } else { x }),
        (x, y) => x.or(y),
    };
    a.name = better(a.name.take(), b.name);
    a.make_model = better(a.make_model.take(), b.make_model);
    a.uuid = a.uuid.take().or(b.uuid);
    for id in b.ids {
        if !a.ids.contains(&id) {
            a.ids.push(id);
        }
    }
    a.location = a.location.take().or(b.location);
    for host in &b.hosts {
        a.add_host(host);
    }
    a.local |= b.local;
    a.origins |= b.origins;
    for route in b.routes {
        a.add_route(route.kind, route.uri);
    }
    a.capabilities = better(a.capabilities.take(), b.capabilities);
    a.status = better(a.status.take(), b.status);
    a
}

fn key_rank(key: &str) -> u8 {
    ["uuid:", "usb:", "os:", "net:"].iter().position(|p| key.starts_with(p)).map_or(4, |i| i as u8)
}

fn route_rank(kind: RouteKind, local: bool) -> u8 {
    use RouteKind::*;
    let order: [RouteKind; 6] = if local { [Os, Usb, Ipps, Ipp, Socket, Lpd] } else { [Ipps, Ipp, Socket, Lpd, Os, Usb] };
    order.iter().position(|k| *k == kind).map_or(6, |i| i as u8)
}

fn report(mut f: Found) -> Option<(PrinterReport, String)> {
    if f.routes.is_empty() {
        return None;
    }
    let local = f.local;
    f.routes.sort_by_key(|r| route_rank(r.kind, local));
    let key = f.uuid.as_ref().map(|u| format!("uuid:{u}")).or(f.key.take()).or_else(|| net_key(&f))?;
    let make_model = f.make_model.map(|(_, m)| m);
    let raw = f.name.map(|(_, n)| n).or_else(|| make_model.clone()).or_else(|| f.hosts.first().cloned()).unwrap_or_default();
    let report = PrinterReport {
        key,
        name: clean(&raw),
        make_model,
        uuid: f.uuid,
        location: f.location,
        local,
        routes: f.routes,
        capabilities: f.capabilities.map(|(_, c)| c).unwrap_or_default(),
        status: f.status.map(|(_, s)| s).unwrap_or_default(),
    };
    Some((report, raw))
}

/// `net:<host>:<port>` from the preferred route, naming the host by its mDNS name when known.
fn net_key(f: &Found) -> Option<String> {
    let route = f.routes.iter().find(|r| uri_host(&r.uri).is_some())?;
    let host = f.hosts.iter().find(|h| h.parse::<std::net::IpAddr>().is_err()).cloned().or_else(|| uri_host(&route.uri))?;
    let port = route
        .uri
        .split_once("://")
        .and_then(|(_, rest)| rest.split(['/', '?']).next())
        .and_then(|authority| authority.rsplit_once(':'))
        .and_then(|(_, p)| p.parse::<u16>().ok())
        .unwrap_or(match route.kind {
            RouteKind::Socket => 9100,
            RouteKind::Lpd => 515,
            _ => 631,
        });
    Some(format!("net:{host}:{port}"))
}

/// "HP_OfficeJet_Pro_9010_series [8D3A2B]" -> "HP OfficeJet Pro 9010".
fn clean(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    if !s.contains(' ') && s.contains('_') {
        s = s.replace('_', " ");
    }
    if let Some(stripped) = strip_tag(&s) {
        s = stripped;
    }
    if s.to_ascii_lowercase().ends_with(" series") {
        s.truncate(s.len() - " series".len());
    }
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() { "Printer".to_string() } else { s }
}

/// Drops a trailing " [14CB19]" or " (B2E6F1)": the MAC tail vendors append for uniqueness.
fn strip_tag(s: &str) -> Option<String> {
    let open = match s.chars().last()? {
        ']' => '[',
        ')' => '(',
        _ => return None,
    };
    let start = s.rfind(open)?;
    let inner = s.get(start + 1..s.len() - 1)?;
    let tag = (4..=12).contains(&inner.len()) && inner.chars().all(|c| c.is_ascii_hexdigit());
    (tag && start > 0).then(|| s[..start].trim_end().to_string())
}

/// Colliding names fall back to the raw name (which usually keeps the vendor's unique tag), then
/// get " (2)", " (3)" in key order.
fn dedupe_names(out: &mut [(PrinterReport, String)]) {
    let count = |out: &[(PrinterReport, String)]| {
        let mut n: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, (r, _)) in out.iter().enumerate() {
            n.entry(r.name.to_lowercase()).or_default().push(i);
        }
        n
    };
    for indexes in count(out).into_values().filter(|v| v.len() > 1) {
        for i in indexes {
            let raw = out[i].1.trim().to_string();
            if !raw.is_empty() {
                out[i].0.name = raw;
            }
        }
    }
    for mut indexes in count(out).into_values().filter(|v| v.len() > 1) {
        indexes.sort_by(|&a, &b| out[a].0.key.cmp(&out[b].0.key));
        for (n, &i) in indexes.iter().enumerate().skip(1) {
            out[i].0.name = format!("{} ({})", out[i].0.name, n + 1);
        }
    }
}
