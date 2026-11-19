use super::{Sighting, found};
use crate::discovery::found::MDNS;
use crate::model::RouteKind::{self, *};

const V4: &str = "192.168.5.174";
const V6: &str = "fe80::1";

/// One resolved service of the "Office Laser" instance; TXT keys arrive lowercased.
fn sighting(kind: RouteKind, port: u16, ips: &[&str], txt: &[(&str, &str)]) -> Sighting {
    Sighting {
        kind,
        instance: "Office Laser".into(),
        host: "Laser-123.local.".into(),
        port,
        ips: ips.iter().map(|ip| ip.parse().unwrap()).collect(),
        txt: txt.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
    }
}

fn routes(sightings: Vec<Sighting>) -> Vec<String> {
    found(sightings).map(|f| f.routes.into_iter().map(|r| r.uri).collect()).unwrap_or_default()
}

#[test]
fn every_service_type_becomes_a_route_on_the_ipv4_address() {
    let rp = [("rp", "ipp/print")];
    let f = found(vec![
        sighting(Ipps, 631, &[V6, V4], &rp),
        sighting(Ipp, 631, &[V6, V4], &rp),
        sighting(Socket, 9100, &[V4], &[]),
        sighting(Lpd, 515, &[V4], &[("rp", "RAW")]),
    ])
    .unwrap();
    let uris: Vec<&str> = f.routes.iter().map(|r| r.uri.as_str()).collect();
    let want = [
        "ipps://192.168.5.174:631/ipp/print",
        "ipp://192.168.5.174:631/ipp/print",
        "socket://192.168.5.174:9100",
        "lpd://192.168.5.174:515/RAW",
    ];
    assert_eq!(uris, want);
    assert_eq!(f.hosts, ["laser-123.local", V6, V4]);
    assert_eq!((f.origins, f.name), (MDNS, Some((3, "Office Laser".to_string()))));
}

#[test]
fn ipv6_only_printers_get_bracketed_uris() {
    assert_eq!(routes(vec![sighting(Ipp, 631, &["fd00::5"], &[("rp", "/ipp/print")])]), ["ipp://[fd00::5]:631/ipp/print"]);
}

#[test]
fn lpd_needs_a_real_port_and_a_queue() {
    assert!(routes(vec![sighting(Lpd, 0, &[V4], &[("rp", "RAW")])]).is_empty(), "port 0 is the flagship-naming placeholder");
    assert!(routes(vec![sighting(Lpd, 515, &[V4], &[])]).is_empty());
    assert!(routes(vec![sighting(Ipp, 631, &[], &[])]).is_empty(), "no address, no route");
}

#[test]
fn our_own_shares_are_never_rediscovered() {
    let ours = vec![sighting(Ipp, 631, &[V4], &[("rp", "ipp/print")]), sighting(Ipps, 631, &[V4], &[("printbetter", "1")])];
    assert!(found(ours).is_none());
}

#[test]
fn txt_records_fill_identity_model_and_capabilities() {
    let txt = [
        ("uuid", "URN:UUID:5F0C2A7E-3B1D-4C8E-9A6F-2D4B8E1C7A90"),
        ("note", "2nd floor"),
        ("ty", "HP LaserJet Pro M404-M405"),
        ("usb_mfg", "HP"),
        ("usb_mdl", "LaserJet Pro M404"),
        ("pdl", "application/octet-stream,application/pdf, image/urf,"),
        ("color", "F"),
        ("duplex", "T"),
    ];
    let f = found(vec![sighting(Ipp, 631, &[V4], &txt)]).unwrap();
    assert_eq!(f.uuid.as_deref(), Some("5f0c2a7e-3b1d-4c8e-9a6f-2d4b8e1c7a90"));
    assert_eq!(f.location.as_deref(), Some("2nd floor"));
    assert_eq!(f.make_model, Some((2, "HP LaserJet Pro M404-M405".to_string())));
    let (rank, caps) = f.capabilities.unwrap();
    assert_eq!((rank, caps.formats.as_slice(), caps.color, caps.duplex), (2, &["application/pdf".to_string(), "image/urf".into()][..], false, true));

    let usb = found(vec![sighting(Ipp, 631, &[V4], &txt[3..5])]).unwrap();
    assert_eq!(usb.make_model, Some((2, "HP LaserJet Pro M404".to_string())));
    let product = found(vec![sighting(Ipp, 631, &[V4], &[("product", "(HP LaserJet)")])]).unwrap();
    assert_eq!(product.make_model, Some((2, "HP LaserJet".to_string())));
}

#[test]
fn txt_values_may_come_from_any_of_the_instance_services() {
    let f = found(vec![sighting(Ipp, 631, &[V4], &[("ty", "")]), sighting(Socket, 9100, &[V4], &[("ty", "Brother HL-L2350DW")])]).unwrap();
    assert_eq!(f.make_model, Some((2, "Brother HL-L2350DW".to_string())), "empty values are skipped");
}
