/// A server origin. Plain `http://` is accepted only for loopback (local development).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerUrl {
    pub tls: bool,
    /// Lowercase host; IPv6 literals keep their brackets.
    pub host: String,
    pub port: u16,
}

impl ServerUrl {
    pub fn parse(input: &str) -> Result<ServerUrl, String> {
        let input = input.trim();
        let lower = input.to_ascii_lowercase();
        let (tls, rest) = if lower.starts_with("https://") {
            (true, &input[8..])
        } else if lower.starts_with("http://") {
            (false, &input[7..])
        } else if input.contains("://") {
            return Err("The server address must start with https://".into());
        } else {
            (true, input)
        };
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        if authority.contains('@') {
            return Err("The server address must not contain a user name.".into());
        }
        let (host, port) = split_host_port(authority)?;
        if host.is_empty() {
            return Err("The server address is missing a host name.".into());
        }
        let url = ServerUrl { tls, host: host.to_ascii_lowercase(), port: port.unwrap_or(if tls { 443 } else { 80 }) };
        if !tls && !url.is_loopback() {
            return Err("Use https:// (plain http:// only works for localhost).".into());
        }
        Ok(url)
    }

    pub fn is_loopback(&self) -> bool {
        self.host == "localhost" || self.host == "[::1]" || self.host.starts_with("127.")
    }

    /// `host[:port]`, omitting the scheme's default port (used for the Host header).
    pub fn authority(&self) -> String {
        let default_port = if self.tls { 443 } else { 80 };
        if self.port == default_port { self.host.clone() } else { format!("{}:{}", self.host, self.port) }
    }

    pub fn origin(&self) -> String {
        format!("{}://{}", if self.tls { "https" } else { "http" }, self.authority())
    }

    pub fn websocket(&self, path: &str) -> String {
        format!("{}://{}{path}", if self.tls { "wss" } else { "ws" }, self.authority())
    }

    /// Host without IPv6 brackets, for DNS lookup and TLS server names.
    pub fn dial_host(&self) -> &str {
        self.host.trim_start_matches('[').trim_end_matches(']')
    }
}

fn split_host_port(authority: &str) -> Result<(&str, Option<u16>), String> {
    let (host, port) = match authority.strip_prefix('[') {
        Some(rest) => {
            let end = rest.find(']').ok_or("The IPv6 address is missing its closing bracket.")?;
            (&authority[..end + 2], authority[end + 2..].strip_prefix(':'))
        }
        None => match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        },
    };
    let port = port
        .map(|p| p.parse::<u16>().map_err(|_| format!("\"{p}\" is not a valid port number.")))
        .transpose()?;
    Ok((host, port))
}

#[cfg(test)]
mod tests {
    use super::ServerUrl;

    fn ok(input: &str) -> ServerUrl {
        ServerUrl::parse(input).unwrap()
    }

    fn err(input: &str) -> String {
        ServerUrl::parse(input).unwrap_err()
    }

    #[test]
    fn https_and_bare_hosts_default_to_tls_on_443() {
        for input in ["https://print.example.com", "print.example.com", "  https://print.example.com/  "] {
            let url = ok(input);
            assert_eq!((url.tls, url.host.as_str(), url.port), (true, "print.example.com", 443));
            assert_eq!(url.origin(), "https://print.example.com");
            assert_eq!(url.websocket("/api/client/ws"), "wss://print.example.com/api/client/ws");
        }
    }

    #[test]
    fn host_is_lowercased_and_path_query_fragment_dropped() {
        let url = ok("HTTPS://Print.Example.COM:8443/some/path?x=1#frag");
        assert_eq!((url.host.as_str(), url.port), ("print.example.com", 8443));
        assert_eq!(url.authority(), "print.example.com:8443");
        assert_eq!(url.origin(), "https://print.example.com:8443");
    }

    #[test]
    fn plain_http_only_for_loopback() {
        assert_eq!(ok("http://localhost:8787").websocket("/ws"), "ws://localhost:8787/ws");
        assert_eq!(ok("http://127.0.0.1:8787").origin(), "http://127.0.0.1:8787");
        let v6 = ok("http://[::1]:8787");
        assert_eq!((v6.host.as_str(), v6.dial_host()), ("[::1]", "::1"));
        assert!(ok("http://127.0.0.2").is_loopback());
        assert!(err("http://print.example.com").contains("https://"));
        assert!(err("http://192.168.1.10:8787").contains("https://"));
    }

    #[test]
    fn malformed_addresses_are_rejected() {
        assert!(err("ftp://print.example.com").contains("https://"));
        assert!(err("https://user@print.example.com").contains("user name"));
        assert!(err("https://").contains("host"));
        assert!(err("https://print.example.com:99999").contains("port"));
        assert!(err("https://print.example.com:abc").contains("port"));
        assert!(err("https://[::1").contains("bracket"));
    }
}
