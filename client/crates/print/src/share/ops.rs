//! IPP operations served for each shared printer (RFC 8011 plus the PWG 5100.13/5100.14 subset
//! phones use). Printer-level operations live here; job-level ones in `jobops`.

use super::jobops;
use super::jobs::{self, Job};
use super::state::{Served, State};
use super::upload::{SpoolError, Upload};
use super::{SharedJob, SharedJobState, attrs, media};
use crate::ipp::codec::clip;
use crate::ipp::tags::{group, op, status};
use crate::ipp::value::find;
use crate::ipp::{Attribute, Message, Value};
use crate::model::{DocFormat, Document, JobOptions};
use std::sync::Arc;

pub(super) struct Ctx {
    pub state: Arc<State>,
    pub printer: Option<Arc<Served>>,
    /// Authority the client used to reach us, for printer-uri-supported and job-uri.
    pub host: String,
}

impl Ctx {
    pub fn printer_uri(&self, p: &Served) -> String {
        format!("ipp://{}/ipp/print/{}", self.host, p.slug)
    }
}

pub(super) struct Fail {
    pub status: u16,
    pub message: String,
}

impl Fail {
    pub fn new(status: u16, message: impl Into<String>) -> Fail {
        Fail { status, message: message.into() }
    }
}

pub(super) type OpResult = Result<(), Fail>;

pub(super) async fn dispatch(ctx: &Ctx, req: &Message, upload: Upload) -> Message {
    let version = if req.version.0 == 1 { req.version } else { (2, 0) };
    let mut resp = Message::new(version, status::OK, req.request_id);
    if let Err(fail) = run(ctx, req, upload, &mut resp).await {
        resp.code = fail.status;
        resp.groups.retain(|g| g.tag == group::OPERATION);
        resp.operation().push("status-message", Value::text(clip(&fail.message, 255)));
    }
    resp
}

async fn run(ctx: &Ctx, req: &Message, upload: Upload, resp: &mut Message) -> OpResult {
    if !matches!(req.version.0, 1 | 2) {
        return Err(Fail::new(status::VERSION_NOT_SUPPORTED, "only IPP/1.x and IPP/2.x are supported"));
    }
    if req.request_id == 0 || req.groups.first().map(|g| g.tag) != Some(group::OPERATION) {
        return Err(Fail::new(status::BAD_REQUEST, "missing request-id or operation attributes"));
    }
    let Some(p) = ctx.printer.clone() else { return Err(Fail::new(status::NOT_FOUND, "no such printer")) };
    match req.code {
        op::GET_PRINTER_ATTRIBUTES => {
            let all = attrs::printer(&p, &ctx.printer_uri(&p), ctx.state.up_time());
            let requested = req.attr(group::OPERATION, "requested-attributes");
            resp.group_mut(group::PRINTER).attrs = attrs::select(all, requested, &["printer-description", "job-template"]);
            Ok(())
        }
        op::VALIDATE_JOB => declared_format(&p, req).map(drop),
        op::PRINT_JOB => print_job(ctx, &p, req, upload, resp).await,
        op::CREATE_JOB => {
            let id = ctx.state.jobs().add(Ticket::read(&p, req).job(&p, ctx.state.up_time()));
            job_response(ctx, &p, id, resp);
            Ok(())
        }
        op::IDENTIFY_PRINTER => {
            log::info!("share: identify requested for {}", p.printer.name);
            Ok(())
        }
        op::SEND_DOCUMENT => jobops::send_document(ctx, &p, req, upload, resp).await,
        op::CLOSE_JOB => jobops::close_job(ctx, &p, req, resp),
        op::CANCEL_JOB => jobops::cancel_job(ctx, &p, req),
        op::CANCEL_MY_JOBS => jobops::cancel_my_jobs(ctx, &p, req),
        op::GET_JOBS => jobops::get_jobs(ctx, &p, req, resp),
        op::GET_JOB_ATTRIBUTES => jobops::get_job_attributes(ctx, &p, req, resp),
        _ => Err(Fail::new(status::OPERATION_NOT_SUPPORTED, "operation not supported")),
    }
}

async fn print_job(ctx: &Ctx, p: &Served, req: &Message, upload: Upload, resp: &mut Message) -> OpResult {
    let declared = declared_format(p, req)?;
    let ticket = Ticket::read(p, req);
    let doc = receive(ctx, p, upload, declared, &ticket.name).await?;
    let doc = doc.ok_or_else(|| Fail::new(status::BAD_REQUEST, "no document data"))?;
    let id = ctx.state.jobs().add(ticket.job(p, ctx.state.up_time()));
    submit(ctx, p, id, doc)?;
    job_response(ctx, p, id, resp);
    Ok(())
}

/// Job name, owner, and options from a Print-Job or Create-Job request.
struct Ticket {
    name: String,
    user: String,
    options: JobOptions,
}

impl Ticket {
    fn read(p: &Served, req: &Message) -> Ticket {
        let text = |name: &str| req.attr(group::OPERATION, name).and_then(Attribute::str).map(str::trim).filter(|s| !s.is_empty());
        let job_attrs = req.group(group::JOB).map_or(&[][..], |g| g.attrs.as_slice());
        let mut options = crate::ipp::job::options(job_attrs);
        if options.media.is_none() {
            options.media = find(job_attrs, "media-col").and_then(|col| media::from_col(col, &p.media()));
        }
        let name = text("job-name").or_else(|| text("document-name")).unwrap_or("Untitled");
        let user = text("requesting-user-name").unwrap_or("");
        Ticket { name: clip(name, 255).to_string(), user: clip(user, 255).to_string(), options }
    }

    fn job(&self, p: &Served, created: i32) -> Job {
        Job::new(&p.slug, self.name.clone(), self.user.clone(), self.options.clone(), created)
    }
}

/// The client's document-format when it names one; octet-stream means "sniff it".
pub(super) fn declared_format(p: &Served, req: &Message) -> Result<Option<DocFormat>, Fail> {
    let declared = req.attr(group::OPERATION, "document-format").and_then(Attribute::str).map(str::trim);
    let Some(mime) = declared.filter(|m| !m.is_empty() && !m.eq_ignore_ascii_case("application/octet-stream")) else {
        return Ok(None);
    };
    let format = DocFormat::from_mime(mime);
    if format == DocFormat::Unknown || !p.accepts(format.mime()) {
        return Err(Fail::new(status::DOCUMENT_FORMAT_NOT_SUPPORTED, format!("{mime} is not supported")));
    }
    Ok(Some(format))
}

/// Spools the request's document; None when the request carried no data.
pub(super) async fn receive(
    ctx: &Ctx,
    p: &Served,
    upload: Upload,
    declared: Option<DocFormat>,
    title: &str,
) -> Result<Option<Document>, Fail> {
    let spooled = match upload.spool(&ctx.state.opts.spool_dir).await {
        Ok(Some(spooled)) => spooled,
        Ok(None) => return Ok(None),
        Err(SpoolError::TooLarge) => return Err(Fail::new(status::TOO_LARGE, "document is too large")),
        Err(SpoolError::Read(e)) => return Err(Fail::new(status::BAD_REQUEST, format!("reading document: {e}"))),
        Err(SpoolError::Disk(e)) => {
            log::warn!("share: cannot spool into {}: {e}", ctx.state.opts.spool_dir.display());
            return Err(Fail::new(status::INTERNAL_ERROR, "cannot store the document"));
        }
    };
    let format = declared.unwrap_or_else(|| spooled.sniff());
    if format == DocFormat::Unknown || !p.accepts(format.mime()) {
        return Err(Fail::new(status::DOCUMENT_FORMAT_NOT_SUPPORTED, "unrecognized or unsupported document format"));
    }
    let path = spooled.keep(format).await.map_err(|e| {
        log::warn!("share: cannot store spooled document: {e}");
        Fail::new(status::INTERNAL_ERROR, "cannot store the document")
    })?;
    Ok(Some(Document { path, format, name: title.to_string() }))
}

/// Hands a received document to the app's queue; the sink owns the file from here on.
pub(super) fn submit(ctx: &Ctx, p: &Served, id: i32, doc: Document) -> OpResult {
    let job = ctx.state.jobs().get(&p.slug, id).map(|j| SharedJob {
        printer_key: p.printer.key.clone(),
        title: j.name.clone(),
        user: Some(j.user.clone()).filter(|u| !u.is_empty()),
        doc: doc.clone(),
        options: j.options.clone(),
    });
    let Some(job) = job else {
        jobs::remove(&doc);
        return Err(Fail::new(status::NOT_FOUND, "job no longer exists"));
    };
    match ctx.state.sink.submit(job) {
        Ok(sink_id) => {
            let ended = ctx.state.jobs().get_mut(&p.slug, id).is_some_and(|j| {
                j.sink_id = Some(sink_id);
                j.ended.is_some()
            });
            // Canceled (or expired) while the sink was taking it: pass the cancel on.
            if ended {
                ctx.state.sink.cancel(sink_id);
            }
            Ok(())
        }
        Err(message) => {
            jobs::remove(&doc);
            if let Some(j) = ctx.state.jobs().get_mut(&p.slug, id) {
                j.end(SharedJobState::Aborted);
            }
            // "Service unavailable" makes CUPS hold the job and retry instead of failing it.
            Err(Fail::new(status::SERVICE_UNAVAILABLE, message))
        }
    }
}

/// The job attributes every job-creating operation returns.
pub(super) fn job_response(ctx: &Ctx, p: &Served, id: i32, resp: &mut Message) {
    let Some(job) = ctx.state.jobs().get(&p.slug, id).cloned() else { return };
    let status = job.status(ctx.state.sink.as_ref());
    let keep = ["job-id", "job-uri", "job-state", "job-state-reasons", "job-state-message"];
    let all = jobs::attributes(&job, &status, &ctx.printer_uri(p), ctx.state.up_time());
    resp.group_mut(group::JOB).attrs = all.into_iter().filter(|a| keep.contains(&a.name.as_str())).collect();
}
