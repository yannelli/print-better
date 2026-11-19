//! IPP status codes -> the crate's error taxonomy, which drives the engine's retry and failover.

use super::tags::{self, status};
use super::uri::Target;
use super::value::Message;
use crate::error::{Error, Result};

pub fn check(target: &Target, resp: Message) -> Result<Message> {
    if tags::is_success(resp.code) {
        return Ok(resp);
    }
    let what = format!("{}: {}", target.authority(), status_text(&resp));
    Err(match resp.code {
        status::DOCUMENT_FORMAT_NOT_SUPPORTED
        | status::ATTRIBUTES_NOT_SUPPORTED
        | status::CONFLICTING_ATTRIBUTES
        | status::DOCUMENT_FORMAT_ERROR
        | status::OPERATION_NOT_SUPPORTED
        | status::VERSION_NOT_SUPPORTED
        | status::MULTIPLE_DOCUMENTS_NOT_SUPPORTED => Error::Unsupported(what),
        status::NOT_ACCEPTING_JOBS
        | status::BUSY
        | status::SERVICE_UNAVAILABLE
        | status::TEMPORARY_ERROR
        | status::DEVICE_ERROR
        | status::CLIENT_TIMEOUT => Error::NotReady(what),
        status::JOB_CANCELED => Error::Canceled,
        0x0400..=0x04FF => Error::Rejected(what),
        _ => Error::Protocol(what),
    })
}

pub fn status_text(resp: &Message) -> String {
    let name = match resp.code {
        status::BAD_REQUEST => "bad request",
        status::FORBIDDEN => "forbidden",
        status::NOT_AUTHENTICATED => "authentication required",
        status::NOT_AUTHORIZED => "not authorized",
        status::NOT_POSSIBLE => "not possible",
        status::CLIENT_TIMEOUT => "timed out waiting for data",
        status::NOT_FOUND => "not found",
        status::GONE => "gone",
        status::TOO_LARGE => "document too large",
        status::DOCUMENT_FORMAT_NOT_SUPPORTED => "document format not supported",
        status::ATTRIBUTES_NOT_SUPPORTED => "job options not supported",
        status::CONFLICTING_ATTRIBUTES => "conflicting job options",
        status::DOCUMENT_FORMAT_ERROR => "document format error",
        status::INTERNAL_ERROR => "internal printer error",
        status::OPERATION_NOT_SUPPORTED => "operation not supported",
        status::SERVICE_UNAVAILABLE => "service unavailable",
        status::VERSION_NOT_SUPPORTED => "IPP version not supported",
        status::DEVICE_ERROR => "device error",
        status::TEMPORARY_ERROR => "temporary error",
        status::NOT_ACCEPTING_JOBS => "not accepting jobs",
        status::BUSY => "busy",
        status::JOB_CANCELED => "job canceled",
        _ => "error",
    };
    match resp.status_message() {
        Some(m) if !m.trim().is_empty() => format!("{name} (0x{:04x}): {}", resp.code, m.trim()),
        _ => format!("{name} (0x{:04x})", resp.code),
    }
}
