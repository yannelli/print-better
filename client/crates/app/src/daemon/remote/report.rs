//! What the server is told about this computer's remote printers and default printer
//! (`system_printers`), so the web app can show and change them.

use super::cups::{Cups, Queue};
use super::{default, system};
use crate::proto::{DefaultPrinterProblem, DirectPrinter, RemotePrinter, SystemPrinter, SystemPrinterState as State, SystemPrinters};
use crate::store::AppliedDefault;
use std::collections::HashSet;

pub struct Survey {
    pub snapshot: Vec<RemotePrinter>,
    pub direct: Vec<DirectPrinter>,
    pub hidden: Vec<String>,
    /// Snapshot printers this computer reaches on Bonjour right now.
    pub reached: HashSet<String>,
    pub managed: Vec<Queue>,
    /// lpadmin failed on this pass, so queues still missing are errors rather than on their way.
    pub failed: bool,
    pub want: Option<String>,
    pub applied: Option<AppliedDefault>,
}

pub struct Found {
    /// `active` and `error` are the caller's to fill in.
    pub report: SystemPrinters,
    pub applied: Option<AppliedDefault>,
    pub released: bool,
}

/// Runs the lpstat and lpadmin calls behind the report; blocking.
pub fn survey(cups: &dyn Cups, s: Survey) -> Found {
    let reached_uuids = s.snapshot.iter().filter(|p| s.reached.contains(&p.id)).map(|p| &p.uuid);
    let need_devices = reached_uuids.chain(s.direct.iter().map(|d| &d.uuid)).any(Option::is_some);
    let devices = if need_devices { cups.devices() } else { Vec::new() };
    let printers = printers(&s, &devices);
    let target = s.want.as_deref().map_or(Err(DefaultPrinterProblem::Unavailable), |id| default::target(&printers, id));
    let outcome = default::apply(cups, s.want.as_deref(), target, s.applied);
    let default_printer_id = outcome
        .current
        .as_ref()
        .and_then(|queue| printers.iter().find(|p| p.queue.as_ref() == Some(queue)))
        .map(|p| p.id.clone());
    let report = SystemPrinters {
        error: outcome.error,
        printers,
        default_queue: outcome.current,
        default_printer_id,
        default_problem: outcome.problem,
        last_used: cups.last_printer_used(),
        ..SystemPrinters::default()
    };
    Found { report, applied: outcome.applied, released: outcome.released }
}

/// Every printer this computer could get, in snapshot order, then the ones it reaches itself.
fn printers(s: &Survey, devices: &[(String, String)]) -> Vec<SystemPrinter> {
    let entry = |id: &str, state: State, queue: Option<String>| SystemPrinter { id: id.into(), state, queue };
    let hidden = |id: &str| s.hidden.iter().any(|h| h == id);
    let direct = |id: &str, uuid: Option<&str>| {
        if hidden(id) { entry(id, State::Hidden, None) } else { entry(id, State::Direct, system::native_queue(devices, uuid)) }
    };
    let remote = s.snapshot.iter().map(|p| {
        let queue = s.managed.iter().find(|q| q.printer_id == p.id).map(|q| q.name.clone());
        if hidden(&p.id) || s.reached.contains(&p.id) {
            direct(&p.id, p.uuid.as_deref())
        } else if queue.is_some() {
            entry(&p.id, State::Added, queue)
        } else {
            entry(&p.id, if s.failed { State::Error } else { State::Waiting }, None)
        }
    });
    remote.chain(s.direct.iter().map(|d| direct(&d.id, d.uuid.as_deref()))).collect()
}
