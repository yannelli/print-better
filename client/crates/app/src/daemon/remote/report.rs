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
    let devices = if s.snapshot.iter().any(|p| p.uuid.is_some()) { cups.devices() } else { Vec::new() };
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

/// Every printer this computer could get, in snapshot order.
fn printers(s: &Survey, devices: &[(String, String)]) -> Vec<SystemPrinter> {
    let direct: HashSet<&str> = s.direct.iter().map(|d| d.id.as_str()).collect();
    let printers = s.snapshot.iter().map(|p| {
        let queue = s.managed.iter().find(|q| q.printer_id == p.id).map(|q| q.name.clone());
        let state = if s.hidden.contains(&p.id) {
            State::Hidden
        } else if queue.is_some() {
            State::Added
        } else if s.failed {
            State::Error
        } else {
            State::Waiting
        };
        let queue = queue.filter(|_| state == State::Added);
        let installed = system::native_queue(devices, p.uuid.as_deref());
        SystemPrinter { id: p.id.clone(), state, queue, installed, direct: direct.contains(p.id.as_str()) }
    });
    printers.collect()
}
