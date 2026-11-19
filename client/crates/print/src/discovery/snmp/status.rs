//! Printer status over SNMP (HOST-RESOURCES-MIB + Printer MIB, RFC 3805) for printers reachable
//! only by socket or LPD.

use super::ber::{Oid, SnmpValue};
use super::query;
use crate::model::{PrinterState, PrinterStatus, Supply, SupplyKind};
use std::net::IpAddr;

const HR_DEVICE_STATUS: &[u32] = &[1, 3, 6, 1, 2, 1, 25, 3, 2, 1, 5, 1];
const HR_PRINTER_STATUS: &[u32] = &[1, 3, 6, 1, 2, 1, 25, 3, 5, 1, 1, 1];
const HR_ERROR_STATE: &[u32] = &[1, 3, 6, 1, 2, 1, 25, 3, 5, 1, 2, 1];
const SUPPLIES: &[u32] = &[1, 3, 6, 1, 2, 1, 43, 11, 1, 1];
const MAX_SUPPLIES: usize = 16;

/// hrPrinterDetectedErrorState bits, MSB of the first byte first: (reason, stops printing).
const ERROR_BITS: [(&str, bool); 15] = [
    ("media-low", false),
    ("media-empty", true),
    ("toner-low", false),
    ("toner-empty", true),
    ("door-open", true),
    ("media-jam", true),
    ("offline", true),
    ("other", false),
    ("input-tray-missing", true),
    ("output-tray-missing", true),
    ("marker-supply-missing", true),
    ("output-area-almost-full", false),
    ("output-area-full", true),
    ("media-empty", false),
    ("other", false),
];

pub(crate) async fn status(host: &str) -> Option<PrinterStatus> {
    let ip = match host.trim_matches(['[', ']']).parse::<IpAddr>() {
        Ok(ip) => ip,
        Err(_) => crate::ipp::resolve::resolve(host, 161).await.ok()?.first()?.ip(),
    };
    let answers = query(ip, &[HR_DEVICE_STATUS, HR_PRINTER_STATUS, HR_ERROR_STATE], false).await;
    if answers.iter().all(Option::is_none) {
        return None;
    }
    let int = |i: usize| answers.get(i).and_then(Option::as_ref).and_then(|(_, v)| v.int());
    let errors = match answers.get(2).and_then(Option::as_ref) {
        Some((_, SnmpValue::Bytes(bits))) => Some(bits.as_slice()),
        _ => None,
    };
    let (state, reasons) = interpret(int(0), int(1), errors);
    Some(PrinterStatus { state, reasons, message: None, supplies: supplies(ip).await })
}

/// hrDeviceStatus, hrPrinterStatus and hrPrinterDetectedErrorState -> state and reasons.
fn interpret(device: Option<i64>, printer: Option<i64>, errors: Option<&[u8]>) -> (PrinterState, Vec<String>) {
    let mut stopped = device == Some(5);
    let mut reasons: Vec<String> = Vec::new();
    for (bit, (reason, stops)) in ERROR_BITS.iter().enumerate() {
        let set = errors.and_then(|e| e.get(bit / 8)).is_some_and(|byte| byte & (0x80 >> (bit % 8)) != 0);
        if set && !reasons.iter().any(|r| r == reason) {
            reasons.push((*reason).to_string());
            stopped |= *stops;
        }
    }
    let state = match (stopped, printer, device) {
        (true, _, _) => PrinterState::Stopped,
        (_, Some(4 | 5), _) => PrinterState::Printing,
        (_, Some(3), _) | (_, _, Some(2 | 3)) => PrinterState::Idle,
        _ => PrinterState::Unknown,
    };
    (state, reasons)
}

/// Walks prtMarkerSuppliesDescription with GetNext, then reads type, capacity, and level per row.
async fn supplies(ip: IpAddr) -> Vec<Supply> {
    let column = |col: u32| -> Oid { [SUPPLIES, &[col, 1]].concat() };
    let descriptions = column(6);
    let mut rows: Vec<(u32, String)> = Vec::new();
    let mut cursor = descriptions.clone();
    while rows.len() < MAX_SUPPLIES {
        let Some(Some((oid, value))) = query(ip, &[&cursor], true).await.pop() else { break };
        let Some(&index) = oid.strip_prefix(descriptions.as_slice()).and_then(|rest| rest.first()).filter(|_| oid.len() == descriptions.len() + 1)
        else {
            break;
        };
        rows.push((index, value.text().unwrap_or_default()));
        cursor = oid;
    }
    let oids: Vec<Oid> = rows.iter().flat_map(|&(i, _)| [5, 8, 9].map(|col| [column(col), vec![i]].concat())).collect();
    let refs: Vec<&[u32]> = oids.iter().map(Vec::as_slice).collect();
    let answers = query(ip, &refs, false).await;
    let int = |i: usize| answers.get(i).and_then(Option::as_ref).and_then(|(_, v)| v.int());
    rows.into_iter()
        .enumerate()
        .map(|(k, (_, name))| {
            Supply { kind: kind(int(3 * k)), color: color(&name), level: percent(int(3 * k + 2), int(3 * k + 1)), name }
        })
        .collect()
}

/// prtMarkerSuppliesLevel as a percentage of MaxCapacity; -1 for the MIB's "unknown" and "some" values.
fn percent(level: Option<i64>, max: Option<i64>) -> i32 {
    match (level, max) {
        (Some(level), Some(max)) if level >= 0 && max > 0 => i32::try_from((level.saturating_mul(100) / max).clamp(0, 100)).unwrap_or(-1),
        _ => -1,
    }
}

/// PrtMarkerSuppliesTypeTC values.
fn kind(t: Option<i64>) -> SupplyKind {
    match t {
        Some(3 | 21) => SupplyKind::Toner,
        Some(5..=7 | 12 | 13) => SupplyKind::Ink,
        Some(9) => SupplyKind::Drum,
        Some(4 | 8 | 14 | 24 | 26) => SupplyKind::Waste,
        _ => SupplyKind::Other,
    }
}

/// The Printer MIB links colors through a separate colorant table; the description usually says it.
fn color(name: &str) -> Option<String> {
    let name = name.to_ascii_lowercase();
    [("black", "#000000"), ("cyan", "#00FFFF"), ("magenta", "#FF00FF"), ("yellow", "#FFFF00")]
        .iter()
        .find(|(word, _)| name.contains(word))
        .map(|(_, hex)| (*hex).to_string())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
