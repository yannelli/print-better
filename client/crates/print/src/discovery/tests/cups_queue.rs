use super::queue;
use crate::discovery::found::CUPS;
use crate::ipp::tags::group;
use crate::ipp::{Attribute, Group, Value};
use crate::model::{PrinterState, Route, RouteKind};

/// A CUPS-Get-Printers printer group for queue `name` on `device`.
fn cups_printer(name: &str, device: &str, extra: Vec<Attribute>) -> Group {
    let mut attrs = vec![
        Attribute::new("printer-name", Value::name(name)),
        Attribute::new("printer-info", Value::text("Office Laser")),
        Attribute::new("printer-make-and-model", Value::text("HP LaserJet Pro M404-M405, driverless, cups-filters 2.0.0")),
        Attribute::new("printer-uuid", Value::uri("urn:uuid:e5235e2d-da56-368b-703a-655ea14a0b09")),
        Attribute::new("device-uri", Value::uri(device)),
        Attribute::new("printer-state", Value::Enum(3)),
    ];
    attrs.extend(extra);
    Group { tag: group::PRINTER, attrs }
}

#[test]
fn a_driverless_network_queue() {
    let device = "dnssd://Office%20Laser._ipp._tcp.local./?uuid=5F0C2A7E-3B1D-4C8E-9A6F-2D4B8E1C7A90";
    let f = queue(&cups_printer("Office_Laser", device, Vec::new())).unwrap();
    assert_eq!((f.origins, f.key.as_deref()), (CUPS, Some("os:Office_Laser")));
    assert_eq!(f.routes, [Route { kind: RouteKind::Os, uri: "os://Office_Laser".into() }]);
    assert_eq!(f.name, Some((5, "Office Laser".to_string())));
    assert_eq!(f.make_model, Some((1, "HP LaserJet Pro M404-M405".to_string())), "driver details are dropped");
    assert_eq!(f.uuid.as_deref(), Some("5f0c2a7e-3b1d-4c8e-9a6f-2d4b8e1c7a90"), "the device's uuid, not the queue's");
    assert_eq!(f.ids, ["uuid:e5235e2d-da56-368b-703a-655ea14a0b09"]);
    assert!(!f.local && f.hosts.is_empty());
    assert_eq!(f.status.map(|(rank, s)| (rank, s.state)), Some((2, PrinterState::Idle)));
}

#[test]
fn device_uris_decide_locality_hosts_and_serials() {
    let ipp = queue(&cups_printer("Net", "ipp://192.168.5.174/ipp/print", Vec::new())).unwrap();
    assert_eq!((ipp.local, ipp.hosts.as_slice(), ipp.uuid.as_deref()), (false, &["192.168.5.174".to_string()][..], None));

    let usb = queue(&cups_printer("Usb", "usb://HP/LaserJet%20Pro%20M404?serial=VNB3K12345", Vec::new())).unwrap();
    assert!(usb.local && usb.ids.iter().any(|id| id == "serial:VNB3K12345"));

    for device in ["ipp://localhost:60000/ipp/print", "hp:/usb/LaserJet?serial=X", "parallel:/dev/lp0", "ippusb://HP/x"] {
        let f = queue(&cups_printer("Local", device, Vec::new())).unwrap();
        assert!(f.local && f.hosts.is_empty(), "{device}");
    }
}

#[test]
fn classes_faxes_and_temporary_queues_are_skipped() {
    let device = "ipp://10.0.0.5/ipp/print";
    for (flag, why) in [(0x0001, "class"), (0x1_0000, "implicit class"), (0x4_0000, "fax")] {
        let g = cups_printer("Q", device, vec![Attribute::new("printer-type", Value::Enum(flag | 0x4))]);
        assert!(queue(&g).is_none(), "{why}");
    }
    let temporary = cups_printer("Q", device, vec![Attribute::new("printer-is-temporary", Value::Boolean(true))]);
    assert!(queue(&temporary).is_none());
    assert!(queue(&cups_printer("", device, Vec::new())).is_none(), "unnamed");
    let printer = cups_printer("Q", device, vec![Attribute::new("printer-type", Value::Enum(0x4 | 0x8))]);
    assert!(queue(&printer).is_some(), "plain printer-type bits are fine");
}

#[test]
fn queue_names_are_percent_encoded_in_routes() {
    let f = queue(&cups_printer("Büro Drucker", "socket://10.0.0.5", Vec::new())).unwrap();
    assert_eq!(f.routes[0].uri, "os://B%C3%BCro%20Drucker");
    assert_eq!(f.key.as_deref(), Some("os:Büro Drucker"));
}

#[test]
fn print_better_remote_queues_are_not_rediscovered() {
    assert!(queue(&cups_printer("pb_k3x9", "ipp://127.0.0.1:8632/ipp/print/abc", Vec::new())).is_none());
    assert!(queue(&cups_printer("pb_k3x9", "ipp://192.168.5.174/ipp/print", Vec::new())).is_some(), "a user queue that only shares the prefix");
    assert!(queue(&cups_printer("IPP_USB", "ipp://localhost:60000/ipp/print", Vec::new())).is_some(), "IPP-over-USB proxies stay");
}
