//! Asks discovered printers about themselves: IPP attributes for IPP routes, an IPP probe plus
//! SNMP status for socket/LPD-only printers. Bounded per printer, in concurrency, and overall.

use super::found::{Found, better, uri_host};
use super::snmp;
use crate::ipp::{IppClient, PrinterAttrs};
use crate::model::{PrinterStatus, RouteKind};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

const PER_QUERY: Duration = Duration::from_secs(4);
const OVERALL: Duration = Duration::from_secs(8);
const CONCURRENCY: usize = 8;

#[derive(Default)]
struct Answer {
    attrs: Option<Box<PrinterAttrs>>,
    /// An ipp:// route that answered a probe rather than coming from discovery.
    probed: Option<String>,
    snmp: Option<PrinterStatus>,
    /// ipps:// routes whose TLS handshake the printer refuses.
    tls_refused: Vec<String>,
}

pub(crate) async fn printers(ipp: &IppClient, found: &mut [Found]) {
    let gate = Arc::new(Semaphore::new(CONCURRENCY));
    let mut tasks = JoinSet::new();
    for (i, f) in found.iter().enumerate() {
        let uris = |kind: RouteKind| -> Vec<String> { f.routes.iter().filter(|r| r.kind == kind).map(|r| r.uri.clone()).collect() };
        let (plain, secure) = (uris(RouteKind::Ipp), uris(RouteKind::Ipps));
        let raw_host = f.routes.iter().find(|r| matches!(r.kind, RouteKind::Socket | RouteKind::Lpd)).and_then(|r| uri_host(&r.uri));
        if plain.is_empty() && secure.is_empty() && raw_host.is_none() {
            continue;
        }
        let (ipp, gate) = (ipp.clone(), gate.clone());
        tasks.spawn(async move {
            let _permit = gate.acquire_owned().await.ok()?;
            Some((i, ask(&ipp, plain, secure, raw_host).await))
        });
    }
    let collect = async {
        while let Some(done) = tasks.join_next().await {
            if let Ok(Some((i, answer))) = done
                && let Some(f) = found.get_mut(i)
            {
                apply(f, answer);
            }
        }
    };
    if tokio::time::timeout(OVERALL, collect).await.is_err() {
        log::warn!("discovery: some printers did not answer within {}s", OVERALL.as_secs());
    }
}

async fn ask(ipp: &IppClient, plain: Vec<String>, secure: Vec<String>, raw_host: Option<String>) -> Answer {
    let mut answer = Answer::default();
    let probe = raw_host.as_ref().filter(|_| plain.is_empty() && secure.is_empty()).map(|h| format!("ipp://{}:631/ipp/print", bracket(h)));
    let mut answered_by = None;
    for uri in plain.iter().chain(&secure).chain(&probe) {
        match tokio::time::timeout(PER_QUERY, ipp.get_printer_attributes(uri)).await {
            Ok(Ok(attrs)) => {
                answer.attrs = Some(Box::new(attrs));
                answered_by = Some(uri.clone());
                break;
            }
            Ok(Err(e)) => log::debug!("discovery: {uri}: {e}"),
            Err(_) => log::debug!("discovery: {uri}: no answer within {}s", PER_QUERY.as_secs()),
        }
    }
    answer.probed = answered_by.clone().filter(|uri| probe.as_ref() == Some(uri));
    for uri in secure.iter().filter(|uri| answered_by.as_ref() != Some(uri)) {
        if let Ok(Some(false)) = tokio::time::timeout(PER_QUERY, ipp.tls_works(uri)).await {
            log::info!("discovery: {uri} refuses our TLS handshake; leaving that route out");
            answer.tls_refused.push(uri.clone());
        }
    }
    if answer.attrs.is_none()
        && let Some(host) = raw_host
    {
        answer.snmp = snmp::status(&host).await;
    }
    answer
}

fn apply(f: &mut Found, answer: Answer) {
    f.routes.retain(|r| !answer.tls_refused.contains(&r.uri));
    if let Some(uri) = answer.probed {
        f.add_route(RouteKind::Ipp, uri);
    }
    if let Some(attrs) = answer.attrs.map(|a| *a) {
        f.uuid = attrs.uuid.or(f.uuid.take());
        f.name = better(f.name.take(), attrs.name.map(|n| (2, n)));
        f.make_model = better(f.make_model.take(), attrs.make_model.map(|m| (3, m)));
        f.location = f.location.take().or(attrs.location);
        f.capabilities = better(f.capabilities.take(), Some((4, attrs.capabilities)));
        f.status = better(f.status.take(), Some((4, attrs.status)));
    }
    f.status = better(f.status.take(), answer.snmp.map(|s| (1, s)));
}

fn bracket(host: &str) -> String {
    if host.contains(':') { format!("[{host}]") } else { host.to_string() }
}
