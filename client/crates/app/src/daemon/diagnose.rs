//! Health checks shared by the `diagnose` command and `printbetter doctor`.

use super::{Conn, Daemon};
use crate::fsx;
use crate::net::{ServerUrl, http};
use crate::paths::Paths;
use crate::store::Credentials;
use pb_print::{DiscoverOptions, Engine, PrinterReport, RouteKind};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::time::timeout;

const MAX_PROBED: usize = 5;
const CLOCK_SLACK_MS: i64 = 120_000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

fn check(name: &str, ok: bool, detail: impl Into<String>) -> Check {
    Check { name: name.into(), ok, detail: detail.into() }
}

pub fn discovery_off(o: &DiscoverOptions) -> bool {
    !(o.mdns || o.snmp || o.usb || o.os)
}

pub struct Inputs {
    pub creds: Option<Credentials>,
    /// Session state; `None` when checking without a running daemon.
    pub connection: Option<(Conn, Option<String>)>,
    pub clock_offset_ms: Option<i64>,
    pub discovered: Option<usize>,
    /// Every discovery method is off in settings, so finding nothing is expected.
    pub discovery_off: bool,
    pub probe: Vec<PrinterReport>,
}

pub async fn run(engine: &Engine, paths: &Paths, inputs: Inputs) -> Vec<Check> {
    let mut checks = Vec::new();
    match &inputs.creds {
        Some(creds) => {
            checks.push(check("Pairing", true, format!("Paired as \"{}\" with {}", creds.name, creds.server)));
            checks.push(server(creds).await);
        }
        None => checks.push(check("Pairing", false, "Not paired. Run: printbetter pair --server URL")),
    }
    if let Some((conn, detail)) = inputs.connection {
        let detail = detail.unwrap_or_else(|| format!("{conn:?}"));
        checks.push(check("Connection", conn == Conn::Online, detail));
    }
    if let Some(offset) = inputs.clock_offset_ms {
        let ok = offset.abs() <= CLOCK_SLACK_MS;
        let detail = if ok {
            format!("Within {} s of the server", offset.abs() / 1000)
        } else {
            format!("This computer's clock is off by {} min. Turn on automatic date and time.", offset.abs() / 60_000)
        };
        checks.push(check("Clock", ok, detail));
    }
    checks.push(storage(paths));
    if inputs.discovery_off {
        checks.push(check("Discovery", true, "Off in this device's settings".to_string()));
    } else if let Some(found) = inputs.discovered {
        let detail = match found {
            0 => "No printers found. Check that the printer is on and on the same network.".to_string(),
            n => format!("{n} printer(s) found"),
        };
        checks.push(check("Discovery", found > 0, detail));
    }
    for printer in inputs.probe.iter().take(MAX_PROBED) {
        match timeout(Duration::from_secs(20), engine.probe(printer)).await {
            Ok(routes) => checks.extend(routes.into_iter().map(|(route, result)| {
                let name = format!("{} via {}", printer.name, route_label(route.kind));
                match result {
                    Ok(()) => check(&name, true, route.uri),
                    Err(e) => check(&name, false, format!("{}: {e}", route.uri)),
                }
            })),
            Err(_) => checks.push(check(&printer.name, false, "The printer did not answer.")),
        }
    }
    checks
}

/// Checks for the running daemon: its live connection, clock offset, and added printers.
pub async fn for_daemon(d: &Daemon) -> Vec<Check> {
    let added = d.added_keys();
    let off = discovery_off(&crate::settings::discover_options(&d.settings(), None));
    let inputs = d.with_state(|st| {
        let known: Vec<PrinterReport> = st.inventory.printers.values().cloned().collect();
        let added_ones: Vec<PrinterReport> = known.iter().filter(|p| added.contains(&p.key)).cloned().collect();
        Inputs {
            creds: st.creds.clone(),
            connection: Some((st.conn, st.conn_detail.clone())),
            clock_offset_ms: st.clock_offset_ms,
            discovered: st.inventory.discovered_at.map(|_| known.len()),
            discovery_off: off,
            probe: if added_ones.is_empty() { known } else { added_ones },
        }
    });
    let mut checks = run(&d.engine, &d.paths, inputs).await;
    checks.extend(remote_printers(d));
    checks.push(updates(d));
    checks
}

/// Unsupported installs (Windows, a bare development binary on macOS) are reported, not failed.
fn updates(d: &Daemon) -> Check {
    let name = "Updates";
    if let Err(why) = crate::update::Target::detect() {
        return check(name, true, why);
    }
    if let Err(why) = super::can_install_update(d) {
        return check(name, false, why);
    }
    d.with_state(|st| {
        let (s, version) = (&st.update, crate::VERSION);
        let how = if st.config.settings.auto_update { "it installs automatically" } else { "install it with: printbetter update" };
        match (&s.error, &s.latest) {
            (Some(error), _) => check(name, false, error.clone()),
            (None, Some(latest)) if s.available => check(name, true, format!("Print Better {latest} is available (this is {version}); {how}")),
            (None, _) if s.checked_at.is_some() => check(name, true, format!("Up to date ({version})")),
            _ => check(name, true, format!("Print Better {version}; not checked for updates yet")),
        }
    })
}

/// Only where the feature exists and is wanted; the status page explains the rest.
fn remote_printers(d: &Daemon) -> Option<Check> {
    d.with_state(|st| {
        let no_cups = st.remote.error.as_deref() == Some(super::REMOTE_PRINTERS_NO_CUPS);
        if !super::REMOTE_PRINTERS_SUPPORTED || st.creds.is_none() || !st.config.settings.remote_printers || no_cups {
            return None;
        }
        let name = "Remote printers";
        Some(match (&st.remote.error, st.remote.active) {
            (Some(error), _) => check(name, false, error.clone()),
            (None, false) => check(name, false, "Not started yet"),
            (None, true) => {
                let count = st.remote.queues.len();
                check(name, true, format!("{count} printer(s) from other devices in this computer's print dialog"))
            }
        })
    })
}

async fn server(creds: &Credentials) -> Check {
    let url = match ServerUrl::parse(&creds.server) {
        Ok(url) => url,
        Err(e) => return check("Server", false, e),
    };
    let started = Instant::now();
    match http::get_json::<serde_json::Value>(&url, "/api/instance", None).await {
        Ok(_) => check("Server", true, format!("Reachable in {} ms", started.elapsed().as_millis())),
        Err(e) => check("Server", false, format!("Can't reach {}: {e}", creds.server)),
    }
}

fn storage(paths: &Paths) -> Check {
    let probe = paths.state.join(".write-test");
    match fsx::write_atomic(&probe, b"ok", false).and_then(|()| fsx::remove_if_exists(&probe)) {
        Ok(()) => check("Storage", true, format!("Can save settings and jobs in {}", paths.state.display())),
        Err(e) => check("Storage", false, format!("Can't write to {}: {e}", paths.state.display())),
    }
}

fn route_label(kind: RouteKind) -> &'static str {
    match kind {
        RouteKind::Ipps => "IPPS",
        RouteKind::Ipp => "IPP",
        RouteKind::Socket => "raw port 9100",
        RouteKind::Lpd => "LPD",
        RouteKind::Usb => "USB",
        RouteKind::Os => "system print queue",
    }
}
