//! SNMP: BER requests and canned responses, and Printer MIB status mapping. Child of `status`.

use super::super::ber::{SnmpValue, parse, request};
use super::{color, interpret, kind, percent};
use crate::model::{PrinterState, SupplyKind};

const SYS_DESCR: &[u32] = &[1, 3, 6, 1, 2, 1, 1, 1, 0];
const DEVICE_STATUS: &[u8] = &[0x2B, 6, 1, 2, 1, 25, 3, 2, 1, 5, 1];
const PRINTER_STATUS: &[u8] = &[0x2B, 6, 1, 2, 1, 25, 3, 5, 1, 1, 1];
const ERROR_STATE: &[u8] = &[0x2B, 6, 1, 2, 1, 25, 3, 5, 1, 2, 1];

fn tlv(tag: u8, value: &[u8]) -> Vec<u8> {
    let len = value.len();
    let mut out = match len {
        0..0x80 => vec![tag, len as u8],
        0x80..0x100 => vec![tag, 0x81, len as u8],
        _ => vec![tag, 0x82, (len >> 8) as u8, len as u8],
    };
    out.extend_from_slice(value);
    out
}

/// A GetResponse PDU: (oid bytes, value tag, value bytes) per varbind.
fn response(request_id: &[u8], error_status: u8, varbinds: &[(&[u8], u8, &[u8])]) -> Vec<u8> {
    let list: Vec<u8> = varbinds.iter().flat_map(|(oid, t, v)| tlv(0x30, &[tlv(0x06, oid), tlv(*t, v)].concat())).collect();
    let pdu = [tlv(0x02, request_id), tlv(0x02, &[error_status]), tlv(0x02, &[0]), tlv(0x30, &list)].concat();
    tlv(0x30, &[tlv(0x02, &[0]), tlv(0x04, b"public"), tlv(0xA2, &pdu)].concat())
}

#[test]
fn requests_match_the_research_layout() {
    let mut expected = vec![0x30, 0x29, 0x02, 0x01, 0x00, 0x04, 0x06];
    expected.extend_from_slice(b"public");
    expected.extend_from_slice(&[0xA0, 0x1C, 0x02, 0x04, 0x01, 0x02, 0x03, 0x04, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00]);
    expected.extend_from_slice(&[0x30, 0x0E, 0x30, 0x0C, 0x06, 0x08, 0x2B, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0x00, 0x05, 0x00]);
    assert_eq!(expected.len(), 43);
    assert_eq!(request("public", 0x0102_0304, SYS_DESCR, false), expected);
    expected[13] = 0xA1;
    assert_eq!(request("public", 0x0102_0304, SYS_DESCR, true), expected, "GetNext differs only in the PDU tag");
    assert_eq!(&request("public", 1, SYS_DESCR, false)[13..18], [0xA0, 0x19, 0x02, 0x01, 0x01], "INTEGERs are minimal");
}

#[test]
fn responses_decode_every_value_kind() {
    let long = [b'x'; 200];
    let pdu = response(
        &[0x12, 0x34],
        0,
        &[
            (DEVICE_STATUS, 0x02, &[0x05]),
            (PRINTER_STATUS, 0x02, &[0xFF]),
            (ERROR_STATE, 0x04, &[0x40, 0x00]),
            (DEVICE_STATUS, 0x43, &[0x01, 0x00]),
            (DEVICE_STATUS, 0x06, &[0x2B, 6, 1, 4, 1, 0x95, 0x0B]),
            (DEVICE_STATUS, 0x80, &[]),
            (DEVICE_STATUS, 0x04, &long),
        ],
    );
    let r = parse(&pdu).expect("parses");
    assert_eq!((r.request_id, r.error_status), (0x1234, 0));
    assert_eq!(r.varbinds[0].0, [1, 3, 6, 1, 2, 1, 25, 3, 2, 1, 5, 1]);
    let values: Vec<&SnmpValue> = r.varbinds.iter().map(|(_, v)| v).collect();
    assert_eq!(values[0], &SnmpValue::Int(5));
    assert_eq!(values[1], &SnmpValue::Int(-1));
    assert_eq!(values[2], &SnmpValue::Bytes(vec![0x40, 0x00]));
    assert_eq!(values[3], &SnmpValue::Int(256), "TimeTicks are integers");
    assert_eq!(values[4], &SnmpValue::Oid(vec![1, 3, 6, 1, 4, 1, 2699]));
    assert_eq!(values[5], &SnmpValue::Null, "noSuchObject");
    assert_eq!(values[6].text().map(|t| t.len()), Some(200), "long-form length");
}

#[test]
fn malformed_responses_are_rejected_without_panicking() {
    let good = response(&[1], 0, &[(DEVICE_STATUS, 0x02, &[2])]);
    for cut in 0..good.len() {
        assert!(parse(&good[..cut]).is_none(), "prefix of {cut} bytes");
    }
    assert_eq!(good[13], 0xA2, "GetResponse tag");
    let mut get_request = good.clone();
    get_request[13] = 0xA0;
    assert!(parse(&get_request).is_none(), "requests are not responses");
    let huge_arc: &[u8] = &[0x2B, 0x90, 0x80, 0x80, 0x80, 0x00];
    assert!(parse(&response(&[1], 0, &[(huge_arc, 0x05, &[])])).is_none(), "OID arcs beyond 32 bits");
    let max_arc: &[u8] = &[0x2B, 0x8F, 0xFF, 0xFF, 0xFF, 0x7F];
    assert_eq!(parse(&response(&[1], 0, &[(max_arc, 0x05, &[])])).unwrap().varbinds[0].0, [1, 3, u32::MAX]);
    let too_many_arcs: Vec<u8> = std::iter::once(0x2B).chain(std::iter::repeat_n(1, 130)).collect();
    assert!(parse(&response(&[1], 0, &[(&too_many_arcs, 0x05, &[])])).is_none());
    assert!(parse(&response(&[], 0, &[])).is_none(), "empty INTEGER");
    let error = parse(&response(&[7], 2, &[])).unwrap();
    assert_eq!((error.request_id, error.error_status, error.varbinds.len()), (7, 2, 0), "noSuchName still parses");
}

/// (hrDeviceStatus, hrPrinterStatus, hrPrinterDetectedErrorState, state, reasons)
type StatusCase = (Option<i64>, Option<i64>, Option<&'static [u8]>, PrinterState, Vec<String>);

#[test]
fn printer_mib_status_maps_to_state_and_reasons() {
    let reasons = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let cases: [StatusCase; 9] = [
        (Some(2), Some(3), Some(&[0, 0]), PrinterState::Idle, Vec::new()),
        (Some(2), Some(4), None, PrinterState::Printing, Vec::new()),
        (Some(2), Some(5), Some(&[0x20]), PrinterState::Printing, reasons(&["toner-low"])),
        (Some(5), Some(3), None, PrinterState::Stopped, Vec::new()),
        (Some(3), Some(1), Some(&[0x80]), PrinterState::Idle, reasons(&["media-low"])),
        (Some(2), Some(3), Some(&[0x0C]), PrinterState::Stopped, reasons(&["door-open", "media-jam"])),
        (Some(2), Some(3), Some(&[0x00, 0x04]), PrinterState::Idle, reasons(&["media-empty"])),
        (Some(2), Some(3), Some(&[0x40, 0x04, 0xFF]), PrinterState::Stopped, reasons(&["media-empty"])),
        (None, None, Some(&[0x01, 0x02]), PrinterState::Unknown, reasons(&["other"])),
    ];
    for (device, printer, errors, state, want) in cases {
        assert_eq!(interpret(device, printer, errors), (state, want), "{device:?} {printer:?} {errors:?}");
    }
}

#[test]
fn supply_levels_kinds_and_colors() {
    let levels = [
        ((Some(50), Some(100)), 50),
        ((Some(1), Some(3)), 33),
        ((Some(250), Some(200)), 100),
        ((Some(i64::MAX), Some(1)), 100),
        ((Some(-3), Some(100)), -1),
        ((Some(5), Some(0)), -1),
        ((None, Some(100)), -1),
    ];
    for ((level, max), want) in levels {
        assert_eq!(percent(level, max), want, "{level:?}/{max:?}");
    }
    let kinds = [(Some(3), SupplyKind::Toner), (Some(21), SupplyKind::Toner), (Some(6), SupplyKind::Ink), (Some(9), SupplyKind::Drum)];
    for (t, want) in kinds.into_iter().chain([(Some(4), SupplyKind::Waste), (Some(99), SupplyKind::Other), (None, SupplyKind::Other)]) {
        assert_eq!(kind(t), want, "{t:?}");
    }
    assert_eq!(color("Black Cartridge HP CF258A").as_deref(), Some("#000000"));
    assert_eq!(color("CYAN toner").as_deref(), Some("#00FFFF"));
    assert_eq!(color("Imaging Drum"), None);
}
