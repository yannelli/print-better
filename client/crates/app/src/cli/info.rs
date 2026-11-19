//! Read-only commands: `status`, `printers`, `logs`, `doctor`.

use super::{EXIT_ERROR, EXIT_NO_DAEMON, Failure, Outcome, block_on, print_json};
use crate::daemon::{self, diagnose};
use crate::local::client::{self, LocalError};
use crate::paths::Paths;
use crate::{logger, platform, settings, store, tray};
use serde_json::{Value, json};
use std::path::PathBuf;

pub fn status(as_json: bool) -> Outcome {
    let status = match client::get("/api/status") {
        Ok(status) => status,
        Err(LocalError::NotRunning) => return not_running(as_json),
        Err(e) => return Err(e.into()),
    };
    if as_json {
        print_json(&status);
        return Ok(());
    }
    let connection = match status["connection"].as_str().unwrap_or_default() {
        "online" => "connected".to_string(),
        "connecting" => "connecting".into(),
        "unpaired" => "not paired (run: printbetter pair --server URL)".into(),
        _ => status["connectionDetail"].as_str().unwrap_or("offline").to_string(),
    };
    println!("Print Better {}", text(&status["version"]));
    row("Server", &format!("{} ({connection})", status["server"].as_str().unwrap_or("none")));
    row("Device", text(&status["name"]));
    row("Printing", if status["settings"]["paused"] == true { "paused" } else { "on" });
    let sharing = match (status["settings"]["lanSharing"] == true, status["lanSharing"]["error"].as_str()) {
        (false, _) => "off".to_string(),
        (true, Some(error)) => format!("on, but not working: {error}"),
        (true, None) => "on".into(),
    };
    row("LAN sharing", &sharing);
    let printers: Vec<String> = list(&status["printers"])
        .iter()
        .map(|p| {
            let added = if p["added"] == true { ", added" } else { "" };
            format!("{} ({}{added})", text(&p["name"]), tray::state_label(text(&p["state"])))
        })
        .collect();
    row("Printers", if printers.is_empty() { "none found yet" } else { &printers[0] });
    for more in printers.iter().skip(1) {
        row("", more);
    }
    let count = |wanted: &str| list(&status["jobs"]).iter().filter(|j| j["status"] == wanted).count();
    row("Queue", &format!("{} printing, {} waiting", count("printing"), count("dispatched")));
    row("Updates", &updates(&status["update"]));
    Ok(())
}

fn updates(update: &Value) -> String {
    let latest = text(&update["latest"]);
    if let Some(phase) = update["phase"].as_str() {
        return format!("{phase} {latest}");
    }
    if let Some(error) = update["error"].as_str() {
        return error.to_string();
    }
    match (update["available"] == true, update["checkedAt"].is_null()) {
        (true, _) if update["autoUpdate"] == true => format!("{latest} available, installs automatically"),
        (true, _) => format!("{latest} available (run: printbetter update)"),
        (false, true) => "not checked yet".into(),
        (false, false) => "up to date".into(),
    }
}

fn not_running(as_json: bool) -> Outcome {
    let creds = store::load_credentials(&Paths::resolve());
    if as_json {
        let name = creds.as_ref().map(|c| c.name.clone());
        print_json(&json!({ "running": false, "paired": creds.is_some(), "server": creds.map(|c| c.server), "name": name }));
    } else {
        println!("Print Better is not running.");
        match creds {
            Some(c) => row("Paired", &format!("with {} as \"{}\"", c.server, c.name)),
            None => row("Paired", "no"),
        }
    }
    let hint = if as_json { "" } else { "Start it with: printbetter service start (or printbetter run)" };
    Err(Failure { code: EXIT_NO_DAEMON, message: hint.into() })
}

pub fn printers(as_json: bool) -> Outcome {
    let reply = client::get("/api/printers")?;
    if as_json {
        print_json(&reply["printers"]);
        return Ok(());
    }
    let printers = list(&reply["printers"]);
    if printers.is_empty() {
        println!("No printers found yet. Try: printbetter discover");
        return Ok(());
    }
    let rows: Vec<[String; 4]> = printers
        .iter()
        .map(|p| {
            let added = if p["added"] == true { "yes" } else { "no" };
            [text(&p["name"]).into(), tray::state_label(text(&p["state"])).into(), added.into(), text(&p["key"]).into()]
        })
        .collect();
    let width = |i: usize| rows.iter().map(|r| r[i].chars().count()).max().unwrap_or(0).max(5);
    let (w0, w1, w2) = (width(0), width(1), width(2));
    println!("{:<w0$}  {:<w1$}  {:<w2$}  KEY", "NAME", "STATE", "ADDED");
    for r in &rows {
        println!("{:<w0$}  {:<w1$}  {:<w2$}  {}", r[0], r[1], r[2], r[3]);
    }
    Ok(())
}

pub fn logs(follow: bool, lines: usize) -> Outcome {
    let from_daemon = client::get("/api/status").ok().and_then(|s| s["logFile"].as_str().map(PathBuf::from));
    let file = from_daemon.unwrap_or_else(|| Paths::resolve().log_file());
    if std::fs::File::open(&file).is_err() {
        // The service may log somewhere this user can't read; ask it instead.
        let reply = client::get(&format!("/api/logs?lines={lines}"))?;
        list(&reply["lines"]).iter().for_each(|line| println!("{}", text(line)));
        return if follow { Err(Failure::error(format!("Can't follow {} from this account.", file.display()))) } else { Ok(()) };
    }
    logger::tail(&file, lines).iter().for_each(|line| println!("{line}"));
    if follow {
        logger::follow(&file).map_err(|e| Failure::error(e.to_string()))?;
    }
    Ok(())
}

pub fn doctor(as_json: bool) -> Outcome {
    let checks: Vec<diagnose::Check> = match client::get("/api/doctor") {
        Ok(reply) => serde_json::from_value(reply["checks"].clone()).map_err(|e| Failure::error(e.to_string()))?,
        Err(LocalError::NotRunning) => without_daemon()?,
        Err(e) => return Err(e.into()),
    };
    if as_json {
        print_json(&json!({ "checks": checks }));
    } else {
        for check in &checks {
            println!("{}  {}: {}", if check.ok { " ok " } else { "FAIL" }, check.name, check.detail);
        }
    }
    if checks.iter().all(|c| c.ok) { Ok(()) } else { Err(Failure { code: EXIT_ERROR, message: String::new() }) }
}

fn without_daemon() -> Result<Vec<diagnose::Check>, Failure> {
    let paths = Paths::resolve();
    let engine = daemon::make_engine(&paths, &platform::user_name());
    let options = settings::discover_options(&store::load_config(&paths).settings, None);
    let mut checks = block_on(async {
        let found = engine.discover(&options).await;
        let inputs = diagnose::Inputs {
            creds: store::load_credentials(&paths),
            connection: None,
            clock_offset_ms: None,
            discovered: Some(found.len()),
            discovery_off: diagnose::discovery_off(&options),
            probe: found,
        };
        diagnose::run(&engine, &paths, inputs).await
    })?;
    let detail = "Print Better is not running. Start it with: printbetter service start";
    checks.insert(0, diagnose::Check { name: "Service".into(), ok: false, detail: detail.into() });
    Ok(checks)
}

fn row(label: &str, value: &str) {
    println!("  {label:<12} {value}");
}

fn list(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}
