//! SNMPv1 discovery the way CUPS does it: broadcast a GetRequest for hrDeviceType on every IPv4
//! interface, then ask each printer for its model and IEEE 1284 Device ID, one OID per request.

mod ber;
mod status;

pub(crate) use status::status;

use super::found::{Found, SNMP};
use crate::device_id::DeviceId;
use crate::model::{Capabilities, RouteKind};
use ber::{Oid, SnmpValue};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::UdpSocket;
use tokio::task::JoinSet;
use tokio::time::Instant;

const COMMUNITY: &str = "public";
const MAX_HOSTS: usize = 64;
const HR_DEVICE_TYPE: &[u32] = &[1, 3, 6, 1, 2, 1, 25, 3, 2, 1, 2, 1];
const HR_DEVICE_PRINTER: &[u32] = &[1, 3, 6, 1, 2, 1, 25, 3, 1, 5];
const HR_DEVICE_DESCR: &[u32] = &[1, 3, 6, 1, 2, 1, 25, 3, 2, 1, 3, 1];
const PPM_DEVICE_ID: &[u32] = &[1, 3, 6, 1, 4, 1, 2699, 1, 2, 1, 2, 1, 1, 3, 1];
const HP_DEVICE_ID: &[u32] = &[1, 3, 6, 1, 4, 1, 11, 2, 3, 9, 1, 1, 7, 0];
const SYS_LOCATION: &[u32] = &[1, 3, 6, 1, 2, 1, 1, 6, 0];

pub(crate) async fn discover(window: Duration) -> Vec<Found> {
    let hosts = broadcast(window.min(Duration::from_secs(2))).await;
    let mut tasks = JoinSet::new();
    for ip in hosts.into_iter().take(MAX_HOSTS) {
        tasks.spawn(describe(ip));
    }
    let mut out = Vec::new();
    while let Some(done) = tasks.join_next().await {
        out.extend(done.ok());
    }
    out
}

/// Addresses of hosts whose hrDeviceType.1 says "printer".
async fn broadcast(wait: Duration) -> Vec<Ipv4Addr> {
    let socket = match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await {
        Ok(s) => s,
        Err(e) => {
            log::warn!("SNMP discovery: cannot open a UDP socket: {e}");
            return Vec::new();
        }
    };
    if let Err(e) = socket.set_broadcast(true) {
        log::warn!("SNMP discovery: broadcast not permitted: {e}");
        return Vec::new();
    }
    let interfaces = if_addrs::get_if_addrs().unwrap_or_default();
    let own: HashSet<IpAddr> = interfaces.iter().map(|i| i.ip()).collect();
    let request = ber::request(COMMUNITY, request_base(), HR_DEVICE_TYPE, false);
    for interface in &interfaces {
        let if_addrs::IfAddr::V4(v4) = &interface.addr else { continue };
        let Some(broadcast) = v4.broadcast.filter(|_| !v4.ip.is_loopback()) else { continue };
        if let Err(e) = socket.send_to(&request, (broadcast, 161)).await {
            log::debug!("SNMP broadcast on {}: {e}", interface.name);
        }
    }
    let deadline = Instant::now() + wait;
    let mut buf = vec![0u8; 2048];
    let mut found: Vec<Ipv4Addr> = Vec::new();
    while let Ok(Ok((n, SocketAddr::V4(from)))) = tokio::time::timeout_at(deadline, socket.recv_from(&mut buf)).await {
        let is_printer = ber::parse(&buf[..n]).is_some_and(|r| {
            r.error_status == 0 && r.varbinds.iter().any(|(_, v)| *v == SnmpValue::Oid(HR_DEVICE_PRINTER.to_vec()))
        });
        if is_printer && !own.contains(&IpAddr::V4(*from.ip())) && !found.contains(from.ip()) {
            found.push(*from.ip());
        }
    }
    found
}

async fn describe(ip: Ipv4Addr) -> Found {
    let ip = IpAddr::V4(ip);
    let answers = query(ip, &[HR_DEVICE_DESCR, PPM_DEVICE_ID, HP_DEVICE_ID, SYS_LOCATION], false).await;
    let text = |i: usize| answers.get(i).and_then(Option::as_ref).and_then(|(_, v)| v.text());
    let device_id = text(1).or_else(|| text(2)).map(|raw| DeviceId::parse(&raw));
    let make_model = device_id.as_ref().and_then(DeviceId::make_model).or_else(|| text(0));
    let mut f = Found {
        origins: SNMP,
        name: make_model.clone().map(|m| (1, m)),
        make_model: make_model.map(|m| (1, m)),
        location: text(3),
        ..Found::default()
    };
    f.add_host(&ip.to_string());
    f.add_route(RouteKind::Socket, format!("socket://{ip}:9100"));
    let formats = device_id.map(|id| id.formats()).unwrap_or_default();
    if !formats.is_empty() {
        f.capabilities = Some((2, Capabilities { formats, ..Capabilities::default() }));
    }
    f
}

/// Sends one request per OID (SNMPv1 fails a whole PDU when any varbind is missing) and returns
/// each answer by position; unanswered or failed ones are None. One retry for lost datagrams.
pub(super) async fn query(ip: IpAddr, oids: &[&[u32]], next: bool) -> Vec<Option<(Oid, SnmpValue)>> {
    let mut out: Vec<Option<(Oid, SnmpValue)>> = vec![None; oids.len()];
    let local: SocketAddr = if ip.is_ipv4() { (Ipv4Addr::UNSPECIFIED, 0).into() } else { (std::net::Ipv6Addr::UNSPECIFIED, 0).into() };
    let Ok(socket) = UdpSocket::bind(local).await else { return out };
    if socket.connect((ip, 161)).await.is_err() {
        return out;
    }
    let base = request_base();
    let mut answered = vec![false; oids.len()];
    let mut buf = vec![0u8; 8192];
    for _attempt in 0..2 {
        for (i, oid) in oids.iter().enumerate().filter(|(i, _)| !answered[*i]) {
            let id = base.wrapping_add(i32::try_from(i).unwrap_or(0));
            if socket.send(&ber::request(COMMUNITY, id, oid, next)).await.is_err() {
                return out;
            }
        }
        let deadline = Instant::now() + Duration::from_millis(700);
        while answered.contains(&false) {
            let Ok(Ok(n)) = tokio::time::timeout_at(deadline, socket.recv(&mut buf)).await else { break };
            let Some(resp) = ber::parse(&buf[..n]) else { continue };
            let Some(i) = usize::try_from(resp.request_id.wrapping_sub(base)).ok().filter(|&i| i < oids.len()) else { continue };
            answered[i] = true;
            if resp.error_status == 0 {
                out[i] = resp.varbinds.into_iter().next().filter(|(_, v)| *v != SnmpValue::Null);
            }
        }
        if !answered.contains(&false) {
            break;
        }
    }
    out
}

/// Request ids that differ between runs, so late answers to an old query are not mistaken.
fn request_base() -> i32 {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
    i32::try_from(nanos & 0x3FFF_0000).unwrap_or(0x1000_0000)
}
