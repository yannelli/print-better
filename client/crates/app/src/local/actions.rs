//! Local API handlers that change things: settings, pairing, discovery, printing, jobs.

use super::reply::{self, Reply};
use super::status;
use crate::daemon::{self, Daemon};
use crate::net::ServerUrl;
use crate::queue::LocalJob;
use crate::queue::record::Source;
use crate::{choose, clock, doc, logger, pairing, query, settings};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::{Request, StatusCode};
use pb_print::DocFormat;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

const MAX_UPLOAD: u64 = 256 * 1024 * 1024;

pub async fn settings(d: &Daemon, req: Request<Incoming>) -> Reply {
    let patch: Value = match reply::read_json(req).await {
        Ok(patch) => patch,
        Err(reply) => return reply,
    };
    let next = match settings::apply(&d.settings(), &patch) {
        Ok(next) => next,
        Err(e) => return reply::error(StatusCode::BAD_REQUEST, "invalid_setting", &e),
    };
    match d.change_settings(next) {
        Ok(()) => reply::json(StatusCode::OK, &d.settings()),
        Err(e) => reply::error(StatusCode::INTERNAL_SERVER_ERROR, "save_failed", &e),
    }
}

#[derive(Deserialize)]
struct PairRequest {
    server: String,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

/// With a token: enroll now. Without: start the device-code flow and return the code.
pub async fn pair(d: &Arc<Daemon>, req: Request<Incoming>) -> Reply {
    let body: PairRequest = match reply::read_json(req).await {
        Ok(body) => body,
        Err(reply) => return reply,
    };
    if d.credentials().is_some() {
        let message = "This device is already paired. Unpair it first to pair again.";
        return reply::error(StatusCode::CONFLICT, "already_paired", message);
    }
    let server = match ServerUrl::parse(&body.server) {
        Ok(server) => server,
        Err(e) => return reply::error(StatusCode::BAD_REQUEST, "bad_server", &e),
    };
    if let Some(token) = body.token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        return match pairing::enroll(&server, token, body.name.as_deref()).await {
            Ok(creds) => {
                let name = creds.name.clone();
                match d.store_credentials(creds) {
                    Ok(()) => reply::json(StatusCode::OK, &json!({ "paired": true, "name": name })),
                    Err(e) => reply::error(StatusCode::INTERNAL_SERVER_ERROR, "save_failed", &e.to_string()),
                }
            }
            Err(e) => reply::error(StatusCode::BAD_GATEWAY, "pair_failed", &e),
        };
    }
    match pairing::request_code(&server, body.name.as_deref()).await {
        Ok(code) => {
            let body = json!({
                "paired": false,
                "userCode": code.user_code,
                "verificationUri": code.verification_uri,
                "verificationUriComplete": code.verification_uri_complete,
                "expiresIn": code.expires_in,
            });
            d.start_device_pairing(server, code);
            reply::json(StatusCode::OK, &body)
        }
        Err(e) => reply::error(StatusCode::BAD_GATEWAY, "pair_failed", &e),
    }
}

pub fn unpair(d: &Daemon) -> Reply {
    if d.credentials().is_none() {
        return reply::error(StatusCode::CONFLICT, "not_paired", "This device is not paired.");
    }
    d.forget_credentials();
    reply::json(StatusCode::OK, &json!({ "paired": false }))
}

#[derive(Deserialize, Default)]
struct DiscoverRequest {
    #[serde(default)]
    timeout: Option<u64>,
}

pub async fn discover(d: &Daemon, req: Request<Incoming>) -> Reply {
    let body: DiscoverRequest = match reply::read_json(req).await {
        Ok(body) => body,
        Err(reply) => return reply,
    };
    let wait = body.timeout.map(|secs| Duration::from_secs(secs.clamp(1, 60)));
    daemon::discover(d, false, wait).await;
    reply::json(StatusCode::OK, &json!({ "printers": d.named_printers() }))
}

#[derive(Deserialize, Default)]
struct UpdateRequest {
    #[serde(default)]
    install: bool,
}

/// Checks now; with `install`, starts installing a newer release. 409 when this process can't.
pub async fn update(d: &Daemon, req: Request<Incoming>) -> Reply {
    let body: UpdateRequest = match reply::read_json(req).await {
        Ok(body) => body,
        Err(reply) => return reply,
    };
    if !body.install {
        return match daemon::check_update(d).await {
            Ok(status) => reply::json(StatusCode::OK, &status),
            Err(e) => reply::error(StatusCode::BAD_GATEWAY, "check_failed", &e),
        };
    }
    if let Err(e) = daemon::can_install_update(d) {
        return reply::error(StatusCode::CONFLICT, "cannot_install", &e);
    }
    match daemon::request_update(d).await {
        Ok((from, to)) => reply::json(StatusCode::OK, &json!({ "from": from, "to": to })),
        Err(e) => reply::error(StatusCode::BAD_REQUEST, "update_failed", &e),
    }
}

/// Raw document body; options in the query (`printer`, `title`, `type`, `copies`, `media`, `sides`, `color`).
pub async fn print(d: &Daemon, req: Request<Incoming>, raw_query: &str) -> Reply {
    let params = query::parse(raw_query);
    let printers = d.named_printers();
    let checked = match choose::printer(&printers, &d.added_keys(), params.get("printer").map(String::as_str)) {
        Ok(printer) => query::job_options(&params).map(|options| (printer.clone(), options)).map_err(|e| ("bad_option", e)),
        Err(e) => Err(("choose_printer", e)),
    };
    let (printer, options) = match checked {
        Ok(checked) => checked,
        Err((code, e)) => {
            reply::discard(req, MAX_UPLOAD as usize).await;
            return reply::error(StatusCode::BAD_REQUEST, code, &e);
        }
    };
    let file = d.queue.spool.join(format!("upload-{}", clock::now_ms()));
    if let Err(reply) = save_body(req, &file).await {
        let _ = std::fs::remove_file(&file);
        return reply;
    }
    let format = doc::detect(&file, params.get("type").map(String::as_str));
    if format == DocFormat::Unknown {
        let _ = std::fs::remove_file(&file);
        let message = "Print Better can print PDF, JPEG, PNG, and plain text files.";
        return reply::error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_format", message);
    }
    let job = LocalJob {
        source: Source::Local,
        printer_key: printer.key.clone(),
        title: params.get("title").cloned().unwrap_or_else(|| "Document".into()),
        user: None,
        file,
        content_type: format.mime().into(),
        options,
    };
    let (id, _) = d.queue.add_local(job, d.server_time_ms());
    reply::json(StatusCode::OK, &json!({ "id": id, "printer": printer.name }))
}

async fn save_body(req: Request<Incoming>, path: &Path) -> Result<(), Reply> {
    let failed = |e: String| reply::error(StatusCode::BAD_REQUEST, "upload_failed", &e);
    let mut file = tokio::fs::File::create(path).await.map_err(|e| failed(e.to_string()))?;
    let mut body = req.into_body();
    let mut size = 0u64;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| failed(e.to_string()))?;
        if let Ok(data) = frame.into_data() {
            size += data.len() as u64;
            if size > MAX_UPLOAD {
                return Err(reply::error(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "The file is larger than 256 MB."));
            }
            file.write_all(&data).await.map_err(|e| failed(e.to_string()))?;
        }
    }
    file.flush().await.map_err(|e| failed(e.to_string()))
}

pub fn logs(d: &Daemon, raw_query: &str) -> Reply {
    let lines = query::parse(raw_query).get("lines").and_then(|n| n.parse::<usize>().ok()).unwrap_or(200).clamp(1, 2000);
    let file = d.paths.log_file();
    reply::json(StatusCode::OK, &json!({ "file": file, "lines": logger::tail(&file, lines) }))
}

pub fn job(d: &Daemon, id: &str) -> Reply {
    match d.queue.get(id) {
        Some(rec) => reply::json(StatusCode::OK, &status::job(d, &rec)),
        None => reply::error(StatusCode::NOT_FOUND, "not_found", "No such job."),
    }
}

pub fn cancel_job(d: &Daemon, id: &str) -> Reply {
    if d.queue.get(id).is_none() {
        return reply::error(StatusCode::NOT_FOUND, "not_found", "No such job.");
    }
    d.queue.cancel(id, d.server_time_ms());
    reply::json(StatusCode::OK, &json!({}))
}
