//! System print queues for remote printers, kept in step with the server's snapshot by
//! diffing against the queues this daemon recorded as its own.

use crate::fsx;
use crate::net::http::hex;
use crate::paths::Paths;
use super::system;
use crate::proto::RemotePrinter;
use pb_print::share::printer_path;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const PREFIX: &str = "pb_";
const MAX_TEXT: usize = 127;
const AIRPRINT: &[u8] = b"*APAirPrint: True\n";
const PPD_DIR: &str = "/etc/cups/ppd";
/// Bump when the loopback server's attributes change what `-m everywhere` generates, so queues regenerate.
const PPD_SHAPE: u32 = 1;

/// A queue as created (or to be created) with lpadmin.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub printer_id: String,
    pub name: String,
    pub uri: String,
    pub description: String,
    pub location: String,
    /// Fingerprint of what the queue's PPD was generated from; empty in records saved before 0.1.3.
    #[serde(default)]
    pub ppd: String,
}

impl Queue {
    pub fn for_printer(p: &RemotePrinter, port: u16) -> Queue {
        let place = p.location.as_deref().map(str::trim).filter(|l| !l.is_empty()).unwrap_or(&p.client_name);
        Queue {
            printer_id: p.id.clone(),
            name: queue_name(&p.id),
            uri: format!("ipp://127.0.0.1:{port}{}{}", printer_path(&p.id), p.uuid.as_deref().map(|u| format!("?uuid={u}")).unwrap_or_default()),
            description: text(&p.name),
            location: text(&format!("{place} (via Print Better)")),
            ppd: ppd_fingerprint(p),
        }
    }
}

/// Changes only with what `-m everywhere` builds the PPD from (options and model), never with levels or state.
fn ppd_fingerprint(p: &RemotePrinter) -> String {
    let shape = serde_json::json!([PPD_SHAPE, p.capabilities, p.make_model]).to_string();
    hex(&ring::digest::digest(&ring::digest::SHA256, shape.as_bytes()).as_ref()[..8])
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
    /// An update that also regenerates the PPD from the loopback server.
    Refresh(Queue),
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
            Op::Refresh(q) => vec!["-p", &q.name, "-v", &q.uri, "-m", "everywhere", "-D", &q.description, "-L", &q.location],
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
            Some(have) if have.ppd != want.ppd => ops.push(Op::Refresh(want.clone())),
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
    /// Marks the queue's generated PPD as AirPrint where the system needs that to show supply levels.
    fn mark_airprint(&self, queue: &str) -> Result<(), String>;
    /// The system default queue; an error when lpstat could not tell.
    fn default_queue(&self) -> Result<Option<String>, String>;
    /// Every queue with its device URI.
    fn devices(&self) -> Vec<(String, String)>;
    /// The queue's description (printer-info), the name print windows show.
    fn description(&self, queue: &str) -> Option<String>;
    /// macOS "Default printer: Last Printer Used" is on for the signed-in user.
    fn last_printer_used(&self) -> bool;
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
                return adopt(cups, managed, q);
            }
            cups.lpadmin(&op.args()).map_err(|e| failed(q, e))?;
            managed.push(q.clone());
            mark_airprint(cups, q);
        }
        Op::Update(q) | Op::Refresh(q) => {
            let i = recorded(managed, q)?;
            cups.lpadmin(&op.args()).map_err(|e| failed(q, e))?;
            managed[i] = q.clone();
            if matches!(op, Op::Refresh(_)) {
                mark_airprint(cups, q);
            }
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

/// A queue with our name that already points at this loopback server (a lost record, or one recreated by hand)
/// is taken over and regenerated once; any other queue with that name belongs to someone else.
fn adopt(cups: &dyn Cups, managed: &mut Vec<Queue>, q: &Queue) -> Result<(), String> {
    let device = cups.devices().into_iter().find(|(name, _)| *name == q.name).map(|(_, uri)| uri);
    if !device.is_some_and(|uri| same_server(&uri, &q.uri)) {
        return Err(format!("a printer named {} already exists that Print Better did not create", q.name));
    }
    log::info!("remote printers: taking over the existing {}", q.name);
    managed.push(Queue { ppd: String::new(), ..q.clone() });
    run(cups, managed, &Op::Refresh(q.clone()))
}

/// Same loopback host and port as `ours`, on an IPP printer path.
fn same_server(device: &str, ours: &str) -> bool {
    let server = |uri: &str| uri.replacen("://localhost:", "://127.0.0.1:", 1).split_once("/ipp/print/").map(|(s, _)| s.to_string());
    server(device).is_some_and(|s| Some(s) == server(ours))
}

/// Not fatal: the queue prints either way, only Supply Levels stays empty.
fn mark_airprint(cups: &dyn Cups, q: &Queue) {
    if let Err(e) = cups.mark_airprint(&q.name) {
        log::warn!("remote printers: {} will not show supply levels: {e}", q.name);
    }
}

/// `ppd` with `*APAirPrint: True` after its header line; None when it has it already or is no PPD.
pub fn airprint_ppd(ppd: &[u8]) -> Option<Vec<u8>> {
    if !ppd.starts_with(b"*PPD-Adobe:") || ppd.windows(AIRPRINT.len()).any(|w| w == AIRPRINT) {
        return None;
    }
    let header = ppd.iter().position(|&b| b == b'\n')? + 1;
    Some([&ppd[..header], AIRPRINT, &ppd[header..]].concat())
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

/// CUPS on this computer, when its admin tools are installed (never on Windows). `scratch` is a private directory.
pub fn system(scratch: PathBuf) -> Option<SystemCups> {
    if cfg!(windows) {
        return None;
    }
    let find = |name: &str| ["/usr/sbin", "/usr/bin", "/sbin"].iter().map(|d| PathBuf::from(d).join(name)).find(|p| p.exists());
    Some(SystemCups { lpadmin: find("lpadmin")?, lpstat: find("lpstat")?, scratch })
}

pub struct SystemCups {
    lpadmin: PathBuf,
    lpstat: PathBuf,
    scratch: PathBuf,
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

    /// macOS only: its Printers & Scanners reads levels from the printer itself (PrintKit) just for AirPrint queues.
    fn mark_airprint(&self, queue: &str) -> Result<(), String> {
        if !cfg!(target_os = "macos") {
            return Ok(());
        }
        let generated = std::fs::read(Path::new(PPD_DIR).join(format!("{queue}.ppd"))).map_err(|e| format!("reading its PPD: {e}"))?;
        let Some(marked) = airprint_ppd(&generated) else { return Ok(()) };
        let file = self.scratch.join(format!("{queue}.ppd"));
        std::fs::create_dir_all(&self.scratch).and_then(|()| std::fs::write(&file, marked)).map_err(|e| format!("writing its PPD: {e}"))?;
        let result = self.lpadmin(&["-p".into(), queue.into(), "-P".into(), file.display().to_string()]);
        let _ = std::fs::remove_file(&file);
        result
    }

    fn default_queue(&self) -> Result<Option<String>, String> {
        system::lpstat(&self.lpstat, &["-d"]).map(|out| system::parse_default(&out))
    }

    fn devices(&self) -> Vec<(String, String)> {
        system::lpstat(&self.lpstat, &["-v"]).map(|out| system::parse_devices(&out)).unwrap_or_default()
    }

    fn description(&self, queue: &str) -> Option<String> {
        system::lpstat(&self.lpstat, &["-l", "-p", queue]).ok().and_then(|out| system::parse_description(&out))
    }

    fn last_printer_used(&self) -> bool {
        system::last_printer_used()
    }
}
