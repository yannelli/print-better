//! The print path: try routes in order, check the printer is ready, convert, submit, follow.

use super::expect::{Expected, two_sided};
use super::follow::{follow, timed};
use super::{CancelFlag, Engine, PrintEvent, PrintOutcome, reasons, status};
use crate::backends::{Events, Payload, lpd, pjl, socket};
use crate::convert::{self, Channel, Plan, Prepared, Target};
use crate::error::{Error, Result};
use crate::ipp::{IppBody, IppJob, PrinterAttrs};
use crate::model::{DocFormat, Document, JobOptions, PrinterReport, Route, RouteKind};

/// One conversion kept across routes, so falling back to a route with the same needs is free.
pub(crate) type Converted = Option<(Plan, Channel, Prepared)>;

pub(crate) struct Attempt<'a> {
    pub engine: &'a Engine,
    pub printer: &'a PrinterReport,
    pub route: &'a Route,
    pub doc: &'a Document,
    pub input: DocFormat,
    pub options: &'a JobOptions,
    pub cancel: &'a CancelFlag,
    pub on_event: Events<'a>,
}

pub(crate) async fn print(
    engine: &Engine,
    printer: &PrinterReport,
    doc: &Document,
    options: &JobOptions,
    cancel: &CancelFlag,
    on_event: Events<'_>,
) -> Result<PrintOutcome> {
    if cancel.is_canceled() {
        return Err(Error::Canceled);
    }
    let input = convert::detect(doc)?;
    let mut converted: Converted = None;
    let (mut unreachable, mut unsupported) = (None, None);
    for route in &printer.routes {
        if cancel.is_canceled() {
            return Err(Error::Canceled);
        }
        let attempt = Attempt { engine, printer, route, doc, input, options, cancel, on_event };
        match attempt.run(&mut converted).await {
            Err(e @ Error::Unreachable(_)) => {
                log::info!("print via {}: {e}; trying the next route", route.uri);
                unreachable = Some(e);
            }
            Err(e @ Error::Unsupported(_)) => {
                log::info!("print via {}: {e}; trying the next route", route.uri);
                unsupported.get_or_insert(e);
            }
            other => return other,
        }
    }
    Err(unreachable
        .or(unsupported)
        .unwrap_or_else(|| Error::Unreachable("This printer has no connection Print Better can use.".into())))
}

impl Attempt<'_> {
    async fn run(&self, converted: &mut Converted) -> Result<PrintOutcome> {
        match self.route.kind {
            RouteKind::Ipp | RouteKind::Ipps => self.ipp(&self.route.uri, false, converted).await,
            RouteKind::Socket | RouteKind::Lpd | RouteKind::Usb => self.raw(converted).await,
            #[cfg(not(windows))]
            RouteKind::Os => self.ipp(&crate::backends::os::cups_uri(&self.route.uri)?, true, converted).await,
            #[cfg(windows)]
            RouteKind::Os => super::spooler::print(self, converted).await,
        }
    }

    pub(crate) fn emit(&self, event: PrintEvent) {
        (self.on_event)(event);
    }

    /// Plans for `target`, converting unless the last conversion already fits.
    pub(crate) async fn prepare<'c>(&self, target: &Target, converted: &'c mut Converted) -> Result<&'c Prepared> {
        let plan = convert::plan(self.input, target, self.options)?;
        let reusable = matches!(converted, Some((p, c, _)) if *p == plan && *c == target.channel);
        if !reusable {
            *converted = None;
            if !matches!(plan, Plan::Original(_)) {
                self.emit(PrintEvent::Converting);
            }
            let state_dir = &self.engine.opts.state_dir;
            let prepared = convert::prepare(self.doc, &plan, target, self.options, state_dir, self.cancel).await?;
            *converted = Some((plan, target.channel, prepared));
        }
        converted.as_ref().map(|(_, _, p)| p).ok_or_else(|| Error::Protocol("conversion missing".into()))
    }

    async fn ipp(&self, uri: &str, cups: bool, converted: &mut Converted) -> Result<PrintOutcome> {
        let ipp = &self.engine.ipp;
        let attrs = timed(ipp.get_printer_attributes(uri)).await?;
        if let Some(why) = reasons::blocking(&attrs.status) {
            return Err(Error::NotReady(why));
        }
        let mut target = Target::ipp(&attrs, cups);
        let pjl_sides = !cups && convert::pjl_sides(&attrs, self.options);
        if pjl_sides {
            // Copies and pages are made here, so a PJL-wrapped file is the whole job.
            target.copies_max = 1;
            target.page_ranges = false;
        }
        let prepared = self.prepare(&target, converted).await?;
        // A CUPS queue counts pages from its own filters, which often don't match the paper.
        let expected = if cups { None } else { count_expected(prepared, &attrs).await };
        let wrapper = if pjl_sides { pjl::wrap(prepared.format, &self.doc.name, &prepared.options) } else { None };
        let (format, body) = match wrapper {
            Some((head, tail)) => {
                let file = tokio::fs::read(&prepared.path).await?;
                ("application/octet-stream".to_string(), IppBody::Bytes([head, file, tail].concat()))
            }
            None => (prepared.format.mime().to_string(), IppBody::File(prepared.path.clone())),
        };
        let job = IppJob { name: self.doc.name.clone(), user: self.engine.opts.requesting_user.clone(), format, options: prepared.options.clone() };
        self.emit(PrintEvent::Submitting { route: self.route.kind });
        let id = tokio::select! {
            r = ipp.print_job(uri, &job, body) => r?,
            _ = self.cancel.canceled() => return Err(Error::Canceled),
        };
        self.emit(PrintEvent::Printing { pages_done: None });
        follow(ipp, uri, id, self.route.kind, expected, self.cancel, self.on_event).await
    }

    async fn raw(&self, converted: &mut Converted) -> Result<PrintOutcome> {
        if let Some(why) = status::raw_status(self.route).await?.as_ref().and_then(reasons::blocking) {
            return Err(Error::NotReady(why));
        }
        let target = Target::raw(&self.printer.capabilities);
        let prepared = self.prepare(&target, converted).await?;
        let wrapper = if target.pjl { pjl::wrap(prepared.format, &self.doc.name, self.options) } else { None };
        let (prefix, suffix) = wrapper.unwrap_or_default();
        let payload = Payload { prefix, path: prepared.path.clone(), suffix, repeat: prepared.repeat };
        self.emit(PrintEvent::Submitting { route: self.route.kind });
        let uri = &self.route.uri;
        match self.route.kind {
            RouteKind::Lpd => {
                let user = &self.engine.opts.requesting_user;
                lpd::send(uri, &payload, &self.doc.name, user, self.cancel, self.on_event).await?
            }
            RouteKind::Usb => usb_send(uri, &payload, self.cancel, self.on_event).await?,
            _ => socket::send(uri, &payload, self.cancel, self.on_event).await?,
        }
        Ok(PrintOutcome { route: self.route.kind, pages: prepared.pages, warning: None })
    }
}

async fn count_expected(prepared: &Prepared, printer: &PrinterAttrs) -> Option<Expected> {
    let pages = convert::payload_pages(prepared).await?;
    Expected::new(pages, &prepared.options, two_sided(prepared.options.sides, printer))
}

#[cfg(not(windows))]
async fn usb_send(uri: &str, payload: &Payload, cancel: &CancelFlag, on_event: Events<'_>) -> Result<()> {
    crate::backends::usb_io::send(uri, payload, cancel, on_event).await
}

#[cfg(windows)]
async fn usb_send(_uri: &str, _payload: &Payload, _cancel: &CancelFlag, _on_event: Events<'_>) -> Result<()> {
    Err(Error::Unreachable("USB printers are used through the Windows print queue on this computer.".into()))
}
