use crate::backends::{endpoint, percent_decode, percent_encode};

#[test]
fn endpoints_parse_hosts_ports_and_paths() {
    let e = endpoint("socket://10.0.0.5", 9100).expect("default port");
    assert_eq!((e.host.as_str(), e.port, e.path.as_str()), ("10.0.0.5", 9100, ""));
    let e = endpoint("lpd://printer.local:5515/office/raw?x=1", 515).expect("port and path");
    assert_eq!((e.host.as_str(), e.port, e.path.as_str()), ("printer.local", 5515, "office/raw"));
    let e = endpoint("socket://[fe80::1%25en0]:9101", 9100).expect("bracketed v6");
    assert_eq!((e.host.as_str(), e.port), ("fe80::1%25en0", 9101));
    let e = endpoint("ipp://[::1]/ipp/print", 631).expect("v6 default port");
    assert_eq!((e.host.as_str(), e.port, e.path.as_str()), ("::1", 631, "ipp/print"));
}

#[test]
fn endpoints_reject_malformed_addresses() {
    for bad in ["socket://", "socket://:9100", "printer:9100", "socket://host:port", "socket://host:99999", "socket://[::1"] {
        assert!(endpoint(bad, 9100).is_err(), "{bad:?}");
    }
}

#[test]
fn percent_codec_round_trips() {
    let name = "Office Printer #2/\u{e9}~ok-._";
    let encoded = percent_encode(name);
    assert_eq!(encoded, "Office%20Printer%20%232%2F%C3%A9~ok-._");
    assert_eq!(percent_decode(&encoded), name);
    assert_eq!(percent_decode("%41%zz%4"), "A%zz%4", "invalid escapes stay as typed");
}

#[cfg(not(windows))]
#[test]
fn usb_addresses_round_trip() {
    use crate::backends::usb::UsbAddress;
    let a = UsbAddress::parse("usb://04F9:0042/ABC%20123?if=1").expect("parse");
    assert_eq!((a.vendor, a.product, a.serial.as_deref(), a.interface), (0x04F9, 0x0042, Some("ABC 123"), 1));
    assert_eq!(a.uri(), "usb://04F9:0042/ABC%20123?if=1");
    assert_eq!(a.key(), "usb:04f9:0042:ABC 123");
    let bare = UsbAddress::parse("usb://03f0:2b17/-").expect("no serial");
    assert_eq!((bare.serial, bare.interface), (None, 0));
    assert_eq!(UsbAddress::parse("usb://03F0:2B17").expect("no path").uri(), "usb://03F0:2B17/-?if=0");
    for bad in ["usb://zz:0042/x", "usb://04f9/x", "socket://04f9:0042", "usb://04f9:0042/x?if=300"] {
        assert!(UsbAddress::parse(bad).is_err(), "{bad:?}");
    }
}
