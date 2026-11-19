//! Printer Description and Job Template attributes advertised for a shared printer: the subset of
//! PWG 5100.14 (IPP Everywhere) that phones and laptops query before printing.

use super::media;
use super::state::Served;
use crate::ipp::tags::{op, printer_state, value as tag};
use crate::ipp::{Attribute, Value};
use crate::model::{PrinterState, SupplyKind};

const OPERATIONS: [u16; 11] = [
    op::PRINT_JOB,
    op::VALIDATE_JOB,
    op::CREATE_JOB,
    op::SEND_DOCUMENT,
    op::CANCEL_JOB,
    op::GET_JOB_ATTRIBUTES,
    op::GET_JOBS,
    op::GET_PRINTER_ATTRIBUTES,
    op::CANCEL_MY_JOBS,
    op::CLOSE_JOB,
    op::IDENTIFY_PRINTER,
];

const CREATION_ATTRS: [&str; 10] = [
    "copies",
    "finishings",
    "media",
    "media-col",
    "orientation-requested",
    "page-ranges",
    "print-color-mode",
    "print-quality",
    "print-scaling",
    "sides",
];

const MEDIA_COL_MEMBERS: [&str; 7] = [
    "media-bottom-margin",
    "media-left-margin",
    "media-right-margin",
    "media-size",
    "media-source",
    "media-top-margin",
    "media-type",
];

#[derive(Default)]
struct Attrs(Vec<Attribute>);

impl Attrs {
    fn one(&mut self, name: &str, value: Value) {
        self.0.push(Attribute::new(name, value));
    }

    fn many(&mut self, name: &str, values: Vec<Value>) {
        if !values.is_empty() {
            self.0.push(Attribute::many(name, values));
        }
    }

    fn keywords<S: AsRef<str>>(&mut self, name: &str, words: &[S]) {
        self.many(name, words.iter().map(|w| Value::keyword(w.as_ref())).collect());
    }
}

pub(super) fn printer(p: &Served, printer_uri: &str, up_time: i32) -> Vec<Attribute> {
    let report = &p.printer.report;
    let caps = &report.capabilities;
    let mut a = Attrs::default();
    a.one("charset-configured", Value::Str(tag::CHARSET, "utf-8".into()));
    a.one("charset-supported", Value::Str(tag::CHARSET, "utf-8".into()));
    a.one("natural-language-configured", Value::Str(tag::LANGUAGE, "en".into()));
    a.one("generated-natural-language-supported", Value::Str(tag::LANGUAGE, "en".into()));
    a.keywords("compression-supported", &["none"]);
    a.one("color-supported", Value::Boolean(caps.color));
    a.one("copies-default", Value::Integer(1));
    a.one("copies-supported", Value::Range(1, i32::try_from(caps.copies_max).unwrap_or(1).max(1)));
    a.one("document-format-default", Value::mime("application/octet-stream"));
    let mut formats: Vec<Value> = p.formats.iter().map(|f| Value::mime(f)).collect();
    formats.push(Value::mime("application/octet-stream"));
    a.many("document-format-supported", formats);
    a.one("finishings-default", Value::Enum(3));
    a.one("finishings-supported", Value::Enum(3));
    a.keywords("identify-actions-default", &["display"]);
    a.keywords("identify-actions-supported", &["display"]);
    a.keywords("ipp-features-supported", &["ipp-everywhere"]);
    a.keywords("ipp-versions-supported", &["1.1", "2.0"]);
    a.keywords("job-creation-attributes-supported", &CREATION_ATTRS);
    a.one("job-ids-supported", Value::Boolean(true));
    media_attrs(&mut a, p);
    a.one("multiple-document-jobs-supported", Value::Boolean(false));
    a.one("multiple-operation-time-out", Value::Integer(super::jobs::DOCUMENT_WAIT_SECS));
    a.many("operations-supported", OPERATIONS.iter().map(|&o| Value::Enum(i32::from(o))).collect());
    a.one("orientation-requested-default", Value::Enum(3));
    a.many("orientation-requested-supported", vec![Value::Enum(3), Value::Enum(4)]);
    a.keywords("output-bin-default", &["face-down"]);
    a.keywords("output-bin-supported", &["face-down"]);
    a.one("page-ranges-supported", Value::Boolean(true));
    a.keywords("pdl-override-supported", &["attempted"]);
    let modes: &[&str] = if caps.color { &["auto", "color", "monochrome"] } else { &["auto", "monochrome"] };
    a.keywords("print-color-mode-default", &[if caps.color { "auto" } else { "monochrome" }]);
    a.keywords("print-color-mode-supported", modes);
    a.one("print-quality-default", Value::Enum(4));
    a.many("print-quality-supported", vec![Value::Enum(3), Value::Enum(4), Value::Enum(5)]);
    a.keywords("print-scaling-default", &["auto"]);
    a.keywords("print-scaling-supported", &["auto", "auto-fit", "fill", "fit", "none"]);
    identity_attrs(&mut a, p, printer_uri);
    state_attrs(&mut a, p, up_time);
    let resolutions = p.resolutions();
    let default = if resolutions.contains(&300) { 300 } else { resolutions.first().copied().unwrap_or(300) };
    a.one("printer-resolution-default", dpi(default));
    a.many("printer-resolution-supported", resolutions.iter().map(|&r| dpi(r)).collect());
    let sides: &[&str] =
        if caps.duplex { &["one-sided", "two-sided-long-edge", "two-sided-short-edge"] } else { &["one-sided"] };
    a.keywords("sides-default", &["one-sided"]);
    a.keywords("sides-supported", sides);
    a.keywords("which-jobs-supported", &["completed", "not-completed", "all"]);
    a.keywords("urf-supported", &p.urf());
    if p.accepts("image/pwg-raster") {
        a.many("pwg-raster-document-resolution-supported", resolutions.iter().map(|&r| dpi(r)).collect());
        let types: &[&str] = if caps.color { &["sgray_8", "srgb_8"] } else { &["sgray_8"] };
        a.keywords("pwg-raster-document-type-supported", types);
        a.keywords("pwg-raster-document-sheet-back", &["normal"]);
    }
    marker_attrs(&mut a, p);
    a.0
}

fn dpi(r: u32) -> Value {
    let r = i32::try_from(r).unwrap_or(300);
    Value::Resolution(r, r, 3)
}

fn media_attrs(a: &mut Attrs, p: &Served) {
    let media = p.media();
    let default = p.media_default();
    a.keywords("media-default", &[&default]);
    a.keywords("media-supported", &media);
    a.keywords("media-ready", &[&default]);
    if let Some(col) = media::col(&default) {
        a.one("media-col-default", col.clone());
        a.one("media-col-ready", col);
    }
    a.many("media-col-database", media.iter().filter_map(|m| media::col(m)).collect());
    let sizes = media.iter().filter_map(|m| media::dimensions(m)).map(|(x, y)| media::size(x, y)).collect();
    a.many("media-size-supported", sizes);
    a.0.extend(media::margins());
    a.keywords("media-source-supported", &["auto"]);
    a.keywords("media-type-supported", &["stationery"]);
    a.keywords("media-col-supported", &MEDIA_COL_MEMBERS);
}

fn identity_attrs(a: &mut Attrs, p: &Served, printer_uri: &str) {
    let report = &p.printer.report;
    let make_model = report.make_model.as_deref().unwrap_or("Print Better shared printer");
    a.one("printer-info", Value::text(&p.printer.name));
    a.one("printer-location", Value::text(report.location.as_deref().unwrap_or("")));
    a.one("printer-make-and-model", Value::text(make_model));
    a.one("printer-name", Value::name(&p.printer.name));
    a.one("printer-uuid", Value::uri(&format!("urn:uuid:{}", p.uuid)));
    a.one("printer-uri-supported", Value::uri(printer_uri));
    a.keywords("uri-security-supported", &["none"]);
    a.keywords("uri-authentication-supported", &["none"]);
    a.one("printer-geo-location", Value::OutOfBand(tag::UNKNOWN));
    a.one("printer-is-accepting-jobs", Value::Boolean(true));
}

fn state_attrs(a: &mut Attrs, p: &Served, up_time: i32) {
    let status = &p.printer.report.status;
    let state = match status.state {
        PrinterState::Printing => printer_state::PROCESSING,
        PrinterState::Stopped | PrinterState::Offline => printer_state::STOPPED,
        PrinterState::Idle | PrinterState::Unknown => printer_state::IDLE,
    };
    let mut reasons: Vec<&str> = status.reasons.iter().map(String::as_str).collect();
    if status.state == PrinterState::Offline && !reasons.contains(&"offline-report") {
        reasons.push("offline-report");
    }
    if reasons.is_empty() {
        reasons.push("none");
    }
    a.one("printer-state", Value::Enum(state));
    a.keywords("printer-state-reasons", &reasons);
    a.one("printer-state-message", Value::text(status.message.as_deref().unwrap_or("")));
    a.one("printer-up-time", Value::Integer(up_time));
}

fn marker_attrs(a: &mut Attrs, p: &Served) {
    let supplies = &p.printer.report.status.supplies;
    if supplies.is_empty() {
        return;
    }
    let inkjet = supplies.iter().any(|s| s.kind == SupplyKind::Ink);
    let kind = |k: SupplyKind| match k {
        SupplyKind::Toner => "toner",
        SupplyKind::Ink => "ink",
        SupplyKind::Drum => "opc",
        SupplyKind::Waste if inkjet => "waste-ink",
        SupplyKind::Waste => "waste-toner",
        SupplyKind::Other => "other",
    };
    a.many("marker-names", supplies.iter().map(|s| Value::name(&s.name)).collect());
    a.many("marker-types", supplies.iter().map(|s| Value::keyword(kind(s.kind))).collect());
    a.many("marker-colors", supplies.iter().map(|s| Value::name(s.color.as_deref().unwrap_or("none"))).collect());
    // marker-levels uses -2 for "unknown"; the model's -1 means the same thing.
    a.many("marker-levels", supplies.iter().map(|s| Value::Integer(if s.level < 0 { -2 } else { s.level })).collect());
    a.many("marker-low-levels", supplies.iter().map(|_| Value::Integer(10)).collect());
    a.many("marker-high-levels", supplies.iter().map(|_| Value::Integer(100)).collect());
}

/// Keeps the attributes a client asked for; "all" and group names keep everything.
pub(super) fn select(attrs: Vec<Attribute>, requested: Option<&Attribute>, groups: &[&str]) -> Vec<Attribute> {
    let Some(requested) = requested else { return attrs };
    let names: Vec<&str> = requested.strs().collect();
    if names.is_empty() || names.iter().any(|n| *n == "all" || groups.contains(n)) {
        return attrs;
    }
    attrs.into_iter().filter(|a| names.contains(&a.name.as_str())).collect()
}
