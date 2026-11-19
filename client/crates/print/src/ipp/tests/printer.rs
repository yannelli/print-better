use super::fixture;
use crate::ipp::printer::{bare_uuid, parse, status, supply_kind};
use crate::ipp::tags::group;
use crate::ipp::{Attribute, Group, Message, Value};
use crate::model::{PrinterState, Quality, Supply, SupplyKind};

fn captured(name: &str) -> Group {
    let (msg, _) = Message::decode(&fixture(name)).unwrap();
    assert_eq!(msg.code, 0, "{name} is a successful reply");
    msg.group(group::PRINTER).cloned().unwrap()
}

fn printer(attrs: Vec<Attribute>) -> Group {
    Group { tag: group::PRINTER, attrs }
}

#[test]
fn hp_m404_direct() {
    let a = parse(&captured("hp-m404-gpa.bin"));
    assert_eq!(a.name.as_deref(), Some("Office-HP-LaserJet-M404"), "printer-info wins over printer-name");
    assert_eq!(a.make_model.as_deref(), Some("HP LaserJet Pro M404-M405"));
    assert_eq!(a.uuid.as_deref(), Some("5f0c2a7e-3b1d-4c8e-9a6f-2d4b8e1c7a90"));
    assert_eq!(a.location.as_deref(), Some("Office"));
    let caps = &a.capabilities;
    let formats = [
        "application/vnd.hp-PCL",
        "application/vnd.hp-PCLXL",
        "application/postscript",
        "application/pdf",
        "image/jpeg",
        "image/urf",
        "image/pwg-raster",
        "application/PCLm",
    ];
    assert_eq!(caps.formats, formats, "octet-stream is not a real format");
    assert!(!caps.color && !caps.duplex);
    assert_eq!(caps.media.len(), 24, "custom_min/custom_max ranges are dropped");
    assert!(caps.media.iter().all(|m| !m.starts_with("custom_")));
    assert_eq!(caps.media_default.as_deref(), Some("na_letter_8.5x11in"));
    assert_eq!(caps.resolutions, [600, 1200], "sorted and deduplicated");
    assert_eq!(caps.copies_max, 99);
    assert_eq!((a.status.state, a.status.reasons.len(), a.status.message.as_deref()), (PrinterState::Idle, 0, None));
    let toner = Supply { name: "black cartridge".into(), kind: SupplyKind::Toner, color: Some("#000000".into()), level: 100 };
    assert_eq!(a.status.supplies, [toner]);
    assert!(a.urf_supported.iter().any(|k| k == "RS600") && a.urf_supported.iter().any(|k| k == "V1.5"));
    assert_eq!(a.pwg_resolutions, [600]);
    assert_eq!(a.pwg_types, ["sgray_8", "srgb_8", "adobe-rgb_8", "rgb_8"]);
    assert!(a.identify_supported && a.page_ranges_supported);
}

#[test]
fn local_cups_queue_for_the_same_printer() {
    let a = parse(&captured("cups-queue-gpa.bin"));
    assert_eq!(a.name.as_deref(), Some("Office-HP-LaserJet-M404"));
    assert_eq!(a.make_model.as_deref(), Some("HP LaserJet Pro M404-M405-AirPrint"));
    assert_eq!(a.uuid.as_deref(), Some("e5235e2d-da56-368b-703a-655ea14a0b09"), "CUPS mints its own queue uuid");
    let caps = &a.capabilities;
    assert_eq!(caps.formats.len(), 40);
    assert!(caps.formats.iter().any(|f| f == "application/pdf") && !caps.formats.iter().any(|f| f == "application/octet-stream"));
    assert!(!caps.color, "print-color-mode-supported lists only monochrome");
    assert_eq!(caps.media.len(), 22);
    assert_eq!((caps.resolutions.as_slice(), caps.copies_max), (&[600][..], 9999));
    assert_eq!(a.pwg_types, ["black_1", "sgray_8"]);
    assert!(!a.identify_supported, "CUPS does not list Identify-Printer");
    assert!(a.page_ranges_supported);
    assert_eq!(a.status.state, PrinterState::Idle);
}

#[test]
fn trays_paper_types_and_qualities_are_capabilities() {
    let g = printer(vec![
        Attribute::many("media-source-supported", ["tray-1", "tray-2", "auto"].map(Value::keyword).to_vec()),
        Attribute::many("media-type-supported", ["stationery", "com.example.glossy"].map(Value::keyword).to_vec()),
        Attribute::many("print-quality-supported", vec![Value::Enum(4), Value::Enum(5), Value::Enum(9)]),
    ]);
    let caps = parse(&g).capabilities;
    assert_eq!(caps.sources, ["tray-1", "tray-2", "auto"]);
    assert_eq!(caps.media_types, ["stationery", "com.example.glossy"], "reported as is; the loopback server filters");
    assert_eq!(caps.qualities, [Quality::Normal, Quality::High], "unknown enums are dropped");
    let bare = parse(&printer(Vec::new())).capabilities;
    assert!(bare.sources.is_empty() && bare.media_types.is_empty() && bare.qualities.is_empty());
}

#[test]
fn printer_state_reasons_and_messages() {
    let g = printer(vec![
        Attribute::new("printer-state", Value::Enum(5)),
        Attribute::many(
            "printer-state-reasons",
            ["media-empty-error", "media-empty-warning", "toner-low-report", "none", "door-open"].map(Value::keyword).to_vec(),
        ),
        Attribute::new("printer-state-message", Value::text("  ")),
        Attribute::new("printer-is-accepting-jobs", Value::Boolean(false)),
    ]);
    let s = status(&g);
    assert_eq!(s.state, PrinterState::Stopped);
    assert_eq!(s.reasons, ["media-empty", "toner-low", "door-open"]);
    assert_eq!(s.message.as_deref(), Some("Not accepting jobs"));
    for (n, want) in [(3, PrinterState::Idle), (4, PrinterState::Printing), (9, PrinterState::Unknown)] {
        assert_eq!(status(&printer(vec![Attribute::new("printer-state", Value::Enum(n))])).state, want);
    }
    assert_eq!(status(&printer(Vec::new())).state, PrinterState::Unknown);
}

#[test]
fn supplies_clamp_levels_and_take_the_first_color() {
    let g = printer(vec![
        Attribute::many("marker-names", ["Cyan", "Waste", "Drum", "Mystery"].map(Value::name).to_vec()),
        Attribute::many("marker-types", ["ink-cartridge", "waste-toner", "opc"].map(Value::keyword).to_vec()),
        Attribute::many("marker-levels", vec![Value::Integer(140), Value::Integer(-3), Value::Integer(55)]),
        Attribute::many("marker-colors", ["#00ffff#ff00ff", "none", "#12345"].map(Value::name).to_vec()),
    ]);
    let got: Vec<(SupplyKind, Option<String>, i32)> = status(&g).supplies.into_iter().map(|s| (s.kind, s.color, s.level)).collect();
    let want = [
        (SupplyKind::Ink, Some("#00FFFF".to_string()), 100),
        (SupplyKind::Waste, None, -1),
        (SupplyKind::Drum, None, 55),
        (SupplyKind::Other, None, -1),
    ];
    assert_eq!(got, want);
    for (t, kind) in [("toner", SupplyKind::Toner), ("solid-wax", SupplyKind::Ink), ("fuser", SupplyKind::Other)] {
        assert_eq!(supply_kind(t), kind, "{t}");
    }
}

#[test]
fn uuids_are_bare_and_lowercase() {
    assert_eq!(bare_uuid("urn:uuid:5F0C2A7E-3B1D-4C8E-9A6F-2D4B8E1C7A90").as_deref(), Some("5f0c2a7e-3b1d-4c8e-9a6f-2d4b8e1c7a90"));
    assert_eq!(bare_uuid(" URN:UUID:abc ").as_deref(), Some("abc"));
    assert_eq!(bare_uuid("urn:uuid:"), None);
    assert_eq!(bare_uuid(""), None);
}

#[test]
fn identify_needs_the_operation_or_identify_actions() {
    let ops = |codes: &[i32]| Attribute::many("operations-supported", codes.iter().map(|&c| Value::Enum(c)).collect());
    assert!(parse(&printer(vec![ops(&[0x02, 0x3C])])).identify_supported);
    assert!(!parse(&printer(vec![ops(&[0x02, 0x0B])])).identify_supported);
    let actions = Attribute::new("identify-actions-supported", Value::keyword("sound"));
    assert!(parse(&printer(vec![actions])).identify_supported);
}
