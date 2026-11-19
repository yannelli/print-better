//! This computer's default printer (`settings.defaultPrinter`). It is set with `lpadmin -d` when the
//! choice or its queue changes, never re-asserted: a default changed here later wins and clears the setting.

use super::cups::Cups;
use crate::proto::{DefaultPrinterProblem as Problem, SystemPrinter, SystemPrinterState as State};
use crate::store::AppliedDefault;

#[derive(Debug, Default, PartialEq)]
pub struct Outcome {
    pub applied: Option<AppliedDefault>,
    /// The default queue after this step.
    pub current: Option<String>,
    pub problem: Option<Problem>,
    pub error: Option<String>,
    /// Someone changed the default on this computer, so the setting goes back to "don't change".
    pub released: bool,
}

/// The queue that makes printer `id` the default here: its `pb_` queue, else (when hidden) its own installed one.
pub fn target(printers: &[SystemPrinter], id: &str) -> Result<String, Problem> {
    let Some(printer) = printers.iter().find(|p| p.id == id) else { return Err(Problem::Unavailable) };
    match (printer.state, &printer.queue, &printer.installed) {
        (State::Added, Some(queue), _) | (State::Hidden, _, Some(queue)) => Ok(queue.clone()),
        (State::Hidden, _, None) => Err(Problem::Hidden),
        _ => Err(Problem::Waiting),
    }
}

pub fn apply(cups: &dyn Cups, want: Option<&str>, target: Result<String, Problem>, applied: Option<AppliedDefault>) -> Outcome {
    let current = match (cups.default_queue(), want) {
        (Ok(current), _) => current,
        (Err(_), None) => return Outcome::default(),
        (Err(e), Some(_)) => {
            let error = Some(format!("could not read the default printer: {e}"));
            return Outcome { applied, problem: Some(Problem::Failed), error, ..Outcome::default() };
        }
    };
    let Some(id) = want else { return Outcome { current, ..Outcome::default() } };
    if let Some(ours) = &applied
        && ours.printer_id == id
        && current.is_some()
        && current != ours.seen
        && cups.exists(&ours.queue)
    {
        log::info!("remote printers: the default printer was changed on this computer; leaving it as is");
        return Outcome { current, released: true, ..Outcome::default() };
    }
    let queue = match target {
        Ok(queue) => queue,
        Err(problem) => return Outcome { current, problem: Some(problem), ..Outcome::default() },
    };
    let record = |seen: Option<String>| Some(AppliedDefault { printer_id: id.into(), queue: queue.clone(), seen });
    if current.as_deref() == Some(queue.as_str()) {
        return Outcome { applied: record(current.clone()), current, ..Outcome::default() };
    }
    // Set before, yet lpstat names another default (a user's lpoptions, say): not ours to fight.
    if current.is_some() && applied.as_ref().is_some_and(|a| a.printer_id == id && a.queue == queue) {
        return Outcome { applied, current, ..Outcome::default() };
    }
    match cups.lpadmin(&["-d".into(), queue.clone()]) {
        Ok(()) => {
            let seen = cups.default_queue().ok().flatten().or_else(|| Some(queue.clone()));
            Outcome { applied: record(seen.clone()), current: seen, ..Outcome::default() }
        }
        Err(e) => {
            let error = Some(format!("could not make {queue} the default printer: {e}"));
            Outcome { applied, current, problem: Some(Problem::Failed), error, ..Outcome::default() }
        }
    }
}
