//! `ipp://` and `ipps://` URIs (RFC 3510/7472): the HTTP target behind a printer URI.

use crate::error::{Error, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub tls: bool,
    /// Host name or IP literal, without IPv6 brackets.
    pub host: String,
    pub port: u16,
    /// Absolute path (with query), e.g. "/ipp/print".
    pub path: String,
}

impl Target {
    pub fn parse(uri: &str) -> Result<Target> {
        let bad = || Error::Unsupported(format!("not an IPP printer URI: {uri}"));
        let (scheme, rest) = uri.trim().split_once("://").ok_or_else(bad)?;
        let (tls, default_port) = match scheme.to_ascii_lowercase().as_str() {
            "ipp" => (false, 631),
            "ipps" => (true, 631),
            "http" => (false, 80),
            "https" => (true, 443),
            _ => return Err(bad()),
        };
        let (authority, path) = match rest.find(['/', '?', '#']) {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        let path = path.split('#').next().unwrap_or("/");
        let path = if path.starts_with('/') { path.to_string() } else { format!("/{path}") };
        let authority = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
        let (host, port) = match authority.strip_prefix('[') {
            Some(v6) => {
                let (host, after) = v6.split_once(']').ok_or_else(bad)?;
                (host, after.strip_prefix(':'))
            }
            None => match authority.rsplit_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (authority, None),
            },
        };
        let port = match port {
            Some(p) if !p.is_empty() => p.parse::<u16>().map_err(|_| bad())?,
            _ => default_port,
        };
        let host = host.trim_end_matches('.');
        if host.is_empty() || port == 0 {
            return Err(bad());
        }
        Ok(Target { tls, host: host.to_string(), port, path })
    }

    /// `host:port` for Host headers and pin keys, IPv6 literals in brackets.
    pub fn authority(&self) -> String {
        if self.host.contains(':') { format!("[{}]:{}", self.host, self.port) } else { format!("{}:{}", self.host, self.port) }
    }

    /// The printer-uri operation attribute for this target.
    pub fn printer_uri(&self) -> String {
        format!("{}://{}{}", if self.tls { "ipps" } else { "ipp" }, self.authority(), self.path)
    }

    /// Plain IPP to the local CUPS scheduler, which may only be listening on its domain socket.
    #[cfg(unix)]
    pub fn is_local_cups(&self) -> bool {
        !self.tls && self.port == 631 && matches!(self.host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1")
    }
}
