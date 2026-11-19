use super::{seen, usb_report};
use crate::discovery::found::{CUPS, Found, MDNS, SNMP};
use crate::discovery::merge::{group, reports};
use crate::model::{PrinterReport, RouteKind, RouteKind::*};

const HP: &str = "5f0c2a7e-3b1d-4c8e-9a6f-2d4b8e1c7a90";

fn kinds(r: &PrinterReport) -> Vec<RouteKind> {
    r.routes.iter().map(|r| r.kind).collect()
}

fn named(mut f: Found, rank: u8, name: &str) -> Found {
    f.name = Some((rank, name.to_string()));
    f
}

fn with_uuid(mut f: Found, uuid: &str) -> Found {
    f.uuid = Some(uuid.to_string());
    f
}

fn merged(found: Vec<Found>) -> Vec<PrinterReport> {
    reports(group(found))
}

fn hp_mdns() -> Found {
    let routes = [
        (Lpd, "lpd://192.168.5.174:515/RAW"),
        (Socket, "socket://192.168.5.174:9100"),
        (Ipp, "ipp://192.168.5.174:631/ipp/print"),
        (Ipps, "ipps://192.168.5.174:631/ipp/print"),
    ];
    let mut f = named(with_uuid(seen(MDNS, &routes), HP), 3, "HP LaserJet Pro M404-M405 [14CB19]");
    f.add_host("HP001122334455.local.");
    f
}

fn hp_cups() -> Found {
    let mut f = Found { origins: CUPS, key: Some("os:Office_HP_LaserJet_M404".into()), ..Found::default() };
    f.add_route(Os, "os://Office_HP_LaserJet_M404".into());
    named(with_uuid(f, HP), 5, "Office-HP-LaserJet-M404")
}

#[test]
fn one_uuid_seen_over_mdns_and_cups_is_one_printer() {
    let out = merged(vec![hp_cups(), hp_mdns()]);
    assert_eq!(out.len(), 1);
    let r = &out[0];
    assert_eq!(r.key, format!("uuid:{HP}"));
    assert_eq!(r.name, "Office-HP-LaserJet-M404", "the CUPS queue name outranks the mDNS instance");
    assert_eq!(kinds(r), [Ipps, Ipp, Socket, Lpd, Os], "network order for a network printer");
}

#[test]
fn local_printers_prefer_the_os_queue_then_usb() {
    let usb = Found::from_report(usb_report("VNB3K12345"), 2);
    let mut cups = Found { origins: CUPS, key: Some("os:HP_M404".into()), local: true, ..Found::default() };
    cups.add_route(Os, "os://HP_M404".into());
    cups.ids.push("serial:VNB3K12345".into());
    let out = merged(vec![usb, cups]);
    assert_eq!(out.len(), 1, "the USB serial ties the queue to the device");
    assert_eq!(kinds(&out[0]), [Os, Usb]);
    assert_eq!(out[0].key, "usb:03f0:2b17:VNB3K12345", "usb keys outrank os keys");
}

#[test]
fn shared_hosts_merge_only_across_sources_and_only_when_unambiguous() {
    let snmp = seen(SNMP, &[(Socket, "socket://10.0.0.7:9100")]);
    let mdns = with_uuid(seen(MDNS, &[(Ipp, "ipp://10.0.0.7:631/ipp/print")]), "u7");
    assert_eq!(merged(vec![snmp, mdns]).len(), 1);

    let a = with_uuid(seen(MDNS, &[(Ipp, "ipp://10.0.0.8:631/a")]), "u8a");
    let b = seen(MDNS, &[(Ipp, "ipp://10.0.0.8:631/b")]);
    assert_eq!(merged(vec![a, b]).len(), 2, "same source, so two services of one box stay apart");

    let one = with_uuid(seen(MDNS, &[(Ipp, "ipp://10.0.0.9:631/a")]), "u9a");
    let two = with_uuid(seen(CUPS, &[(Ipp, "ipp://10.0.0.9:631/b")]), "u9b");
    let snmp = seen(SNMP, &[(Socket, "socket://10.0.0.9:9100")]);
    assert_eq!(merged(vec![one, two, snmp]).len(), 3, "two candidates: ambiguous");
}

#[test]
fn disagreeing_uuids_never_merge() {
    let mut a = with_uuid(seen(MDNS, &[(Ipp, "ipp://10.0.0.5:631/a")]), "u1");
    a.ids.push("serial:S1".into());
    let b = with_uuid(seen(CUPS, &[(Ipp, "ipp://10.0.0.5:631/b")]), "u2");
    let mut c = seen(SNMP, &[(Socket, "socket://10.0.0.5:9100")]);
    c.ids.push("serial:S1".into());
    let out = merged(vec![a, b, c]);
    let mut keys: Vec<(&str, usize)> = out.iter().map(|r| (r.key.as_str(), r.routes.len())).collect();
    keys.sort();
    assert_eq!(keys, [("uuid:u1", 2), ("uuid:u2", 1)], "the serial joins c to a only");
}

#[test]
fn keys_fall_back_to_backend_keys_then_network_names() {
    let mut named_host = seen(SNMP, &[(Socket, "socket://10.0.0.5:9100")]);
    named_host.add_host("laser.local");
    let cases = [
        (named_host, "net:laser.local:9100"),
        (seen(SNMP, &[(Socket, "socket://10.0.0.6")]), "net:10.0.0.6:9100"),
        (seen(MDNS, &[(Lpd, "lpd://10.0.0.7/RAW")]), "net:10.0.0.7:515"),
        (seen(MDNS, &[(Socket, "socket://10.0.0.8:9101"), (Ipp, "ipp://10.0.0.8/ipp/print")]), "net:10.0.0.8:631"),
    ];
    for (f, key) in cases {
        assert_eq!(merged(vec![f])[0].key, key);
    }
}

#[test]
fn names_are_cleaned_of_vendor_noise() {
    let cases = [
        ("HP_OfficeJet_Pro_9010_series", "HP OfficeJet Pro 9010"),
        ("Brother HL-L2350DW series", "Brother HL-L2350DW"),
        ("EPSON ET-2850 Series (B2E6F1)", "EPSON ET-2850"),
        ("Canon MF743C [notahex]", "Canon MF743C [notahex]"),
        ("Canon MF743C [ABC]", "Canon MF743C [ABC]"),
        ("[ABCDEF]", "[ABCDEF]"),
        ("  Spaced    Out  ", "Spaced Out"),
        ("", "Printer"),
    ];
    for (i, (raw, clean)) in cases.into_iter().enumerate() {
        let f = named(with_uuid(seen(MDNS, &[(Ipp, "ipp://10.0.0.5/x")]), &format!("u{i}")), 3, raw);
        assert_eq!(merged(vec![f])[0].name, clean, "{raw:?}");
    }
    let unnamed = seen(SNMP, &[(Socket, "socket://10.0.0.5")]);
    let mut by_model = unnamed.clone();
    by_model.make_model = Some((1, "Lexmark MS610de".into()));
    assert_eq!(merged(vec![by_model])[0].name, "Lexmark MS610de");
    assert_eq!(merged(vec![unnamed])[0].name, "10.0.0.5");
}

#[test]
fn colliding_names_fall_back_to_raw_names_then_numbers() {
    let printer = |uuid: &str, name: &str| named(with_uuid(seen(MDNS, &[(Ipp, "ipp://10.0.0.5/x")]), uuid), 3, name);
    let out = merged(vec![
        printer("u4", "Office"),
        printer("u2", "HP LaserJet [BBBBBB]"),
        printer("u1", "HP LaserJet [AAAAAA]"),
        printer("u3", "Office"),
    ]);
    let names: Vec<(&str, &str)> = out.iter().map(|r| (r.name.as_str(), r.key.as_str())).collect();
    let want = [
        ("HP LaserJet [AAAAAA]", "uuid:u1"),
        ("HP LaserJet [BBBBBB]", "uuid:u2"),
        ("Office", "uuid:u3"),
        ("Office (2)", "uuid:u4"),
    ];
    assert_eq!(names, want, "sorted by name, numbered in key order");
}

#[test]
fn sightings_without_routes_are_dropped() {
    let f = named(Found { origins: MDNS, ..Found::default() }, 3, "Ghost");
    assert!(merged(vec![f]).is_empty());
}
