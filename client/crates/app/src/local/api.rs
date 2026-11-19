//! Request gatekeeping (DNS rebinding, cross-site writes) and routing.

use super::reply::{self, Reply};
use super::{actions, status};
use crate::daemon::{Daemon, diagnose};
use hyper::body::Incoming;
use hyper::{Method, Request, StatusCode, header};
use serde_json::json;
use std::sync::Arc;

const PAGE: &str = include_str!("page/index.html");
const CSS: &str = include_str!("page/app.css");
const JS: &str = include_str!("page/app.js");
const ACTIONS_JS: &str = include_str!("page/actions.js");
const LOOPBACK_NAMES: [&str; 2] = ["127.0.0.1", "localhost"];
const JOBS: &str = "/api/jobs/";

pub async fn handle(d: Arc<Daemon>, req: Request<Incoming>, port: u16) -> Reply {
    if !host_allowed(&req, port) {
        let message = format!("Open the status page at http://127.0.0.1:{port}");
        reply::discard(req, reply::MAX_JSON).await;
        return reply::error(StatusCode::MISDIRECTED_REQUEST, "bad_host", &message);
    }
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    if method != Method::GET && method != Method::HEAD {
        if !origin_allowed(&req, port) {
            reply::discard(req, reply::MAX_JSON).await;
            return reply::error(StatusCode::FORBIDDEN, "bad_origin", "Requests from other websites are not allowed.");
        }
        // Both types force a CORS preflight, which this server never grants.
        let wanted = if path == "/api/print" { "application/octet-stream" } else { "application/json" };
        if !content_type_is(&req, wanted) {
            reply::discard(req, reply::MAX_JSON).await;
            return reply::error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "bad_content_type", &format!("Send {wanted}."));
        }
    }
    let query = req.uri().query().unwrap_or_default().to_string();
    let ok = || reply::json(StatusCode::OK, &json!({}));
    match (method, path.as_str()) {
        (Method::GET, "/" | "/pair") => reply::asset("text/html; charset=utf-8", PAGE),
        (Method::GET, "/app.css") => reply::asset("text/css; charset=utf-8", CSS),
        (Method::GET, "/app.js") => reply::asset("text/javascript; charset=utf-8", JS),
        (Method::GET, "/actions.js") => reply::asset("text/javascript; charset=utf-8", ACTIONS_JS),
        (Method::GET, "/api/status") => reply::json(StatusCode::OK, &status::build(&d)),
        (Method::GET, "/api/printers") => reply::json(StatusCode::OK, &json!({ "printers": status::printers(&d) })),
        (Method::GET, "/api/settings") => reply::json(StatusCode::OK, &d.settings()),
        (Method::POST, "/api/settings") => actions::settings(&d, req).await,
        (Method::POST, "/api/pair") => actions::pair(&d, req).await,
        (Method::POST, "/api/pair/cancel") => {
            reply::discard(req, reply::MAX_JSON).await;
            d.cancel_pairing();
            ok()
        }
        (Method::POST, "/api/unpair") => {
            reply::discard(req, reply::MAX_JSON).await;
            actions::unpair(&d)
        }
        (Method::POST, "/api/discover") => actions::discover(&d, req).await,
        (Method::POST, "/api/update") => actions::update(&d, req).await,
        (Method::POST, "/api/print") => actions::print(&d, req, &query).await,
        (Method::GET, "/api/logs") => actions::logs(&d, &query),
        (Method::GET, "/api/doctor") => {
            reply::json(StatusCode::OK, &json!({ "checks": diagnose::for_daemon(&d).await }))
        }
        (Method::POST, "/api/quit") => {
            reply::discard(req, reply::MAX_JSON).await;
            d.stop(false, "quit from the local API");
            ok()
        }
        (Method::GET, p) if p.starts_with(JOBS) => actions::job(&d, &p[JOBS.len()..]),
        (Method::POST, p) if p.starts_with(JOBS) && p.ends_with("/cancel") => {
            reply::discard(req, reply::MAX_JSON).await;
            actions::cancel_job(&d, &p[JOBS.len()..p.len() - "/cancel".len()])
        }
        _ => {
            reply::discard(req, reply::MAX_JSON).await;
            reply::error(StatusCode::NOT_FOUND, "not_found", "Not found.")
        }
    }
}

/// Rejects DNS-rebinding requests: a foreign name resolving to 127.0.0.1 keeps its own Host.
fn host_allowed(req: &Request<Incoming>, port: u16) -> bool {
    let host = req.headers().get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or_default();
    LOOPBACK_NAMES.iter().any(|name| host.eq_ignore_ascii_case(&format!("{name}:{port}")))
}

fn origin_allowed(req: &Request<Incoming>, port: u16) -> bool {
    let Some(origin) = req.headers().get(header::ORIGIN) else { return true };
    let origin = origin.to_str().unwrap_or_default();
    LOOPBACK_NAMES.iter().any(|name| origin.eq_ignore_ascii_case(&format!("http://{name}:{port}")))
}

fn content_type_is(req: &Request<Incoming>, wanted: &str) -> bool {
    req.headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case(wanted))
}
