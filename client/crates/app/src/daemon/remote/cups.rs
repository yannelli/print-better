//! System print queues for remote printers, kept in step with the server's snapshot by
//! diffing against the queues this daemon recorded as its own.

use crate::fsx;
use crate::paths::Paths;
use crate::proto::RemotePrinter;
use pb_print::share::printer_path;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub const PREFIX: &str = "pb_";
const MAX_TEXT: usize = 127;

/// A queue as created (or to be created) with lpadmin.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub printer_id: String,
    pub name: String,
    pub uri: String,
    pub description: String,
    pub location: String,
}

impl Queue {
    pub fn for_printer(p: &RemotePrinter, port: u16) -> Queue {
        let place = p.location.as_deref().map(str::trim).filter(|l| !l.is_empty()).unwrap_or(&p.client_name);
        Queue {
            printer_id: p.id.clone(),
            name: queue_name(&p.id),
            uri: format!("ipp://127.0.0.1:{port}{}", printer_path(&p.id)),
            description: text(&p.name),
            location: text(&format!("{place} (via Print Better)")),
        }
    }
}

/// `pb_<printerId>`, limited to characters CUPS accepts in queue names.
pub fn queue_name(printer_id: &str) -> String {
    let safe: String = printer_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(MAX_TEXT - PREFIX.len())
        .collect();
    format!("{PREFIX}{safe}")
}

/// Single-line text for -D/-L: control characters dropped, length capped.
fn text(raw: &str) -> String {
    let line: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    line.trim().chars().take(MAX_TEXT).collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Op {
    Add(Queue),
    Update(Queue),
    Remove(Queue),
}

impl Op {
    pub fn args(&self) -> Vec<String> {
        let args: Vec<&str> = match self {
            Op::Add(q) => vec![
                "-p", &q.name, "-E", "-v", &q.uri, "-m", "everywhere", "-D", &q.description, "-L", &q.location, "-o",
                "printer-is-shared=false",
            ],
            Op::Update(q) => vec!["-p", &q.name, "-v", &q.uri, "-D", &q.description, "-L", &q.location],
            Op::Remove(q) => vec!["-x", &q.name],
        };
        args.into_iter().map(String::from).collect()
    }
}

/// Removals first, then additions and updates; queues that already match are left alone.
pub fn plan(managed: &[Queue], desired: &[Queue]) -> Vec<Op> {
    let mut ops: Vec<Op> = managed
        .iter()
        .filter(|m| !desired.iter().any(|d| d.printer_id == m.printer_id))
        .map(|m| Op::Remove(m.clone()))
        .collect();
    for want in desired {
        match managed.iter().find(|m| m.printer_id == want.printer_id) {
            None => ops.push(Op::Add(want.clone())),
            Some(have) if have != want => ops.push(Op::Update(want.clone())),
            Some(_) => {}
        }
    }
    ops
}

/// The system's CUPS admin tools; tests substitute a fake.
pub trait Cups: Send + Sync {
    /// Runs lpadmin; the error carries what it printed.
    fn lpadmin(&self, args: &[String]) -> Result<(), String>;
    fn exists(&self, queue: &str) -> bool;
}

/// Runs `ops`, updating `managed` after each success. Returns the first failure.
pub fn apply(cups: &dyn Cups, managed: &mut Vec<Queue>, ops: Vec<Op>) -> Option<String> {
    let mut first_error = None;
    for op in ops {
        if let Err(e) = run(cups, managed, &op) {
            log::warn!("remote printers: {e}");
            first_error.get_or_insert(e);
        }
    }
    first_error
}

fn run(cups: &dyn Cups, managed: &mut Vec<Queue>, op: &Op) -> Result<(), String> {
    let failed = |q: &Queue, e: String| format!("could not change the system printer {}: {e}", q.name);
    match op {
        Op::Add(q) => {
            if cups.exists(&q.name) {
                return Err(format!("a printer named {} already exists that Print Better did not create", q.name));
            }
            cups.lpadmin(&op.args()).map_err(|e| failed(q, e))?;
            managed.push(q.clone());
        }
        Op::Update(q) => {
            let i = recorded(managed, q)?;
            cups.lpadmin(&op.args()).map_err(|e| failed(q, e))?;
            managed[i] = q.clone();
        }
        Op::Remove(q) => {
            let i = recorded(managed, q)?;
            if let Err(e) = cups.lpadmin(&op.args())
                && cups.exists(&q.name)
            {
                return Err(failed(q, e));
            }
            managed.remove(i);
        }
    }
    Ok(())
}

/// Where `q` sits in the managed list; queues this daemon did not create are never touched.
fn recorded(managed: &[Queue], q: &Queue) -> Result<usize, String> {
    managed
        .iter()
        .position(|m| m.name == q.name && m.printer_id == q.printer_id)
        .filter(|_| q.name.starts_with(PREFIX))
        .ok_or_else(|| format!("refusing to change {}: Print Better did not create it", q.name))
}

pub fn load(paths: &Paths) -> Vec<Queue> {
    fsx::read_json(&paths.remote_queues()).unwrap_or_else(|e| {
        log::warn!("ignoring unreadable {}: {e}", paths.remote_queues().display());
        None
    })
    .unwrap_or_default()
}

pub fn save(paths: &Paths, queues: &[Queue]) {
    if let Err(e) = fsx::write_json(&paths.remote_queues(), &queues, false) {
        log::warn!("could not save the list of remote printer queues: {e}");
    }
}

/// CUPS on this computer, when its admin tools are installed (never on Windows).
pub fn system() -> Option<SystemCups> {
    if cfg!(windows) {
        return None;
    }
    let find = |name: &str| ["/usr/sbin", "/usr/bin", "/sbin"].iter().map(|d| PathBuf::from(d).join(name)).find(|p| p.exists());
    Some(SystemCups { lpadmin: find("lpadmin")?, lpstat: find("lpstat")? })
}

pub struct SystemCups {
    lpadmin: PathBuf,
    lpstat: PathBuf,
}

impl Cups for SystemCups {
    fn lpadmin(&self, args: &[String]) -> Result<(), String> {
        log::info!("remote printers: lpadmin {}", args.join(" "));
        let out = Command::new(&self.lpadmin).args(args).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let said = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if said.is_empty() { format!("lpadmin exited with {}", out.status) } else { said })
    }

    fn exists(&self, queue: &str) -> bool {
        let status = Command::new(&self.lpstat).args(["-p", queue]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
        status.is_ok_and(|s| s.success())
    }
}
