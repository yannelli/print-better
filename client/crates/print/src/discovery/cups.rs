//! Local CUPS queues (macOS, Linux) via CUPS-Get-Printers. Each queue is an `os://` route; its
//! device-uri tells which physical printer it drives so the merge can fold it into that printer.

use super::found::{CUPS, Found, percent_encode, query_param, uri_host};
use crate::ipp::IppClient;
use crate::ipp::tags::{group, op};
use crate::ipp::uri::Target;
use crate::ipp::value::{Attribute, Group, Value};
use crate::ipp::printer;
use crate::model::RouteKind;

/// cups.h printer-type bits for queues that are not one physical printer.
const CUPS_PRINTER_CLASS: i32 = 0x0001;
const CUPS_PRINTER_IMPLICIT: i32 = 0x1_0000;
const CUPS_PRINTER_FAX: i32 = 0x4_0000;

pub(crate) async fn queues(ipp: &IppClient) -> Vec<Found> {
    if !cfg!(unix) {
        return Vec::new();
    }
    let Ok(target) = Target::parse("ipp://localhost:631/") else { return Vec::new() };
    let mut msg = ipp.request(op::CUPS_GET_PRINTERS, &target, None);
    let extra = ["device-uri", "printer-type", "printer-is-temporary"];
    let requested = printer::REQUESTED.iter().chain(extra.iter()).map(|n| Value::keyword(n)).collect();
    msg.operation().push_many("requested-attributes", requested);
    match ipp.call(&target, msg).await {
        Ok(resp) => resp.groups_of(group::PRINTER).filter_map(queue).collect(),
        Err(e) => {
            log::debug!("CUPS queues unavailable: {e}");
            Vec::new()
        }
    }
}

fn queue(g: &Group) -> Option<Found> {
    let name = g.get("printer-name").and_then(Attribute::str).filter(|n| !n.is_empty())?;
    let kind = g.get("printer-type").and_then(Attribute::int).unwrap_or(0);
    let temporary = g.get("printer-is-temporary").and_then(Attribute::bool).unwrap_or(false);
    if kind & (CUPS_PRINTER_CLASS | CUPS_PRINTER_IMPLICIT | CUPS_PRINTER_FAX) != 0 || temporary {
        return None;
    }
    let device = g.get("device-uri").and_then(Attribute::str).unwrap_or("");
    // Print Better's own remote-printer queues; reporting them would echo printers between devices.
    if name.starts_with("pb_") && uri_host(device).is_some_and(|h| is_loopback(&h)) {
        return None;
    }
    let attrs = printer::parse(g);
    let mut f = Found {
        origins: CUPS,
        key: Some(format!("os:{name}")),
        name: Some((5, attrs.name.unwrap_or_else(|| name.to_string()))),
        make_model: attrs.make_model.map(|m| (1, driver_free(&m))),
        location: attrs.location,
        local: is_local(device),
        capabilities: Some((1, attrs.capabilities)),
        status: Some((2, attrs.status)),
        ..Found::default()
    };
    f.add_route(RouteKind::Os, format!("os://{}", percent_encode(name)));
    // The queue's own printer-uuid is minted by CUPS; only a dnssd device-uri names the device's.
    f.ids.extend(attrs.uuid.map(|u| format!("uuid:{u}")));
    if device.starts_with("dnssd://") {
        f.uuid = query_param(device, "uuid").as_deref().and_then(printer::bare_uuid);
    }
    f.ids.extend(query_param(device, "serial").filter(|s| !s.is_empty()).map(|s| format!("serial:{s}")));
    if let Some(host) = uri_host(device).filter(|h| !is_loopback(h)) {
        f.add_host(&host);
    }
    Some(f)
}

/// Queues on USB, parallel or serial ports, or IPP-over-USB proxies on localhost.
fn is_local(device: &str) -> bool {
    let scheme = device.split(':').next().unwrap_or("").to_ascii_lowercase();
    matches!(scheme.as_str(), "usb" | "parallel" | "serial" | "ippusb")
        || device.starts_with("hp:/usb/")
        || uri_host(device).is_some_and(|h| is_loopback(&h))
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// "HP LaserJet Pro M404-M405, driverless, cups-filters 1.28.17" -> "HP LaserJet Pro M404-M405".
fn driver_free(make_model: &str) -> String {
    make_model.split(", ").next().unwrap_or(make_model).trim().to_string()
}

#[cfg(test)]
#[path = "tests/cups_queue.rs"]
mod tests;
