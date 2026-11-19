//! Discovery unit tests: folding sightings into reports, and the URI helpers merging relies on.
//! mDNS TXT, CUPS queue, and SNMP tests sit beside them as children of the modules they test.

mod merging;

use super::found::{BACKEND, Found, better, percent_decode, percent_encode, query_param, uri_host};
use crate::model::{Capabilities, PrinterReport, PrinterStatus, Route, RouteKind};

/// A sighting with these routes, their hosts recorded the way the sources do.
fn seen(origins: u8, routes: &[(RouteKind, &str)]) -> Found {
    let mut f = Found { origins, ..Found::default() };
    for (kind, uri) in routes {
        f.add_route(*kind, uri.to_string());
        if let Some(host) = uri_host(uri) {
            f.add_host(&host);
        }
    }
    f
}

fn usb_report(serial_path: &str) -> PrinterReport {
    PrinterReport {
        key: "usb:03f0:2b17:VNB3K12345".into(),
        name: "HP LaserJet Pro M404".into(),
        make_model: Some("HP LaserJet Pro M404-M405".into()),
        uuid: None,
        location: None,
        local: true,
        routes: vec![Route { kind: RouteKind::Usb, uri: format!("usb://03F0:2B17/{serial_path}?if=0") }],
        capabilities: Capabilities::default(),
        status: PrinterStatus::default(),
    }
}

#[test]
fn uri_host_reads_every_network_scheme() {
    let cases = [
        ("ipp://192.168.5.174:631/ipp/print", Some("192.168.5.174")),
        ("ipps://HP001122334455.local.:443/ipp/print", Some("hp001122334455.local")),
        ("socket://10.0.0.5", Some("10.0.0.5")),
        ("lpd://[fd00::5]:515/RAW", Some("fd00::5")),
        ("http://user:pw@printer.lan/x?y", Some("printer.lan")),
        ("usb://03F0:2B17/SERIAL?if=0", None),
        ("os://Office", None),
        ("dnssd://Office._ipp._tcp.local./?uuid=x", None),
        ("ipp://", None),
    ];
    for (uri, host) in cases {
        assert_eq!(uri_host(uri).as_deref(), host, "{uri}");
    }
}

#[test]
fn query_params_are_found_case_insensitively_and_decoded() {
    let uri = "dnssd://Office%20HP._ipp._tcp.local./?UUID=5F0C2A7E&serial=VN%20B3K#frag";
    assert_eq!(query_param(uri, "uuid").as_deref(), Some("5F0C2A7E"));
    assert_eq!(query_param(uri, "serial").as_deref(), Some("VN B3K"));
    assert_eq!(query_param(uri, "missing"), None);
    assert_eq!(query_param("usb://HP/LaserJet", "serial"), None);
}

#[test]
fn percent_encoding_round_trips_and_leaves_malformed_escapes_alone() {
    let name = "Büro Drucker/1~a_b.c-d";
    let encoded = percent_encode(name);
    assert_eq!(encoded, "B%C3%BCro%20Drucker%2F1~a_b.c-d");
    assert_eq!(percent_decode(&encoded), name);
    for raw in ["%", "%2", "%zz", "100%", "%+f", "%-1"] {
        assert_eq!(percent_decode(raw), raw, "{raw}");
    }
}

#[test]
fn backend_reports_carry_their_usb_serial_and_hosts() {
    let f = Found::from_report(usb_report("VNB3K%2012345"), 2);
    assert_eq!((f.origins, f.ids.as_slice()), (BACKEND, &["serial:VNB3K 12345".to_string()][..]));
    assert_eq!(f.name, Some((2, "HP LaserJet Pro M404".to_string())));
    assert!(f.local && f.hosts.is_empty());
    assert!(Found::from_report(usb_report("-"), 2).ids.is_empty(), "\"-\" means no serial");

    let mut net = usb_report("-");
    net.routes = vec![Route { kind: RouteKind::Ipp, uri: "ipp://10.0.0.5/ipp/print".into() }];
    assert_eq!(Found::from_report(net, 5).hosts, ["10.0.0.5"]);
}

#[test]
fn better_keeps_the_higher_rank_and_the_first_on_ties() {
    assert_eq!(better(Some((2, "a")), Some((3, "b"))), Some((3, "b")));
    assert_eq!(better(Some((3, "a")), Some((3, "b"))), Some((3, "a")));
    assert_eq!(better(None, Some((1, "b"))), Some((1, "b")));
    assert_eq!(better(Some((1, "a")), None), Some((1, "a")));
}
