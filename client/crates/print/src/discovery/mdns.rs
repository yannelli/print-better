//! mDNS/DNS-SD browsing for printers. Routes use the resolved addresses, never `.local` names,
//! because static musl builds cannot resolve them.

use super::found::{Found, MDNS};
use crate::ipp::resolve::usable;
use crate::model::{Capabilities, RouteKind};
use mdns_sd::{Receiver, ServiceDaemon, ServiceEvent};
use std::collections::HashMap;
use std::net::IpAddr;
use std::ops::Deref;
use std::time::Duration;
use tokio::time::Instant;

/// An mdns-sd daemon whose thread stops when this is dropped; dropping the bare handle leaves it running.
pub(crate) struct Daemon(ServiceDaemon);

impl Daemon {
    pub fn new() -> Option<Daemon> {
        ServiceDaemon::new().map(Daemon).map_err(|e| log::warn!("mDNS unavailable: {e}")).ok()
    }
}

impl Deref for Daemon {
    type Target = ServiceDaemon;

    fn deref(&self) -> &ServiceDaemon {
        &self.0
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if let Err(e) = self.0.shutdown() {
            log::debug!("mDNS shutdown: {e}");
        }
    }
}

struct Sighting {
    kind: RouteKind,
    instance: String,
    host: String,
    port: u16,
    ips: Vec<IpAddr>,
    /// TXT keys lowercased.
    txt: HashMap<String, String>,
}

pub(crate) async fn browse(window: Duration) -> Vec<Found> {
    let Some(daemon) = Daemon::new() else { return Vec::new() };
    let deadline = Instant::now() + window;
    let start = |ty: &str| daemon.browse(ty).map_err(|e| log::warn!("mDNS browse {ty}: {e}")).ok();
    let (ipps, ipp, socket, lpd) = tokio::join!(
        collect(start("_ipps._tcp.local."), RouteKind::Ipps, deadline),
        collect(start("_ipp._tcp.local."), RouteKind::Ipp, deadline),
        collect(start("_pdl-datastream._tcp.local."), RouteKind::Socket, deadline),
        collect(start("_printer._tcp.local."), RouteKind::Lpd, deadline),
    );
    drop(daemon);
    let mut by_device: HashMap<(String, String), Vec<Sighting>> = HashMap::new();
    for s in [ipps, ipp, socket, lpd].into_iter().flatten() {
        by_device.entry((s.instance.to_lowercase(), s.host.clone())).or_default().push(s);
    }
    by_device.into_values().filter_map(found).collect()
}

async fn collect(events: Option<Receiver<ServiceEvent>>, kind: RouteKind, deadline: Instant) -> Vec<Sighting> {
    let Some(events) = events else { return Vec::new() };
    let mut seen: HashMap<String, Sighting> = HashMap::new();
    while let Ok(Ok(event)) = tokio::time::timeout_at(deadline, events.recv_async()).await {
        let ServiceEvent::ServiceResolved(svc) = event else { continue };
        let key = svc.get_fullname().to_lowercase();
        let mut ips: Vec<IpAddr> = svc.get_addresses().iter().map(|ip| ip.to_ip_addr()).filter(usable).collect();
        for ip in seen.get(&key).map(|old| old.ips.as_slice()).unwrap_or_default() {
            if !ips.contains(ip) {
                ips.push(*ip);
            }
        }
        let txt = svc.get_properties().iter().map(|p| (p.key().to_ascii_lowercase(), p.val_str().trim().to_string())).collect();
        let sighting = Sighting {
            kind,
            instance: mdns_sd::instance_name_unescaped(svc.get_fullname()),
            host: svc.get_hostname().trim_end_matches('.').to_ascii_lowercase(),
            port: svc.get_port(),
            ips,
            txt,
        };
        seen.insert(key, sighting);
    }
    seen.into_values().collect()
}

/// All services one device advertises under one instance name.
fn found(sightings: Vec<Sighting>) -> Option<Found> {
    // Our own LAN shares (and other Print Better clients') carry this key; listing them would loop.
    if sightings.iter().any(|s| s.txt.contains_key("printbetter")) {
        return None;
    }
    let txt = |key: &str| sightings.iter().find_map(|s| s.txt.get(key).filter(|v| !v.is_empty()).cloned());
    let mut f = Found { origins: MDNS, ..Found::default() };
    for s in &sightings {
        let Some(ip) = s.ips.iter().find(|ip| ip.is_ipv4()).or_else(|| s.ips.first()) else { continue };
        let host = if ip.is_ipv6() { format!("[{ip}]") } else { ip.to_string() };
        let rp = s.txt.get("rp").map_or("", |rp| rp.trim_start_matches('/'));
        let uri = match s.kind {
            RouteKind::Ipps => format!("ipps://{host}:{}/{rp}", s.port),
            RouteKind::Ipp => format!("ipp://{host}:{}/{rp}", s.port),
            RouteKind::Socket => format!("socket://{host}:{}", s.port),
            // Port 0 is the flagship-naming placeholder, not an LPD server; LPD needs a queue name.
            RouteKind::Lpd if s.port != 0 && !rp.is_empty() => format!("lpd://{host}:{}/{rp}", s.port),
            _ => continue,
        };
        f.add_route(s.kind, uri);
        f.add_host(&s.host);
        for ip in &s.ips {
            f.add_host(&ip.to_string());
        }
    }
    if f.routes.is_empty() {
        return None;
    }
    let instance = sightings.first().map(|s| s.instance.clone()).unwrap_or_default();
    f.name = (!instance.is_empty()).then_some((3, instance));
    f.uuid = txt("uuid").as_deref().and_then(crate::ipp::printer::bare_uuid);
    f.location = txt("note");
    let usb_model = txt("usb_mfg").zip(txt("usb_mdl")).map(|(m, d)| format!("{m} {d}"));
    let product = txt("product").map(|p| p.trim_start_matches('(').trim_end_matches(')').to_string());
    f.make_model = txt("ty").or(usb_model).or(product).map(|m| (2, m));
    let formats = txt("pdl").map(|pdl| {
        pdl.split(',').map(str::trim).filter(|m| !m.is_empty() && *m != "application/octet-stream").map(str::to_string).collect()
    });
    let caps = Capabilities {
        formats: formats.unwrap_or_default(),
        color: txt("color").is_some_and(|v| v.eq_ignore_ascii_case("t")),
        duplex: txt("duplex").is_some_and(|v| v.eq_ignore_ascii_case("t")),
        ..Capabilities::default()
    };
    f.capabilities = Some((2, caps));
    Some(f)
}

#[cfg(test)]
#[path = "tests/mdns_txt.rs"]
mod tests;
