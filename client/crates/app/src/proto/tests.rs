//! The serde mirror against JSON fixtures that follow server/shared/*.ts field for field.

use super::*;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

type Fields = BTreeSet<String>;

const CLIENT: [(&str, &str); 8] = [
    ("client_hello", "HelloMsg"),
    ("client_printers", "PrintersMsg"),
    ("client_printer_status", "PrinterStatusMsg"),
    ("client_job_status", "JobStatusMsg"),
    ("client_lan_job", "LanJobMsg"),
    ("client_result_ok", "ResultMsg"),
    ("client_result_error", "ResultMsg"),
    ("client_settings", "ClientSettingsMsg"),
];
const SERVER: [(&str, &str); 7] = [
    ("server_welcome", "WelcomeMsg"),
    ("server_job", "JobMsg"),
    ("server_cancel", "CancelMsg"),
    ("server_settings", "ServerSettingsMsg"),
    ("server_printer_config", "PrinterConfigMsg"),
    ("server_remote_printers", "RemotePrintersMsg"),
    ("server_command", "CommandMsg"),
];

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixture(name: &str) -> Value {
    let path = root().join("tests/fixtures/protocol").join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn shared(file: &str) -> String {
    std::fs::read_to_string(root().join("../../../server/shared").join(file)).unwrap()
}

/// `(all, required)` field names of `export interface {name}` in server/shared/{file}.
fn ts_fields(file: &str, name: &str) -> (Fields, Fields) {
    let source = shared(file);
    let start = source.find(&format!("export interface {name} ")).unwrap_or_else(|| panic!("{name} missing in {file}"));
    let body = &source[start..];
    let body = &body[body.find('{').unwrap() + 1..body.find("\n}").unwrap()];
    let (mut all, mut required) = (Fields::new(), Fields::new());
    for line in body.lines().filter_map(|l| l.strip_prefix("  ")).filter(|l| l.starts_with(char::is_alphabetic)) {
        let field = &line[..line.find(':').unwrap()];
        let name = field.trim_end_matches('?').to_string();
        if !field.ends_with('?') {
            required.insert(name.clone());
        }
        all.insert(name);
    }
    (all, required)
}

fn keys(value: &Value) -> Fields {
    value.as_object().unwrap().keys().cloned().collect()
}

/// The object at `pointer` in every fixture has all required fields and nothing unknown;
/// together the fixtures cover every field.
fn assert_mirrors(file: &str, cases: &[(&str, &str)], pointer: &str) {
    let mut seen: BTreeMap<&str, Fields> = BTreeMap::new();
    for (name, interface) in cases {
        let (all, required) = ts_fields(file, interface);
        let keys = keys(fixture(name).pointer(pointer).unwrap_or_else(|| panic!("{name}{pointer}")));
        assert!(required.is_subset(&keys), "{name} lacks {:?}", required.difference(&keys).collect::<Vec<_>>());
        assert!(keys.is_subset(&all), "{name} has unknown {:?}", keys.difference(&all).collect::<Vec<_>>());
        seen.entry(interface).or_default().extend(keys);
    }
    for (interface, keys) in seen {
        assert_eq!(keys, ts_fields(file, interface).0, "fixtures do not exercise every field of {interface}");
    }
}

#[test]
fn client_messages_round_trip_exactly() {
    for (name, _) in CLIENT {
        let value = fixture(name);
        let msg: ClientMsg = serde_json::from_value(value.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(serde_json::to_value(&msg).unwrap(), value, "{name}");
    }
}

#[test]
fn server_messages_round_trip_exactly() {
    for (name, _) in SERVER {
        let value = fixture(name);
        let msg: ServerMsg = serde_json::from_value(value.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(!matches!(msg, ServerMsg::Unknown), "{name}");
        assert_eq!(serde_json::to_value(&msg).unwrap(), value, "{name}");
    }
}

#[test]
fn messages_mirror_protocol_ts() {
    assert_mirrors("protocol.ts", &CLIENT, "");
    assert_mirrors("protocol.ts", &SERVER, "");
}

#[test]
fn nested_types_mirror_shared_ts() {
    assert_mirrors("protocol.ts", &[("server_job", "JobOffer")], "/job");
    assert_mirrors("protocol.ts", &[("server_welcome", "PrinterConfig")], "/printers/0");
    assert_mirrors("protocol.ts", &[("server_remote_printers", "RemotePrinter")], "/printers/0");
    assert_mirrors("printing.ts", &[("server_remote_printers", "Capabilities")], "/printers/1/capabilities");
    assert_mirrors("types.ts", &[("client_hello", "ClientSettings")], "/settings");
    assert_mirrors("printing.ts", &[("server_welcome", "JobOptions")], "/printers/0/defaults");
    let printers = [
        ("PrinterReport", "/printers/0"),
        ("Capabilities", "/printers/0/capabilities"),
        ("PrinterStatus", "/printers/0/status"),
        ("Supply", "/printers/0/status/supplies/0"),
        ("Route", "/printers/0/routes/0"),
    ];
    for (interface, pointer) in printers {
        assert_mirrors("printing.ts", &[("client_printers", interface)], pointer);
    }
}

#[test]
fn unknown_server_types_and_fields_are_ignored() {
    let msg: ServerMsg = serde_json::from_value(json!({ "type": "brand_new", "anything": [1, 2] })).unwrap();
    assert_eq!(msg, ServerMsg::Unknown);
    let mut welcome = fixture("server_welcome");
    welcome["futureField"] = json!(true);
    welcome["settings"]["futureToggle"] = json!("x");
    welcome["printers"][0]["futureFlag"] = json!(1);
    let ServerMsg::Welcome { name, printers, settings, .. } = serde_json::from_value(welcome).unwrap() else {
        panic!("expected welcome");
    };
    assert_eq!((name.as_str(), printers[0].id.as_str(), settings.log_level.as_str()), ("Kitchen Mac", "pr_01", "debug"));
}

#[test]
fn optional_fields_are_omitted_when_none() {
    let status = ClientMsg::JobStatus { job_id: "j".into(), status: JobStatus::Failed, message: None, pages: None, attempt: None };
    assert_eq!(keys(&serde_json::to_value(status).unwrap()), ["jobId", "status", "type"].map(String::from).into());
    let result = ClientMsg::Result { id: "c".into(), ok: true, data: None, error: None };
    assert_eq!(keys(&serde_json::to_value(result).unwrap()), ["id", "ok", "type"].map(String::from).into());
    let lan = ClientMsg::LanJob {
        local_id: "l".into(),
        printer_key: "k".into(),
        title: "t".into(),
        user: None,
        content_type: "application/pdf".into(),
        size: 1,
        status: "queued".into(),
        message: None,
    };
    let lan = serde_json::to_value(lan).unwrap();
    assert!(lan.get("message").is_none());
    assert_eq!(lan["user"], Value::Null, "user is required and nullable");
}

#[test]
fn command_without_args_and_sparse_settings_get_defaults() {
    let msg: ServerMsg = serde_json::from_value(json!({ "type": "command", "id": "c1", "name": "unpair" })).unwrap();
    assert_eq!(msg, ServerMsg::Command { id: "c1".into(), name: "unpair".into(), args: Value::Null });
    let sparse: ClientSettings = serde_json::from_value(json!({ "tray": false, "discovery": { "usb": false } })).unwrap();
    let expected = ClientSettings {
        tray: false,
        discovery: DiscoveryToggles { usb: false, ..DiscoveryToggles::default() },
        ..ClientSettings::default()
    };
    assert_eq!(sparse, expected);
    assert!(sparse.remote_printers, "older servers omit remotePrinters; it stays on");
    assert!(sparse.auto_update, "older servers omit autoUpdate; it stays on");
}

#[test]
fn defaults_and_constants_match_typescript() {
    let defaults = json!({
        "tray": true, "lanSharing": false, "autoAdd": "inherit",
        "discovery": { "mdns": true, "snmp": true, "usb": true, "os": true },
        "paused": false, "logLevel": "info", "remotePrinters": true, "autoUpdate": true
    });
    assert_eq!(serde_json::to_value(ClientSettings::default()).unwrap(), defaults);
    let types = shared("types.ts");
    assert!(types.contains("autoAdd: 'inherit',\n  discovery: { mdns: true, snmp: true, usb: true, os: true }"));
    assert!(types.contains("logLevel: 'info',\n  remotePrinters: true,\n  autoUpdate: true,\n}"));
    let protocol = shared("protocol.ts");
    for line in [
        format!("export const PROTOCOL_VERSION = {PROTOCOL_VERSION}\n"),
        format!("export const PING = '{PING}'\n"),
        format!("export const PONG = '{PONG}'\n"),
        format!("export const LOCAL_PORT = {LOCAL_PORT}\n"),
        format!("export const LAN_SHARE_PORT = {LAN_SHARE_PORT}\n"),
        format!("export const REMOTE_PRINT_PORT = {REMOTE_PRINT_PORT}\n"),
        format!("export const PING_INTERVAL_MS = {}_000\n", PING_INTERVAL_SECS),
    ] {
        assert!(protocol.contains(&line), "protocol.ts lacks {line:?}");
    }
    let statuses = [JobStatus::Dispatched, JobStatus::Printing, JobStatus::Completed, JobStatus::Failed, JobStatus::Canceled];
    let names: Vec<Value> = statuses.iter().map(|s| serde_json::to_value(s).unwrap()).collect();
    assert_eq!(names, ["dispatched", "printing", "completed", "failed", "canceled"].map(Value::from));
}
