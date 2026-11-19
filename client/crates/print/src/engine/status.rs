//! Printer status, Identify-Printer, and per-route connectivity probes.

use super::Engine;
use super::follow::timed;
use crate::backends::{endpoint, socket};
use crate::error::{Error, Result};
use crate::model::{PrinterReport, PrinterState, PrinterStatus, Route, RouteKind};
use std::time::Duration;

const SNMP_TIMEOUT: Duration = Duration::from_secs(6);

/// IPP address for routes spoken to over IPP: printers directly, CUPS queues locally.
pub(crate) fn ipp_uri(route: &Route) -> Option<Result<String>> {
    match route.kind {
        RouteKind::Ipp | RouteKind::Ipps => Some(Ok(route.uri.clone())),
        #[cfg(not(windows))]
        RouteKind::Os => Some(crate::backends::os::cups_uri(&route.uri)),
        _ => None,
    }
}

/// Status over a socket, LPD, or USB route; Ok(None) when reachable but silent about its state.
pub(crate) async fn raw_status(route: &Route) -> Result<Option<PrinterStatus>> {
    match route.kind {
        RouteKind::Usb => usb_status(&route.uri).await.map(Some),
        _ => {
            let ep = endpoint(&route.uri, if route.kind == RouteKind::Lpd { 515 } else { 9100 })?;
            let snmp = tokio::time::timeout(SNMP_TIMEOUT, crate::discovery::snmp_status(&ep.host)).await;
            Ok(snmp.ok().flatten())
        }
    }
}

#[cfg(not(windows))]
async fn usb_status(uri: &str) -> Result<PrinterStatus> {
    crate::backends::usb_io::status(uri).await
}

#[cfg(windows)]
async fn usb_status(_uri: &str) -> Result<PrinterStatus> {
    Err(Error::Unreachable("USB printers are used through the Windows print queue on this computer.".into()))
}

async fn route_status(engine: &Engine, route: &Route) -> Result<Option<PrinterStatus>> {
    if let Some(uri) = ipp_uri(route) {
        return timed(engine.ipp.get_printer_attributes(&uri?)).await.map(|a| Some(a.status));
    }
    match route.kind {
        #[cfg(windows)]
        RouteKind::Os => super::spooler::status(route).await.map(Some),
        RouteKind::Socket | RouteKind::Lpd => {
            if let Some(status) = raw_status(route).await? {
                return Ok(Some(status));
            }
            probe_route(route).await.map(|_| None)
        }
        _ => raw_status(route).await,
    }
}

pub(crate) async fn status(engine: &Engine, printer: &PrinterReport) -> Result<PrinterStatus> {
    if printer.routes.is_empty() {
        return Err(Error::Unsupported("This printer has no connection Print Better can use.".into()));
    }
    let mut reachable = false;
    for route in &printer.routes {
        match route_status(engine, route).await {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => reachable = true,
            Err(e) => log::debug!("status via {}: {e}", route.uri),
        }
    }
    if reachable {
        return Ok(PrinterStatus { state: PrinterState::Unknown, ..PrinterStatus::default() });
    }
    Ok(PrinterStatus { state: PrinterState::Offline, message: Some("Can't reach the printer.".into()), ..PrinterStatus::default() })
}

pub(crate) async fn identify(engine: &Engine, printer: &PrinterReport) -> Result<()> {
    let mut last = None;
    for route in printer.routes.iter().filter(|r| matches!(r.kind, RouteKind::Ipp | RouteKind::Ipps)) {
        match timed(engine.ipp.get_printer_attributes(&route.uri)).await {
            Ok(attrs) if attrs.identify_supported => return timed(engine.ipp.identify(&route.uri)).await,
            Ok(_) => return Err(Error::Unsupported("This printer can't beep or flash to identify itself.".into())),
            Err(e @ Error::Unreachable(_)) => last = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| Error::Unsupported("Only network printers that support IPP can identify themselves.".into())))
}

async fn probe_route(route: &Route) -> Result<()> {
    match route.kind {
        RouteKind::Socket => socket::probe(&route.uri, 9100).await,
        RouteKind::Lpd => socket::probe(&route.uri, 515).await,
        RouteKind::Usb => usb_status(&route.uri).await.map(drop),
        _ => Ok(()),
    }
}

pub(crate) async fn probe(engine: &Engine, printer: &PrinterReport) -> Vec<(Route, std::result::Result<(), String>)> {
    let mut out = Vec::with_capacity(printer.routes.len());
    for route in &printer.routes {
        let result = match ipp_uri(route) {
            Some(uri) => match uri {
                Ok(uri) => timed(engine.ipp.get_printer_attributes(&uri)).await.map(drop),
                Err(e) => Err(e),
            },
            #[cfg(windows)]
            None if route.kind == RouteKind::Os => super::spooler::status(route).await.map(drop),
            None => probe_route(route).await,
        };
        out.push((route.clone(), result.map_err(|e| message(&e))));
    }
    out
}

/// The sentence inside an error, without the category prefix `Display` adds.
pub(crate) fn message(e: &Error) -> String {
    match e {
        Error::Unreachable(m) | Error::NotReady(m) | Error::Unsupported(m) | Error::Rejected(m) | Error::Protocol(m) => m.clone(),
        Error::Canceled => "Canceled.".into(),
        Error::Io(e) => format!("Couldn't read or write a file: {e}."),
    }
}
