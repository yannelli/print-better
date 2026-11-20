//! Frozen interface (additive changes only).

use super::check::{check, status_text};
use super::codec::clip;
use super::http::{self, Doc};
use super::tags::{group, op, status};
use super::tls::{Fingerprint, PinStore};
use super::uri::Target;
use super::value::{Attribute, Group, Message, Value};
use super::{job, printer};
use crate::error::{Error, Result};
use crate::model::{Capabilities, JobOptions, PrinterStatus, Sides};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

const REQUEST_IDLE: Duration = Duration::from_secs(30);
/// Generous: busy printers may stop reading mid-document, and a premature failure means a reprint.
const DOCUMENT_IDLE: Duration = Duration::from_secs(300);

/// Job submission parameters. Options already applied during conversion
/// (e.g. page ranges baked into raster) must be cleared by the caller.
#[derive(Clone, Debug)]
pub struct IppJob {
    pub name: String,
    pub user: String,
    /// MIME type of the body, sent as document-format.
    pub format: String,
    pub options: JobOptions,
}

#[derive(Clone, Debug)]
pub enum IppBody {
    File(PathBuf),
    Bytes(Vec<u8>),
    /// A file streamed between a prefix and a suffix, such as a PJL header and trailer.
    Wrapped { head: Vec<u8>, path: PathBuf, tail: Vec<u8> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobStateKind {
    Pending,
    Held,
    Processing,
    Stopped,
    Canceled,
    Aborted,
    Completed,
}

#[derive(Clone, Debug)]
pub struct IppJobState {
    pub state: JobStateKind,
    pub reasons: Vec<String>,
    pub message: Option<String>,
    /// Sides printed so far: job-pages-completed or job-impressions-completed.
    pub impressions: Option<u32>,
    /// Sheets of paper printed so far: job-media-sheets-completed.
    pub sheets: Option<u32>,
}

impl IppJobState {
    /// Progress in whatever the printer counts.
    pub fn pages(&self) -> Option<u32> {
        self.impressions.or(self.sheets)
    }
}

/// Parsed Get-Printer-Attributes response.
#[derive(Clone, Debug, Default)]
pub struct PrinterAttrs {
    pub name: Option<String>,
    pub make_model: Option<String>,
    pub uuid: Option<String>,
    pub location: Option<String>,
    pub capabilities: Capabilities,
    pub status: PrinterStatus,
    /// urf-supported keywords, e.g. ["V1.4", "W8", "SRGB24", "RS300-600"].
    pub urf_supported: Vec<String>,
    /// pwg-raster-document-resolution-supported, dpi.
    pub pwg_resolutions: Vec<u32>,
    /// pwg-raster-document-type-supported, e.g. ["black_1", "sgray_8", "srgb_8"].
    pub pwg_types: Vec<String>,
    pub identify_supported: bool,
    /// page-ranges-supported: the printer itself prints just the requested pages.
    pub page_ranges_supported: bool,
    pub sides_default: Option<Sides>,
    /// document-format-supported lists application/octet-stream: the printer detects the language itself.
    pub auto_sense: bool,
}

/// HTTP/1.1 IPP client over TCP or TLS; IPPS pins printer certs on first use (they are self-signed).
/// `ipp://localhost:631/printers/<q>` falls back to the CUPS domain socket when TCP is closed.
#[derive(Clone)]
pub struct IppClient {
    pub(crate) user_agent: String,
    shared: Arc<Shared>,
}

/// State shared by clones: pins and what each printer taught us.
struct Shared {
    pins: PinStore,
    next_id: AtomicU32,
    /// Authorities that answered IPP/2.0 with version-not-supported.
    ipp11: Mutex<HashSet<String>>,
    /// requesting-user-name of the latest job, reused so CUPS lets that user cancel it.
    user: Mutex<String>,
}

impl IppClient {
    pub fn new(user_agent: &str, state_dir: &Path) -> IppClient {
        let shared = Shared {
            pins: PinStore::new(state_dir),
            next_id: AtomicU32::new(1),
            ipp11: Mutex::new(HashSet::new()),
            user: Mutex::new("printbetter".to_string()),
        };
        IppClient { user_agent: user_agent.to_string(), shared: Arc::new(shared) }
    }

    pub async fn get_printer_attributes(&self, uri: &str) -> Result<PrinterAttrs> {
        Ok(printer::parse(&self.printer_group(uri, printer::REQUESTED).await?))
    }

    /// Print-Job; returns the printer's job-id.
    pub async fn print_job(&self, uri: &str, job: &IppJob, body: IppBody) -> Result<i32> {
        let target = Target::parse(uri)?;
        if !job.user.trim().is_empty() {
            *lock(&self.shared.user) = clip(job.user.trim(), 255).to_string();
        }
        let supported = match self.printer_group(uri, job::SUPPORTED_ATTRS).await {
            Ok(g) => g,
            Err(e @ (Error::Unreachable(_) | Error::NotReady(_) | Error::Rejected(_))) => return Err(e),
            Err(e) => {
                log::warn!("{uri}: cannot read supported job options, sending none: {e}");
                Group { tag: group::PRINTER, attrs: Vec::new() }
            }
        };
        let format = if job.format.is_empty() { "application/octet-stream" } else { job.format.as_str() };
        let mut plain = self.request(op::PRINT_JOB, &target, None);
        if !job.name.trim().is_empty() {
            plain.operation().push("job-name", Value::name(clip(job.name.trim(), 255)));
        }
        plain.operation().push("document-format", Value::mime(format));
        let template = job::template(&job.options, &supported)
            .map_err(|what| Error::Unsupported(format!("{} can't {what}", target.authority())))?;
        let with = |attrs: Vec<Attribute>| {
            let mut msg = plain.clone();
            if !attrs.is_empty() {
                msg.group_mut(group::JOB).attrs = attrs;
            }
            msg
        };
        let doc = Doc::from(body);
        let (mut resp, _) = self.exchange(&target, with(template.clone()), Some(&doc), DOCUMENT_IDLE).await?;
        if matches!(resp.code, status::ATTRIBUTES_NOT_SUPPORTED | status::CONFLICTING_ATTRIBUTES)
            && let Some(kept) = job::retry_template(&template, &unsupported(&resp))
        {
            log::warn!("{uri} refused some job options ({}); resending without them", status_text(&resp));
            resp = self.exchange(&target, with(kept), Some(&doc), DOCUMENT_IDLE).await?.0;
        }
        let resp = check(&target, resp)?;
        let at = target.authority();
        let id = resp
            .attr(group::JOB, "job-id")
            .and_then(Attribute::int)
            .ok_or_else(|| http::may_have_printed(format!("{at}: Print-Job reply has no job-id")))?;
        let ignored = unsupported(&resp);
        if !ignored.is_empty() {
            log::warn!("{uri} accepted job {id} but ignored or substituted {}", ignored.join(", "));
        }
        // Printing every page can't be undone; fewer copies can, so only ignored page-ranges stop the job.
        if ignored.contains(&"page-ranges") && template.iter().any(|a| a.name == "page-ranges") {
            return Err(match self.cancel_job(uri, id).await {
                Ok(()) => Error::Rejected(format!("{at} ignored the page selection, so the job was canceled; a page may have printed")),
                Err(e) => Error::Rejected(format!("{at} ignored the page selection and canceling failed ({e}); it may print every page")),
            });
        }
        Ok(id)
    }

    pub async fn job_state(&self, uri: &str, job_id: i32) -> Result<IppJobState> {
        let target = Target::parse(uri)?;
        let mut msg = self.request(op::GET_JOB_ATTRIBUTES, &target, Some(job_id));
        msg.operation().push_many("requested-attributes", keywords(job::STATE_ATTRS));
        let (resp, _) = self.exchange(&target, msg, None, REQUEST_IDLE).await?;
        // Printers drop finished jobs from their history, some as soon as they finish.
        if matches!(resp.code, status::NOT_FOUND | status::GONE) {
            let state = JobStateKind::Completed;
            return Ok(IppJobState { state, reasons: Vec::new(), message: None, impressions: None, sheets: None });
        }
        check(&target, resp)?
            .group(group::JOB)
            .and_then(job::state)
            .ok_or_else(|| Error::Protocol(format!("{}: no job-state for job {job_id}", target.authority())))
    }

    pub async fn cancel_job(&self, uri: &str, job_id: i32) -> Result<()> {
        let target = Target::parse(uri)?;
        self.call(&target, self.request(op::CANCEL_JOB, &target, Some(job_id))).await.map(drop)
    }

    pub async fn identify(&self, uri: &str) -> Result<()> {
        let target = Target::parse(uri)?;
        self.call(&target, self.request(op::IDENTIFY_PRINTER, &target, None)).await.map(drop)
    }

    /// Get-Printer-Attributes returning the raw printer group. A reported printer-uuid is bound to
    /// the address so certificate pins follow the printer.
    pub(crate) async fn printer_group(&self, uri: &str, requested: &[&str]) -> Result<Group> {
        let target = Target::parse(uri)?;
        let mut msg = self.request(op::GET_PRINTER_ATTRIBUTES, &target, None);
        msg.operation().push_many("requested-attributes", keywords(requested));
        let (resp, cert) = self.exchange(&target, msg, None, REQUEST_IDLE).await?;
        let resp = check(&target, resp)?;
        let group = resp
            .groups
            .into_iter()
            .find(|g| g.tag == group::PRINTER)
            .ok_or_else(|| Error::Protocol(format!("{}: no printer attributes in response", target.authority())))?;
        if let Some(uuid) = group.get("printer-uuid").and_then(Attribute::str).and_then(printer::bare_uuid) {
            self.shared.pins.bind(&target.authority(), &uuid, cert.as_ref())?;
        }
        Ok(group)
    }

    /// Whether an ipps:// printer accepts our TLS handshake; None when that cannot be told.
    pub(crate) async fn tls_works(&self, uri: &str) -> Option<bool> {
        let target = Target::parse(uri).ok().filter(|t| t.tls)?;
        http::tls_handshake_ok(&target, &self.shared.pins).await
    }

    /// A request carrying charset, language, printer-uri, optional job-id, and requesting-user-name.
    pub(crate) fn request(&self, op: u16, target: &Target, job_id: Option<i32>) -> Message {
        let mut msg = Message::new((2, 0), op, 0);
        let ops = msg.operation();
        ops.push("printer-uri", Value::uri(&target.printer_uri()));
        if let Some(id) = job_id {
            ops.push("job-id", Value::Integer(id));
        }
        ops.push("requesting-user-name", Value::name(&lock(&self.shared.user)));
        msg
    }

    /// Sends a request without a document; IPP error statuses become errors.
    pub(crate) async fn call(&self, target: &Target, msg: Message) -> Result<Message> {
        let (resp, _) = self.exchange(target, msg, None, REQUEST_IDLE).await?;
        check(target, resp)
    }

    /// One request/response, retried once as IPP/1.1 for printers that predate IPP/2.0.
    async fn exchange(&self, target: &Target, mut msg: Message, doc: Option<&Doc>, idle: Duration) -> Result<(Message, Option<Fingerprint>)> {
        let at = target.authority();
        if lock(&self.shared.ipp11).contains(&at) {
            msg.version = (1, 1);
        }
        loop {
            msg.request_id = self.shared.next_id.fetch_add(1, Ordering::Relaxed).max(1);
            let reply = http::post(target, &self.shared.pins, &self.user_agent, msg.encode(), doc, idle).await?;
            let (resp, _) = Message::decode(&reply.body).map_err(|e| match doc {
                Some(_) => http::may_have_printed(format!("{at}: unreadable reply: {e}")),
                None => Error::Protocol(format!("{at}: {e}")),
            })?;
            if resp.code == status::VERSION_NOT_SUPPORTED && msg.version != (1, 1) {
                lock(&self.shared.ipp11).insert(at.clone());
                msg.version = (1, 1);
                continue;
            }
            return Ok((resp, reply.cert));
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Attributes the printer listed as unsupported, ignored, or substituted.
fn unsupported(resp: &Message) -> Vec<&str> {
    resp.groups_of(group::UNSUPPORTED).flat_map(|g| g.attrs.iter().map(|a| a.name.as_str())).collect()
}

fn keywords(names: &[&str]) -> Vec<Value> {
    names.iter().map(|n| Value::keyword(n)).collect()
}
