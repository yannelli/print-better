//! DNS-SD advertisement of shared printers: `_ipp._tcp` with the AirPrint `_universal` subtype,
//! plus the `_printer._tcp` port-0 placeholder that defends the name (Bonjour Printing 7.6).

use super::state::Served;
use crate::discovery::mdns::Daemon;
use crate::ipp::codec::clip;
use mdns_sd::{IfKind, ServiceInfo};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

/// mdns-sd 0.22 carries one subtype per registration, so `_print._sub` (IPP Everywhere) is not
/// announced; IPP Everywhere clients browse the base `_ipp._tcp` type anyway.
const IPP: &str = "_universal._sub._ipp._tcp.local.";
const LPD: &str = "_printer._tcp.local.";

struct Registration {
    instance: String,
    txt: Vec<(String, String)>,
    fullnames: Vec<String>,
}

pub(super) struct Advertiser {
    daemon: Daemon,
    host: String,
    label: String,
    port: u16,
    /// Keyed by printer key.
    active: HashMap<String, Registration>,
}

impl Advertiser {
    pub fn new(host_label: &str, port: u16) -> Option<Advertiser> {
        let label = host_label.trim();
        let label = if label.is_empty() { "Print Better" } else { label };
        Some(Advertiser { daemon: Daemon::new()?, host: host_name(label), label: label.to_string(), port, active: HashMap::new() })
    }

    pub fn update(&mut self, printers: &[Arc<Served>]) {
        let keep: HashSet<&str> = printers.iter().map(|p| p.printer.key.as_str()).collect();
        let gone: Vec<String> = self.active.keys().filter(|k| !keep.contains(k.as_str())).cloned().collect();
        for key in gone {
            if let Some(old) = self.active.remove(&key) {
                self.unregister(&old.fullnames);
            }
        }
        for p in printers {
            let instance = clip(&format!("{} @ {}", p.printer.name.trim(), self.label), 63).to_string();
            let txt = txt(p);
            match self.active.get(&p.printer.key) {
                Some(old) if old.instance == instance && old.txt == txt => continue,
                // Re-registering the same name re-announces in place; a new name needs a goodbye first.
                Some(old) if old.instance != instance => {
                    self.unregister(&old.fullnames);
                }
                _ => {}
            }
            match self.register(&instance, &txt) {
                Ok(fullnames) => {
                    self.active.insert(p.printer.key.clone(), Registration { instance, txt, fullnames });
                }
                Err(e) => {
                    log::warn!("share: cannot advertise {instance}: {e}");
                    if let Some(old) = self.active.remove(&p.printer.key) {
                        self.unregister(&old.fullnames);
                    }
                }
            }
        }
    }

    fn register(&self, instance: &str, txt: &[(String, String)]) -> Result<Vec<String>, mdns_sd::Error> {
        let mut ipp = ServiceInfo::new(IPP, instance, &self.host, (), self.port, txt)?.enable_addr_auto();
        ipp.set_interfaces(vec![IfKind::IPv4]);
        let mut lpd = ServiceInfo::new(LPD, instance, &self.host, (), 0, &[] as &[(&str, &str)])?.enable_addr_auto();
        lpd.set_interfaces(vec![IfKind::IPv4]);
        let fullnames = vec![ipp.get_fullname().to_string(), lpd.get_fullname().to_string()];
        self.daemon.register(ipp)?;
        self.daemon.register(lpd)?;
        Ok(fullnames)
    }

    fn unregister(&self, fullnames: &[String]) -> Vec<mdns_sd::Receiver<mdns_sd::UnregisterStatus>> {
        fullnames
            .iter()
            .filter_map(|name| self.daemon.unregister(name).map_err(|e| log::debug!("share: unregister {name}: {e}")).ok())
            .collect()
    }

    /// Sends goodbyes for every registration and waits briefly for them to go out.
    pub async fn withdraw(mut self) {
        let fullnames: Vec<String> = self.active.drain().flat_map(|(_, r)| r.fullnames).collect();
        let pending = self.unregister(&fullnames);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        for receiver in pending {
            if tokio::time::timeout_at(deadline, receiver.recv_async()).await.is_err() {
                break;
            }
        }
    }
}

/// `kitchen-pi-printbetter.local.`: our own host name, so we never fight the OS responder
/// (mDNSResponder, Avahi) over the machine's real one.
fn host_name(label: &str) -> String {
    let mut name = String::new();
    for c in label.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            name.push(c);
        } else if !name.ends_with('-') {
            name.push('-');
        }
    }
    let name = clip(name.trim_matches('-'), 40).trim_end_matches('-');
    if name.is_empty() { "printbetter.local.".to_string() } else { format!("{name}-printbetter.local.") }
}

/// TXT keys per Bonjour Printing 1.2.1 section 9 and PWG 5100.14 section 4.2.
fn txt(p: &Served) -> Vec<(String, String)> {
    let report = &p.printer.report;
    let caps = &report.capabilities;
    let ty = report.make_model.as_deref().unwrap_or(&p.printer.name).trim().to_string();
    let mut out: Vec<(String, String)> = Vec::new();
    let mut put = |key: &str, value: &str| out.push((key.to_string(), clip(value, 254 - key.len()).to_string()));
    put("txtvers", "1");
    put("qtotal", "1");
    put("rp", &format!("ipp/print/{}", p.slug));
    put("ty", &ty);
    if let Some(note) = report.location.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        put("note", note);
    }
    put("product", &format!("({})", clip(&ty, 240)));
    put("pdl", &pdl(p));
    let urf = p.urf();
    put("URF", if urf.is_empty() { "none".to_string() } else { urf.join(",") }.as_str());
    put("Color", if caps.color { "T" } else { "F" });
    put("Duplex", if caps.duplex { "T" } else { "F" });
    put("Copies", "T");
    put("UUID", &p.uuid);
    put("kind", "document");
    put("PaperMax", "legal-A4");
    put("priority", "0");
    put("printbetter", "1");
    out
}

/// Printable formats that fit the 255-byte `pdl=` pair, most preferred first.
fn pdl(p: &Served) -> String {
    let mut out = String::new();
    for f in p.formats.iter().filter(|f| !f.eq_ignore_ascii_case("application/octet-stream")) {
        if out.len() + f.len() + 1 > 250 {
            break;
        }
        if !out.is_empty() {
            out.push(',');
        }
        out.push_str(f);
    }
    out
}
