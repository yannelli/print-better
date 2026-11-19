//! The command-line grammar of docs/cli.md, command by command.

use super::parse::{Cmd, parse};
use crate::service::Action;
use std::ffi::OsString;
use std::path::PathBuf;

fn cmd(line: &str) -> Cmd {
    try_cmd(line).unwrap_or_else(|e| panic!("{line:?}: {e}"))
}

fn try_cmd(line: &str) -> Result<Cmd, String> {
    parse(line.split_whitespace().map(OsString::from).collect()).map_err(|e| e.to_string())
}

fn rejects(line: &str) {
    assert!(try_cmd(line).is_err(), "{line:?} should be a usage error");
}

#[test]
fn help_version_and_bare() {
    assert_eq!(cmd(""), Cmd::Bare);
    for line in ["help", "--help", "-h"] {
        assert_eq!(cmd(line), Cmd::Help, "{line}");
    }
    for line in ["version", "--version", "-V"] {
        assert_eq!(cmd(line), Cmd::Version, "{line}");
    }
    rejects("--bogus");
    let unknown = try_cmd("frobnicate").unwrap_err();
    assert!(unknown.contains("unknown command \"frobnicate\""), "{unknown}");
}

#[test]
fn run_and_tray_ui() {
    assert_eq!(cmd("run"), Cmd::Run { no_tray: false });
    assert_eq!(cmd("run --no-tray"), Cmd::Run { no_tray: true });
    assert_eq!(cmd("tray-ui"), Cmd::TrayUi);
    rejects("run --tray");
    rejects("run extra");
    rejects("tray-ui --no-tray");
}

#[test]
fn pair_and_unpair() {
    let pair = |server: &str, token: Option<&str>, name: Option<&str>| Cmd::Pair {
        server: server.into(),
        token: token.map(Into::into),
        name: name.map(Into::into),
    };
    assert_eq!(cmd("pair --server https://p.example"), pair("https://p.example", None, None));
    assert_eq!(cmd("pair --server p.example --token pbe_1 --name Den"), pair("p.example", Some("pbe_1"), Some("Den")));
    assert_eq!(cmd("pair --name=Den --server=p.example"), pair("p.example", None, Some("Den")));
    assert!(try_cmd("pair --token pbe_1").unwrap_err().contains("missing --server"));
    rejects("pair --server");
    rejects("pair --server p.example --code 1");
    assert_eq!(cmd("unpair"), Cmd::Unpair { yes: false });
    assert_eq!(cmd("unpair --yes"), Cmd::Unpair { yes: true });
    rejects("unpair -y");
}

#[test]
fn read_only_commands_take_json() {
    assert_eq!(cmd("status"), Cmd::Status { json: false });
    assert_eq!(cmd("status --json"), Cmd::Status { json: true });
    assert_eq!(cmd("printers --json"), Cmd::Printers { json: true });
    assert_eq!(cmd("doctor --json"), Cmd::Doctor { json: true });
    rejects("status --verbose");
    rejects("doctor now");
}

#[test]
fn discover_clamps_its_timeout() {
    assert_eq!(cmd("discover"), Cmd::Discover { json: false, timeout: 4 });
    assert_eq!(cmd("discover --json --timeout 10"), Cmd::Discover { json: true, timeout: 10 });
    assert_eq!(cmd("discover --timeout 0"), Cmd::Discover { json: false, timeout: 1 });
    assert_eq!(cmd("discover --timeout 999"), Cmd::Discover { json: false, timeout: 60 });
    rejects("discover --timeout soon");
}

#[test]
fn print_collects_options_in_order() {
    let expected = Cmd::Print {
        file: PathBuf::from("letter.pdf"),
        params: vec![
            ("printer", "Office".into()),
            ("copies", "2".into()),
            ("media", "iso_a4_210x297mm".into()),
            ("sides", "long".into()),
            ("color", "mono".into()),
        ],
    };
    let line = "print letter.pdf --printer Office --copies 2 --media iso_a4_210x297mm --sides long --mono";
    assert_eq!(cmd(line), expected);
    assert_eq!(cmd("print --color a.png"), Cmd::Print { file: "a.png".into(), params: vec![("color", "color".into())] });
    assert!(try_cmd("print --copies 2").unwrap_err().contains("missing FILE"));
    rejects("print a.pdf b.pdf");
    rejects("print a.pdf --duplex");
}

#[test]
fn tray_pause_and_resume() {
    assert_eq!(cmd("tray on"), Cmd::Tray { on: true });
    assert_eq!(cmd("tray off"), Cmd::Tray { on: false });
    rejects("tray");
    rejects("tray maybe");
    rejects("tray on now");
    assert_eq!(cmd("pause"), Cmd::Pause { paused: true });
    assert_eq!(cmd("resume"), Cmd::Pause { paused: false });
    rejects("pause 5m");
}

#[test]
fn config_get_and_set() {
    assert_eq!(cmd("config get"), Cmd::ConfigGet { key: None });
    assert_eq!(cmd("config get discovery.snmp"), Cmd::ConfigGet { key: Some("discovery.snmp".into()) });
    let set = Cmd::ConfigSet { key: "discovery.snmp".into(), value: "off".into() };
    assert_eq!(cmd("config set discovery.snmp off"), set);
    for line in ["config", "config set tray", "config set a b c", "config get a b", "config list", "config get --all"] {
        rejects(line);
    }
}

#[test]
fn service_actions_and_flags() {
    let service = |action, system, no_tray| Cmd::Service { action, system, no_tray };
    assert_eq!(cmd("service install"), service(Action::Install, false, false));
    assert_eq!(cmd("service install --system --no-tray"), service(Action::Install, true, true));
    assert_eq!(cmd("service uninstall --system"), service(Action::Uninstall, true, false));
    for (word, action) in [("start", Action::Start), ("stop", Action::Stop), ("restart", Action::Restart), ("status", Action::Status)] {
        assert_eq!(cmd(&format!("service {word}")), service(action, false, false));
    }
    rejects("service");
    rejects("service reinstall");
    rejects("service start --no-tray");
}

#[test]
fn logs_follow_and_line_count() {
    assert_eq!(cmd("logs"), Cmd::Logs { follow: false, lines: 200 });
    assert_eq!(cmd("logs --follow --lines 50"), Cmd::Logs { follow: true, lines: 50 });
    assert_eq!(cmd("logs -f -n 0"), Cmd::Logs { follow: true, lines: 1 });
    assert_eq!(cmd("logs --lines 99999"), Cmd::Logs { follow: false, lines: 2000 });
    rejects("logs --lines many");
    rejects("logs everything");
}

#[test]
fn update_check_and_yes() {
    assert_eq!(cmd("update"), Cmd::Update { check: false, yes: false });
    assert_eq!(cmd("update --check"), Cmd::Update { check: true, yes: false });
    assert_eq!(cmd("update --yes"), Cmd::Update { check: false, yes: true });
    assert_eq!(cmd("update -y --check"), Cmd::Update { check: true, yes: true });
    assert_eq!(cmd("update-helper"), Cmd::UpdateHelper);
    rejects("update-helper --yes");
    rejects("update now");
    rejects("update --force");
}
