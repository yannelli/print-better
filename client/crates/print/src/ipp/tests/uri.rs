use crate::error::Error;
use crate::ipp::resolve::usable;
use crate::ipp::uri::Target;

fn parse(uri: &str) -> Target {
    Target::parse(uri).unwrap_or_else(|e| panic!("{uri}: {e}"))
}

#[test]
fn schemes_set_tls_and_default_ports() {
    let cases = [
        ("ipp://p.local/ipp/print", false, 631),
        ("ipps://p.local/ipp/print", true, 631),
        ("http://p.local/ipp", false, 80),
        ("https://p.local/ipp", true, 443),
        ("IPPS://p.local", true, 631),
    ];
    for (uri, tls, port) in cases {
        let t = parse(uri);
        assert_eq!((t.tls, t.port), (tls, port), "{uri}");
    }
}

#[test]
fn hosts_ports_and_paths() {
    let t = parse("ipp://HP001122334455.local.:8000/ipp/print#frag");
    assert_eq!((t.host.as_str(), t.port, t.path.as_str()), ("HP001122334455.local", 8000, "/ipp/print"));
    assert_eq!(t.authority(), "HP001122334455.local:8000");
    assert_eq!(t.printer_uri(), "ipp://HP001122334455.local:8000/ipp/print");

    let t = parse("ipps://user:secret@10.0.0.5/printers/Office%20HP?waitjob=false");
    assert_eq!((t.host.as_str(), t.path.as_str()), ("10.0.0.5", "/printers/Office%20HP?waitjob=false"));
    assert_eq!(t.printer_uri(), "ipps://10.0.0.5:631/printers/Office%20HP?waitjob=false");
    assert_eq!(parse("ipp://10.0.0.5").path, "/");
    assert_eq!(parse("ipp://10.0.0.5?x=1").path, "/?x=1");
}

#[test]
fn ipv6_literals_keep_their_brackets() {
    let t = parse("ipp://[fe80::1:2]:1631/ipp/print");
    assert_eq!((t.host.as_str(), t.port), ("fe80::1:2", 1631));
    assert_eq!(t.authority(), "[fe80::1:2]:1631");
    assert_eq!(t.printer_uri(), "ipp://[fe80::1:2]:1631/ipp/print");
    assert_eq!(parse("ipps://[::1]/x").port, 631);
}

#[test]
fn malformed_uris_are_unsupported() {
    let bad = ["lpd://p/q", "socket://p:9100", "ipp://", "ipp://:631/x", "ipp://p:0/", "ipp://p:70000/", "ipp://p:abc/", "ipp://[::1/x", "printer.local", ""];
    for uri in bad {
        assert!(matches!(Target::parse(uri), Err(Error::Unsupported(_))), "{uri}");
    }
}

#[cfg(unix)]
#[test]
fn only_plain_ipp_to_local_port_631_may_use_the_cups_socket() {
    let cases = [
        ("ipp://localhost:631/printers/Office", true),
        ("ipp://LOCALHOST/printers/x", true),
        ("ipp://127.0.0.1:631/", true),
        ("ipp://[::1]:631/", true),
        ("ipps://localhost:631/", false),
        ("ipp://localhost:632/", false),
        ("ipp://printer.local:631/", false),
        ("ipp://10.0.0.5/", false),
    ];
    for (uri, local) in cases {
        assert_eq!(parse(uri).is_local_cups(), local, "{uri}");
    }
}

#[test]
fn usable_addresses_skip_loopback_unspecified_and_v6_link_local() {
    let cases = [
        ("192.168.5.174", true),
        ("169.254.10.1", true),
        ("2001:db8::5", true),
        ("127.0.0.1", false),
        ("0.0.0.0", false),
        ("fe80::1", false),
        ("::1", false),
        ("::", false),
    ];
    for (ip, ok) in cases {
        assert_eq!(usable(&ip.parse().unwrap()), ok, "{ip}");
    }
}
