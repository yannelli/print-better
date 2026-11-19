//! Windows `os://` routes: RAW passthrough when the data is already the printer's language,
//! otherwise pages drawn through the driver with GDI; then the spooler job is followed.

use super::print::{Attempt, Converted};
use super::{PrintEvent, PrintOutcome, reasons};
use crate::backends::windows::{gdi, spool};
use crate::backends::{Payload, os, pjl};
use crate::convert::{self, Plan, Target};
use crate::error::{Error, Result};
use crate::model::{DocFormat, PrinterStatus, Route, RouteKind};
use std::time::{Duration, Instant};
use windows_sys::Win32::Graphics::Printing::*;

const FIRST_POLL: Duration = Duration::from_millis(500);
const MAX_POLL: Duration = Duration::from_secs(5);
const FOLLOW_LIMIT: Duration = Duration::from_secs(2 * 3600);
const GONE_AFTER: u32 = 3;

pub(crate) async fn status(route: &Route) -> Result<PrinterStatus> {
    let name = os::queue_name(&route.uri)?;
    convert::blocking(move || crate::backends::windows::status(&name)).await
}

pub(crate) async fn print(a: &Attempt<'_>, converted: &mut Converted) -> Result<PrintOutcome> {
    let name = os::queue_name(&a.route.uri)?;
    if let Some(why) = reasons::blocking(&status(a.route).await?) {
        return Err(Error::NotReady(why));
    }
    let target = Target::spooler(&a.printer.capabilities);
    let (job, pages) = match convert::plan(a.input, &target, a.options)? {
        Plan::Gdi(input) => draw(a, &name, input).await?,
        _ => match raw(a, &name, &target, converted).await {
            Err(Error::Unsupported(why)) => {
                log::info!("RAW printing to {name} refused ({why}); drawing with GDI instead");
                draw(a, &name, a.input).await?
            }
            other => other?,
        },
    };
    a.emit(PrintEvent::Printing { pages_done: None });
    follow(a, &name, job, pages).await
}

async fn raw(a: &Attempt<'_>, name: &str, target: &Target, converted: &mut Converted) -> Result<(u32, Option<u32>)> {
    let prepared = a.prepare(target, converted).await?;
    let wrapper = if target.pjl { pjl::wrap(prepared.format, &a.doc.name, a.options) } else { None };
    let (prefix, suffix) = wrapper.unwrap_or_default();
    let payload = Payload { prefix, path: prepared.path.clone(), suffix, repeat: prepared.repeat };
    let pages = prepared.pages;
    a.emit(PrintEvent::Submitting { route: RouteKind::Os });
    let (name, doc, cancel) = (name.to_string(), a.doc.name.clone(), a.cancel.clone());
    let job = convert::blocking(move || spool::send_raw(&name, &payload, &doc, &cancel)).await?;
    Ok((job, pages))
}

async fn draw(a: &Attempt<'_>, name: &str, input: DocFormat) -> Result<(u32, Option<u32>)> {
    if matches!(input, DocFormat::Pdf | DocFormat::Text) && !cfg!(feature = "raster") {
        return Err(Error::Unsupported(convert::source::NO_RASTER.into()));
    }
    a.emit(PrintEvent::Converting);
    a.emit(PrintEvent::Submitting { route: RouteKind::Os });
    let caps = &a.printer.capabilities;
    let (color, copies_max) = (caps.color, caps.copies_max);
    let (printer, doc_name, path) = (name.to_string(), a.doc.name.clone(), a.doc.path.clone());
    let (state_dir, options, cancel) = (a.engine.opts.state_dir.clone(), a.options.clone(), a.cancel.clone());
    let (job, pages) = convert::blocking(move || {
        gdi::print(&gdi::GdiJob {
            printer: &printer,
            doc_name: &doc_name,
            input,
            path: &path,
            state_dir: &state_dir,
            options: &options,
            color,
            copies_max,
            cancel: &cancel,
        })
    })
    .await?;
    Ok((job, Some(pages)))
}

fn waiting(job: &spool::JobState) -> Option<String> {
    let s = job.status;
    if s & JOB_STATUS_PAPEROUT != 0 {
        Some("The printer is out of paper.".into())
    } else if s & JOB_STATUS_OFFLINE != 0 {
        Some("The printer is offline.".into())
    } else if s & (JOB_STATUS_ERROR | JOB_STATUS_USER_INTERVENTION | JOB_STATUS_BLOCKED_DEVQ) != 0 {
        Some(job.message.clone().unwrap_or_else(|| "The printer needs attention.".into()))
    } else if s & JOB_STATUS_PAUSED != 0 {
        Some("The job is paused in the Windows print queue.".into())
    } else if s & JOB_STATUS_PRINTING != 0 {
        None
    } else {
        Some("Waiting in the Windows print queue.".into())
    }
}

async fn state(name: &str, job: u32) -> Result<spool::JobState> {
    let name = name.to_string();
    convert::blocking(move || spool::job_state(&name, job)).await
}

async fn follow(a: &Attempt<'_>, name: &str, job: u32, pages: Option<u32>) -> Result<PrintOutcome> {
    let done = |printed: u32| Ok(PrintOutcome { route: RouteKind::Os, pages: pages.or((printed > 0).then_some(printed)) });
    let started = Instant::now();
    let (mut delay, mut errors, mut printed) = (FIRST_POLL, 0, 0);
    let mut last: Option<PrintEvent> = None;
    loop {
        tokio::select! {
            _ = a.cancel.canceled() => {
                let (n, j) = (name.to_string(), job);
                let _ = convert::blocking(move || {
                    spool::cancel_job(&n, j);
                    Ok(())
                })
                .await;
                return match state(name, job).await {
                    Ok(s) if s.status & (JOB_STATUS_PRINTED | JOB_STATUS_COMPLETE) != 0 => done(printed),
                    _ => Err(Error::Canceled),
                };
            }
            _ = tokio::time::sleep(delay) => {}
        }
        delay = (delay * 2).min(MAX_POLL);
        let Ok(s) = state(name, job).await else {
            errors += 1;
            if errors >= GONE_AFTER {
                return done(printed);
            }
            continue;
        };
        errors = 0;
        printed = printed.max(s.pages_printed);
        if s.gone || s.status & (JOB_STATUS_PRINTED | JOB_STATUS_COMPLETE) != 0 {
            return done(printed);
        }
        if s.status & (JOB_STATUS_DELETING | JOB_STATUS_DELETED) != 0 {
            return Err(Error::Canceled);
        }
        let event = match waiting(&s) {
            Some(message) => PrintEvent::Waiting { message },
            None => PrintEvent::Printing { pages_done: (printed > 0).then_some(printed) },
        };
        if last.as_ref() != Some(&event) {
            a.emit(event.clone());
            last = Some(event);
        }
        if started.elapsed() > FOLLOW_LIMIT {
            return done(printed);
        }
    }
}
