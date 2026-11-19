//! Host name resolution with an mDNS fallback: static musl builds have no nss-mdns, so `.local`
//! names only resolve by asking the network directly.

use crate::discovery::mdns::Daemon;
use crate::error::{Error, Result};
use mdns_sd::HostnameResolutionEvent;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tokio::time::Instant;

const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
const MDNS_TIMEOUT: Duration = Duration::from_secs(3);

/// Addresses for `host`, IPv4 first.
pub async fn resolve(host: &str, port: u16) -> Result<Vec<SocketAddr>> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    if let Ok(Ok(found)) = tokio::time::timeout(LOOKUP_TIMEOUT, tokio::net::lookup_host((host, port))).await {
        let mut addrs: Vec<SocketAddr> = found.collect();
        addrs.sort_by_key(SocketAddr::is_ipv6);
        if !addrs.is_empty() {
            return Ok(addrs);
        }
    }
    if host.to_ascii_lowercase().ends_with(".local")
        && let Some(ips) = mdns(host).await
    {
        return Ok(ips.into_iter().map(|ip| SocketAddr::new(ip, port)).collect());
    }
    Err(Error::Unreachable(format!("cannot resolve {host}")))
}

async fn mdns(host: &str) -> Option<Vec<IpAddr>> {
    let daemon = Daemon::new()?;
    let events = daemon.resolve_hostname(&format!("{host}."), Some(MDNS_TIMEOUT.as_millis() as u64)).ok()?;
    let deadline = Instant::now() + MDNS_TIMEOUT;
    while let Ok(Ok(event)) = tokio::time::timeout_at(deadline, events.recv_async()).await {
        if let HostnameResolutionEvent::AddressesFound(_, found) = event {
            let mut ips: Vec<IpAddr> = found.iter().map(|ip| ip.to_ip_addr()).filter(usable).collect();
            ips.sort_by_key(IpAddr::is_ipv6);
            if !ips.is_empty() {
                return Some(ips);
            }
        }
    }
    None
}

/// Link-local IPv6 needs a scope id that a plain URI or SocketAddr parse would lose.
pub fn usable(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => !v4.is_unspecified() && !v4.is_loopback(),
        IpAddr::V6(v6) => !v6.is_unspecified() && !v6.is_loopback() && (v6.segments()[0] & 0xffc0) != 0xfe80,
    }
}
