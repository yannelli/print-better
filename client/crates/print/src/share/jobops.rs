//! Job-level operations: Send-Document, Close-Job, Cancel-Job, Cancel-My-Jobs, Get-Jobs and
//! Get-Job-Attributes. Jobs carry one document (multiple-document-jobs-supported = false).

use super::jobs::{self, Job, Status};
use super::ops::{Ctx, Fail, OpResult, declared_format, job_response, receive, submit};
use super::state::Served;
use super::upload::Upload;
use super::{SharedJobState, attrs};
use crate::ipp::tags::{group, status};
use crate::ipp::{Attribute, Group, Message, Value};

const JOB_GROUPS: [&str; 3] = ["job-description", "job-status", "job-template"];

pub(super) async fn send_document(ctx: &Ctx, p: &Served, req: &Message, upload: Upload, resp: &mut Message) -> OpResult {
    let id = job_id(req)?;
    let last = req.attr(group::OPERATION, "last-document").and_then(Attribute::bool).unwrap_or(true);
    let name = match ctx.state.jobs().get(&p.slug, id) {
        Some(job) if job.incoming() => job.name.clone(),
        Some(_) => return Err(Fail::new(status::NOT_POSSIBLE, "job is not accepting documents")),
        None => return Err(not_found(id)),
    };
    let declared = declared_format(p, req)?;
    let doc = receive(ctx, p, upload, declared, &name).await?;
    let ready = {
        let mut table = ctx.state.jobs();
        let Some(job) = table.get_mut(&p.slug, id).filter(|j| j.incoming()) else {
            doc.iter().for_each(jobs::remove);
            return Err(Fail::new(status::NOT_POSSIBLE, "job is no longer accepting documents"));
        };
        if let Some(doc) = doc {
            if job.doc.is_some() {
                jobs::remove(&doc);
                return Err(Fail::new(status::MULTIPLE_DOCUMENTS_NOT_SUPPORTED, "only one document per job"));
            }
            job.doc = Some(doc);
        }
        if last { Some(take_document(job)?) } else { None }
    };
    if let Some(doc) = ready {
        submit(ctx, p, id, doc)?;
    }
    job_response(ctx, p, id, resp);
    Ok(())
}

pub(super) fn close_job(ctx: &Ctx, p: &Served, req: &Message, resp: &mut Message) -> OpResult {
    let id = job_id(req)?;
    let ready = {
        let mut table = ctx.state.jobs();
        let job = table.get_mut(&p.slug, id).ok_or_else(|| not_found(id))?;
        if job.incoming() { Some(take_document(job)?) } else { None }
    };
    if let Some(doc) = ready {
        submit(ctx, p, id, doc)?;
    }
    job_response(ctx, p, id, resp);
    Ok(())
}

/// The held document of a job being closed; a job closed without one is aborted.
fn take_document(job: &mut Job) -> Result<crate::model::Document, Fail> {
    job.doc.take().ok_or_else(|| {
        job.end(SharedJobState::Aborted);
        Fail::new(status::BAD_REQUEST, "job has no document")
    })
}

pub(super) fn cancel_job(ctx: &Ctx, p: &Served, req: &Message) -> OpResult {
    cancel(ctx, p, job_id(req)?)
}

pub(super) fn cancel_my_jobs(ctx: &Ctx, p: &Served, req: &Message) -> OpResult {
    let user = req.attr(group::OPERATION, "requesting-user-name").and_then(Attribute::str).map_or("", str::trim);
    let mine: Vec<i32> = ctx.state.jobs().on(&p.slug).iter().filter(|j| j.user == user).map(|j| j.id).collect();
    for id in mine {
        if let Err(fail) = cancel(ctx, p, id) {
            log::debug!("share: Cancel-My-Jobs skipped job {id}: {}", fail.message);
        }
    }
    Ok(())
}

fn cancel(ctx: &Ctx, p: &Served, id: i32) -> OpResult {
    let sink_id = {
        let mut table = ctx.state.jobs();
        let job = table.get_mut(&p.slug, id).ok_or_else(|| not_found(id))?;
        if job.incoming() {
            job.end(SharedJobState::Canceled);
            return Ok(());
        }
        job.sink_id.filter(|_| job.ended.is_none())
    };
    let sink = &ctx.state.sink;
    let active = |sid| matches!(sink.state(sid), Some((SharedJobState::Pending | SharedJobState::Processing, _)));
    match sink_id {
        Some(sid) if active(sid) && sink.cancel(sid) => Ok(()),
        _ => Err(Fail::new(status::NOT_POSSIBLE, "job has already ended")),
    }
}

pub(super) fn get_jobs(ctx: &Ctx, p: &Served, req: &Message, resp: &mut Message) -> OpResult {
    let op = |name: &str| req.attr(group::OPERATION, name);
    let which = op("which-jobs").and_then(Attribute::str).unwrap_or("not-completed");
    let limit = op("limit").and_then(Attribute::int).and_then(|n| usize::try_from(n).ok()).filter(|&n| n > 0);
    let mine = op("my-jobs").and_then(Attribute::bool).unwrap_or(false);
    let user = op("requesting-user-name").and_then(Attribute::str).map_or("", str::trim);
    let default = Attribute::many("requested-attributes", vec![Value::keyword("job-id"), Value::keyword("job-uri")]);
    let requested = op("requested-attributes").unwrap_or(&default);

    let snapshot = ctx.state.jobs().on(&p.slug);
    let mut list: Vec<(Job, Status)> = snapshot
        .into_iter()
        .filter(|j| !mine || j.user == user)
        .map(|j| {
            let status = j.status(ctx.state.sink.as_ref());
            (j, status)
        })
        .collect();
    match which {
        "not-completed" => list.retain(|(_, s)| s.active()),
        "completed" => {
            list.retain(|(_, s)| !s.active());
            list.reverse();
        }
        "all" => list.reverse(),
        other => return Err(Fail::new(status::ATTRIBUTES_NOT_SUPPORTED, format!("which-jobs '{other}' is not supported"))),
    }
    let printer_uri = ctx.printer_uri(p);
    let up_time = ctx.state.up_time();
    for (job, status) in list.into_iter().take(limit.unwrap_or(usize::MAX)) {
        let all = jobs::attributes(&job, &status, &printer_uri, up_time);
        resp.groups.push(Group { tag: group::JOB, attrs: attrs::select(all, Some(requested), &JOB_GROUPS) });
    }
    Ok(())
}

pub(super) fn get_job_attributes(ctx: &Ctx, p: &Served, req: &Message, resp: &mut Message) -> OpResult {
    let id = job_id(req)?;
    let job = ctx.state.jobs().get(&p.slug, id).cloned().ok_or_else(|| not_found(id))?;
    let status = job.status(ctx.state.sink.as_ref());
    let all = jobs::attributes(&job, &status, &ctx.printer_uri(p), ctx.state.up_time());
    let requested = req.attr(group::OPERATION, "requested-attributes");
    resp.group_mut(group::JOB).attrs = attrs::select(all, requested, &JOB_GROUPS);
    Ok(())
}

/// job-id, or the trailing number of job-uri when the client targets the job by URI.
fn job_id(req: &Message) -> Result<i32, Fail> {
    let op = |name: &str| req.attr(group::OPERATION, name);
    op("job-id")
        .and_then(Attribute::int)
        .or_else(|| op("job-uri").and_then(Attribute::str).and_then(|u| u.rsplit('/').next()?.parse().ok()))
        .ok_or_else(|| Fail::new(status::BAD_REQUEST, "missing job-id"))
}

fn not_found(id: i32) -> Fail {
    Fail::new(status::NOT_FOUND, format!("job {id} not found"))
}
