//! The local API over real HTTP on an ephemeral port: gatekeeping and the main routes.

use crate::daemon::Daemon;
use crate::store::{self, Credentials};
use crate::test_util::TempDir;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

struct Server {
    d: Arc<Daemon>,
    port: u16,
    thread: Option<JoinHandle<()>>,
    _dir: TempDir,
}

impl Server {
    fn start(dir: TempDir) -> Server {
        let d = Arc::new(Daemon::new(dir.paths(), false, false));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = d.clone();
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            tokio::task::LocalSet::new().block_on(&runtime, super::serve(served, listener));
        });
        Server { d, port, thread: Some(thread), _dir: dir }
    }

    fn host(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }

    /// One HTTP/1.1 exchange; `headers` are extra raw header lines.
    fn send(&self, method: &str, path: &str, host: &str, headers: &[&str], body: &[u8]) -> Response {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let extra: String = headers.iter().map(|h| format!("{h}\r\n")).collect();
        let head = format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(body).unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).unwrap();
        let (head, body) = raw.split_once("\r\n\r\n").unwrap();
        Response { status: head[9..12].parse().unwrap(), head: head.to_ascii_lowercase(), body: body.to_string() }
    }

    fn get(&self, path: &str) -> Response {
        self.send("GET", path, &self.host(), &[], b"")
    }

    fn post(&self, path: &str, body: &Value) -> Response {
        let origin = format!("Origin: http://{}", self.host());
        self.send("POST", path, &self.host(), &["Content-Type: application/json", &origin], body.to_string().as_bytes())
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.d.stopping.cancel();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct Response {
    status: u16,
    head: String,
    body: String,
}

impl Response {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|e| panic!("{e}: {}", self.body))
    }

    fn code(&self) -> String {
        self.json()["error"]["code"].as_str().unwrap_or_default().to_string()
    }
}

fn server() -> Server {
    Server::start(TempDir::new())
}

#[test]
fn foreign_hosts_are_refused() {
    let s = server();
    for host in ["evil.example:80".to_string(), format!("evil.example:{}", s.port), "127.0.0.1:47631".into(), String::new()] {
        let r = s.send("GET", "/api/status", &host, &[], b"");
        assert_eq!((r.status, r.code()), (421, "bad_host".to_string()), "Host {host:?}");
    }
    assert_eq!(s.send("GET", "/api/status", &format!("LOCALHOST:{}", s.port), &[], b"").status, 200);
}

#[test]
fn foreign_origins_and_simple_content_types_cannot_write() {
    let s = server();
    let body = br#"{"paused":true}"#;
    for origin in ["Origin: http://evil.example", "Origin: null", "Origin: https://127.0.0.1"] {
        let r = s.send("POST", "/api/settings", &s.host(), &[origin, "Content-Type: application/json"], body);
        assert_eq!((r.status, r.code()), (403, "bad_origin".to_string()), "{origin}");
    }
    for content_type in ["Content-Type: text/plain", "Content-Type: application/x-www-form-urlencoded"] {
        let r = s.send("POST", "/api/settings", &s.host(), &[content_type], body);
        assert_eq!((r.status, r.code()), (415, "bad_content_type".to_string()), "{content_type}");
    }
    let r = s.send("POST", "/api/quit", &s.host(), &["Origin: http://evil.example", "Content-Type: application/json"], b"{}");
    assert_eq!(r.status, 403);
    assert!(!s.d.settings().paused && !s.d.stopping.is_canceled());
    let json = ["Content-Type: application/json; charset=utf-8"];
    assert_eq!(s.send("POST", "/api/settings", &s.host(), &json, body).status, 200, "no Origin means a non-browser client");
    assert!(s.d.settings().paused);
}

#[test]
fn page_and_scripts_are_served_with_a_strict_policy() {
    let s = server();
    for path in ["/", "/pair"] {
        let r = s.get(path);
        assert_eq!(r.status, 200);
        assert!(r.head.contains("content-type: text/html") && r.body.contains("<title>Print Better</title>"));
        assert!(r.head.contains("content-security-policy: default-src 'self'") && r.head.contains("x-frame-options: deny"));
    }
    for (path, kind) in [("/app.js", "text/javascript"), ("/actions.js", "text/javascript"), ("/app.css", "text/css")] {
        let r = s.get(path);
        assert!(r.status == 200 && r.head.contains(&format!("content-type: {kind}")), "{path}");
    }
    assert_eq!((s.get("/nope").status, s.get("/nope").code()), (404, "not_found".to_string()));
}

#[test]
fn status_describes_an_unpaired_running_daemon() {
    let s = server();
    let status = s.get("/api/status").json();
    assert_eq!((status["running"].clone(), status["paired"].clone()), (json!(true), json!(false)));
    assert_eq!(status["version"], crate::VERSION);
    assert_eq!((status["printers"].clone(), status["jobs"].clone()), (json!([]), json!([])));
    assert_eq!(status["settings"], serde_json::to_value(crate::proto::ClientSettings::default()).unwrap());
    assert_eq!(s.get("/api/printers").json(), json!({ "printers": [] }));
}

#[test]
fn status_lists_printers_from_other_devices() {
    let s = server();
    let none = json!({ "active": false, "error": null, "printers": [] });
    assert_eq!(s.get("/api/status").json()["remotePrinters"], none);
    let remote = serde_json::from_value(json!({
        "id": "pr_07", "name": "Upstairs laser", "location": null, "makeModel": null, "clientName": "Den Pi",
        "online": false, "state": "offline",
        "capabilities": { "formats": [], "color": false, "duplex": false, "media": [], "mediaDefault": null, "resolutions": [], "copiesMax": 1 },
        "defaults": {}
    }));
    s.d.set_remote_printers(vec![remote.unwrap()]);
    let listed = json!([{ "id": "pr_07", "name": "Upstairs laser", "queue": null, "online": false }]);
    assert_eq!(s.get("/api/status").json()["remotePrinters"]["printers"], listed);
}

#[test]
fn settings_round_trip_and_bad_patches_are_rejected() {
    let s = server();
    let updated = s.post("/api/settings", &json!({ "discovery": { "snmp": false } }));
    assert_eq!((updated.status, updated.json()["discovery"]["snmp"].clone()), (200, json!(false)));
    assert_eq!(s.get("/api/settings").json()["discovery"]["snmp"], json!(false));
    assert!(!store::load_config(&s.d.paths).settings.discovery.snmp, "persisted");
    for patch in [json!({ "nope": 1 }), json!({ "paused": "yes" }), json!({ "autoAdd": "sometimes" })] {
        let r = s.post("/api/settings", &patch);
        assert_eq!((r.status, r.code()), (400, "invalid_setting".to_string()), "{patch}");
    }
}

#[test]
fn pairing_requests_are_validated_before_any_network_call() {
    let s = server();
    let r = s.post("/api/pair", &json!({ "server": "ftp://print.example.com", "token": "pbe_x" }));
    assert_eq!((r.status, r.code()), (400, "bad_server".to_string()));
    let r = s.post("/api/pair", &json!({ "server": "http://print.example.com" }));
    assert_eq!((r.status, r.code()), (400, "bad_server".to_string()));
    assert_eq!(s.post("/api/unpair", &json!({})).code(), "not_paired");
    assert_eq!(s.post("/api/pair/cancel", &json!({})).status, 200);
    let dir = TempDir::new();
    let creds = Credentials {
        server: "https://print.example.com".into(),
        client_id: "c1".into(),
        workspace_id: "w1".into(),
        name: "Den".into(),
        token: "pbc_secret".into(),
    };
    store::save_credentials(&dir.paths(), &creds).unwrap();
    let paired = Server::start(dir);
    let r = paired.post("/api/pair", &json!({ "server": "https://other.example.com" }));
    assert_eq!((r.status, r.code()), (409, "already_paired".to_string()));
    let status = paired.get("/api/status").json();
    assert_eq!((status["paired"].clone(), status["name"].clone()), (json!(true), json!("Den")));
    assert!(!paired.get("/api/status").body.contains("pbc_secret"), "the device token never leaves the daemon");
}

#[test]
fn jobs_logs_and_print_answer_cleanly_without_printers() {
    let s = server();
    assert_eq!(s.get("/api/jobs/nope").code(), "not_found");
    assert_eq!(s.post("/api/jobs/nope/cancel", &json!({})).code(), "not_found");
    assert_eq!(s.get("/api/logs?lines=5").json()["lines"], json!([]));
    let origin = format!("Origin: http://{}", s.host());
    let headers = ["Content-Type: application/octet-stream", origin.as_str()];
    let r = s.send("POST", "/api/print?title=a.pdf", &s.host(), &headers, b"%PDF-1.4");
    assert_eq!((r.status, r.code()), (400, "choose_printer".to_string()));
    let r = s.send("POST", "/api/print", &s.host(), &["Content-Type: application/json", origin.as_str()], b"{}");
    assert_eq!(r.status, 415, "documents must be sent as octet-stream");
    assert!(s.d.queue.list().is_empty());
}

#[test]
fn quit_stops_the_daemon() {
    let s = server();
    assert_eq!(s.post("/api/quit", &json!({})).status, 200);
    assert!(s.d.stopping.is_canceled() && !s.d.restart_requested());
}
