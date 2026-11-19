//! Printer Description attributes -> PrinterAttrs, shared by Get-Printer-Attributes and
//! CUPS-Get-Printers (one printer group each).

use super::client::PrinterAttrs;
use super::job::{quality, sides};
use super::tags::{op, printer_state};
use super::value::{Attribute, Group, Value};
use crate::model::{Capabilities, PrinterState, PrinterStatus, Supply, SupplyKind};

pub const REQUESTED: &[&str] = &[
    "printer-name",
    "printer-info",
    "printer-make-and-model",
    "printer-uuid",
    "printer-location",
    "printer-state",
    "printer-state-reasons",
    "printer-state-message",
    "printer-is-accepting-jobs",
    "document-format-supported",
    "color-supported",
    "print-color-mode-supported",
    "sides-supported",
    "sides-default",
    "media-supported",
    "media-default",
    "media-source-supported",
    "media-type-supported",
    "print-quality-supported",
    "printer-resolution-supported",
    "copies-supported",
    "page-ranges-supported",
    "marker-names",
    "marker-types",
    "marker-levels",
    "marker-colors",
    "urf-supported",
    "pwg-raster-document-resolution-supported",
    "pwg-raster-document-type-supported",
    "operations-supported",
    "identify-actions-supported",
];

pub fn parse(g: &Group) -> PrinterAttrs {
    let text = |name: &str| g.get(name).and_then(Attribute::str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let strs = |name: &str| -> Vec<String> { g.get(name).map(|a| a.strs().map(str::to_string).collect()).unwrap_or_default() };
    PrinterAttrs {
        name: text("printer-info").or_else(|| text("printer-name")),
        make_model: text("printer-make-and-model"),
        uuid: text("printer-uuid").as_deref().and_then(bare_uuid),
        location: text("printer-location"),
        capabilities: capabilities(g),
        status: status(g),
        urf_supported: strs("urf-supported"),
        pwg_resolutions: dpis(g.get("pwg-raster-document-resolution-supported")),
        pwg_types: strs("pwg-raster-document-type-supported"),
        identify_supported: g.get("operations-supported").is_some_and(|a| a.ints().any(|o| o == i32::from(op::IDENTIFY_PRINTER)))
            || g.get("identify-actions-supported").is_some(),
        page_ranges_supported: page_ranges_supported(g),
        sides_default: g.get("sides-default").and_then(Attribute::str).and_then(sides),
        auto_sense: g.get("document-format-supported").is_some_and(|a| a.strs().any(|f| f == "application/octet-stream")),
    }
}

/// Upper bound of copies-supported.
pub fn copies_max(g: &Group) -> Option<i32> {
    match g.get("copies-supported")?.values.first()? {
        Value::Range(_, hi) => Some(*hi),
        Value::Integer(n) => Some(*n),
        _ => None,
    }
}

pub fn page_ranges_supported(g: &Group) -> bool {
    g.get("page-ranges-supported").and_then(Attribute::bool).unwrap_or(false)
}

fn capabilities(g: &Group) -> Capabilities {
    let has = |name: &str, f: &dyn Fn(&str) -> bool| g.get(name).is_some_and(|a| a.strs().any(f));
    let strs = |name: &str| -> Vec<String> { g.get(name).map(|a| a.strs().map(str::to_string).collect()).unwrap_or_default() };
    let color = g.get("color-supported").and_then(Attribute::bool).unwrap_or(false)
        || has("print-color-mode-supported", &|m| m == "color");
    Capabilities {
        formats: g
            .get("document-format-supported")
            .map(|a| a.strs().filter(|f| *f != "application/octet-stream").map(str::to_string).collect())
            .unwrap_or_default(),
        color,
        duplex: has("sides-supported", &|s| s.starts_with("two-sided")),
        media: g
            .get("media-supported")
            .map(|a| a.strs().filter(|m| !m.starts_with("custom_")).map(str::to_string).collect())
            .unwrap_or_default(),
        media_default: g.get("media-default").and_then(Attribute::str).map(str::to_string),
        resolutions: dpis(g.get("printer-resolution-supported")),
        copies_max: copies_max(g).and_then(|n| u32::try_from(n).ok()).unwrap_or(1).max(1),
        sources: strs("media-source-supported"),
        media_types: strs("media-type-supported"),
        qualities: g.get("print-quality-supported").map(|a| a.ints().filter_map(quality).collect()).unwrap_or_default(),
    }
}

pub fn status(g: &Group) -> PrinterStatus {
    let state = match g.get("printer-state").and_then(Attribute::int) {
        Some(printer_state::IDLE) => PrinterState::Idle,
        Some(printer_state::PROCESSING) => PrinterState::Printing,
        Some(printer_state::STOPPED) => PrinterState::Stopped,
        _ => PrinterState::Unknown,
    };
    let mut reasons: Vec<String> = Vec::new();
    for r in g.get("printer-state-reasons").map(|a| a.strs().collect::<Vec<_>>()).unwrap_or_default() {
        let r = strip_severity(r);
        if r != "none" && !r.is_empty() && !reasons.iter().any(|x| x == r) {
            reasons.push(r.to_string());
        }
    }
    let accepting = g.get("printer-is-accepting-jobs").and_then(Attribute::bool).unwrap_or(true);
    let message = g
        .get("printer-state-message")
        .and_then(Attribute::str)
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .or_else(|| (!accepting).then(|| "Not accepting jobs".to_string()));
    PrinterStatus { state, reasons, message, supplies: supplies(g) }
}

/// "media-empty-error" -> "media-empty".
pub fn strip_severity(reason: &str) -> &str {
    ["-report", "-warning", "-error"].iter().find_map(|s| reason.strip_suffix(s)).unwrap_or(reason)
}

/// "urn:uuid:ABC-..." or "ABC-..." -> "abc-...".
pub fn bare_uuid(s: &str) -> Option<String> {
    let s = s.trim();
    let bare = s.get(..9).filter(|p| p.eq_ignore_ascii_case("urn:uuid:")).map_or(s, |_| &s[9..]);
    (!bare.is_empty()).then(|| bare.to_ascii_lowercase())
}

fn supplies(g: &Group) -> Vec<Supply> {
    let Some(names) = g.get("marker-names") else { return Vec::new() };
    let types: Vec<&str> = g.get("marker-types").map(|a| a.strs().collect()).unwrap_or_default();
    let levels: Vec<i32> = g.get("marker-levels").map(|a| a.ints().collect()).unwrap_or_default();
    let colors: Vec<&str> = g.get("marker-colors").map(|a| a.strs().collect()).unwrap_or_default();
    names
        .strs()
        .enumerate()
        .map(|(i, name)| Supply {
            name: name.to_string(),
            kind: supply_kind(types.get(i).copied().unwrap_or("other")),
            color: colors.get(i).and_then(|c| css_color(c)),
            level: levels.get(i).map_or(-1, |&l| if l < 0 { -1 } else { l.min(100) }),
        })
        .collect()
}

pub fn supply_kind(t: &str) -> SupplyKind {
    let t = t.to_ascii_lowercase();
    if t.starts_with("waste") {
        SupplyKind::Waste
    } else if t.contains("toner") {
        SupplyKind::Toner
    } else if t.contains("ink") || t == "solid-wax" {
        SupplyKind::Ink
    } else if t == "opc" || t.contains("drum") || t.contains("photo") {
        SupplyKind::Drum
    } else {
        SupplyKind::Other
    }
}

/// First "#RRGGBB" of a marker-colors value ("#00FFFF#FF00FF" lists several), else None.
fn css_color(c: &str) -> Option<String> {
    let hex = c.strip_prefix('#')?.get(..6)?;
    hex.chars().all(|ch| ch.is_ascii_hexdigit()).then(|| format!("#{}", hex.to_ascii_uppercase()))
}

/// Resolutions in dots per inch, ascending and deduplicated.
fn dpis(attr: Option<&Attribute>) -> Vec<u32> {
    let mut out: Vec<u32> = attr
        .map(|a| {
            a.values
                .iter()
                .filter_map(|v| match v {
                    Value::Resolution(x, _, 3) => u32::try_from(*x).ok(),
                    Value::Resolution(x, _, 4) => u32::try_from((f64::from(*x) * 2.54).round() as i64).ok(),
                    _ => None,
                })
                .filter(|&d| d > 0)
                .collect()
        })
        .unwrap_or_default();
    out.sort_unstable();
    out.dedup();
    out
}
