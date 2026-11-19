//! Blocking client for the local API, used by the CLI and the tray (no async runtime needed).

use serde_json::Value;
use std::fmt;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Discovery and diagnostics can take a while; the daemon answers everything else at once.
const READ_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug)]
pub enum LocalError {
    NotRunning,
    Api { status: u16, message: String },
    Io(String),
}

impl fmt::Display for LocalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LocalError::NotRunning => f.write_str("Print Better is not running."),
            LocalError::Api { message, .. } => f.write_str(message),
            LocalError::Io(message) => write!(f, "Could not talk to Print Better: {message}"),
        }
    }
}

pub fn get(path: &str) -> Result<Value, LocalError> {
    request("GET", path, "application/json", &[])
}

pub fn post(path: &str, body: &Value) -> Result<Value, LocalError> {
    request("POST", path, "application/json", body.to_string().as_bytes())
}

pub fn post_bytes(path: &str, body: &[u8]) -> Result<Value, LocalError> {
    request("POST", path, "application/octet-stream", body)
}

pub fn is_running() -> bool {
    get("/api/status").is_ok()
}

fn request(method: &str, path: &str, content_type: &str, body: &[u8]) -> Result<Value, LocalError> {
    let port = super::port();
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|_| LocalError::NotRunning)?;
    let io = |e: std::io::Error| LocalError::Io(e.to_string());
    stream.set_read_timeout(Some(READ_TIMEOUT)).map_err(io)?;
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: {content_type}\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).map_err(io)?;
    stream.write_all(body).map_err(io)?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(io)?;

    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| LocalError::Io("malformed reply".into()))?;
    let status_line = String::from_utf8_lossy(&raw[..split]);
    let status: u16 = status_line
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| LocalError::Io("malformed status line".into()))?;
    // The daemon always sends a Content-Length body and closes, so the rest is the body.
    let value: Value = serde_json::from_slice(&raw[split + 4..]).map_err(|e| LocalError::Io(e.to_string()))?;
    if (200..300).contains(&status) {
        return Ok(value);
    }
    let message = value["error"]["message"].as_str().unwrap_or("The request failed.").to_string();
    Err(LocalError::Api { status, message })
}
