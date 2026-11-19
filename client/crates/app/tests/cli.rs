//! Exit codes and output of the real binary. Each run gets its own data folder and a local
//! API port nothing listens on, so a daemon running on this machine is never touched.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU32, Ordering};

struct Home(PathBuf);

impl Home {
    fn new() -> Home {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("printbetter-cli-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Home(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn dead_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn run(home: &Home, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_printbetter"))
        .args(args)
        .env("PRINTBETTER_HOME", home.path())
        .env("PRINTBETTER_PORT", dead_port().to_string())
        .env_remove("PRINTBETTER_LOG")
        .output()
        .unwrap()
}

fn code(out: &Output) -> i32 {
    out.status.code().unwrap()
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn help_and_version_exit_zero() {
    let home = Home::new();
    for args in [["help"], ["--help"]] {
        let out = run(&home, &args);
        assert_eq!(code(&out), 0);
        assert!(stdout(&out).contains("Usage: printbetter <command>"));
    }
    let out = run(&home, &["version"]);
    assert_eq!((code(&out), stdout(&out)), (0, format!("printbetter {}\n", env!("CARGO_PKG_VERSION"))));
}

#[test]
fn usage_errors_exit_two() {
    let home = Home::new();
    let cases: [&[&str]; 8] = [
        &["frobnicate"],
        &["print"],
        &["tray", "maybe"],
        &["logs", "--lines", "many"],
        &["config", "set", "nope", "1"],
        &["config", "set", "discovery.snmp", "maybe"],
        &["pair", "--server", "ftp://print.example.com"],
        &["pair", "--server", "http://print.example.com"],
    ];
    for args in cases {
        assert_eq!(code(&run(&home, args)), 2, "{args:?}");
    }
}

#[test]
fn commands_that_need_the_daemon_exit_four() {
    let home = Home::new();
    for args in [&["status"][..], &["printers"], &["printers", "--json"]] {
        let out = run(&home, args);
        assert_eq!(code(&out), 4, "{args:?}");
    }
    let out = run(&home, &["status", "--json"]);
    assert_eq!(code(&out), 4);
    let status: serde_json::Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert_eq!(status, serde_json::json!({ "running": false, "paired": false, "server": null, "name": null }));
}

#[test]
fn stopped_status_still_shows_the_saved_pairing() {
    let home = Home::new();
    let creds = r#"{"server":"https://print.example.com","clientId":"c1","workspaceId":"w1","name":"Den","token":"pbc_x"}"#;
    std::fs::write(home.path().join("credentials.json"), creds).unwrap();
    let out = run(&home, &["status", "--json"]);
    assert_eq!(code(&out), 4);
    let status: serde_json::Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert_eq!((status["paired"].clone(), status["name"].clone()), (true.into(), "Den".into()));
    assert!(!stdout(&out).contains("pbc_x"));
}

#[test]
fn unpair_without_a_pairing_exits_three() {
    let home = Home::new();
    assert_eq!(code(&run(&home, &["unpair", "--yes"])), 3);
}

#[test]
fn settings_change_offline_and_persist() {
    let home = Home::new();
    let get = |key: &str| stdout(&run(&home, &["config", "get", key])).trim().to_string();
    assert_eq!(code(&run(&home, &["config", "set", "discovery.snmp", "off"])), 0);
    assert_eq!(get("discovery.snmp"), "off");
    assert_eq!(code(&run(&home, &["tray", "off"])), 0);
    assert_eq!(get("tray"), "off");
    assert_eq!(code(&run(&home, &["pause"])), 0);
    assert_eq!(get("paused"), "on");
    assert_eq!(code(&run(&home, &["resume"])), 0);
    assert_eq!(get("paused"), "off");
    assert_eq!(get("remotePrinters"), "on");
    assert_eq!(code(&run(&home, &["config", "set", "remotePrinters", "off"])), 0);
    assert_eq!(get("remotePrinters"), "off");
    assert!(home.path().join("config.json").exists());
    let all = stdout(&run(&home, &["config", "get"]));
    assert!(all.contains("discovery.snmp = off") && all.contains("logLevel = info"));
}

#[test]
fn logs_tail_the_local_log_file() {
    let home = Home::new();
    std::fs::create_dir_all(home.path().join("logs")).unwrap();
    std::fs::write(home.path().join("logs/printbetter.log"), "one\ntwo\nthree\n").unwrap();
    let out = run(&home, &["logs", "--lines", "2"]);
    assert_eq!((code(&out), stdout(&out)), (0, "two\nthree\n".to_string()));
}

#[test]
fn printing_a_missing_file_fails_before_doing_anything() {
    let home = Home::new();
    let out = run(&home, &["print", "/nonexistent/printbetter-test.pdf"]);
    assert_eq!(code(&out), 1);
    assert!(String::from_utf8_lossy(&out.stderr).contains("Can't read"));
}
