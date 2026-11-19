//! Command-line grammar (docs/cli.md), parsed with lexopt.

use crate::service::Action;
use lexopt::prelude::*;
use std::ffi::OsString;
use std::path::PathBuf;

#[cfg_attr(test, derive(Debug, PartialEq))]
pub enum Cmd {
    /// No arguments: a double-click starts the app; a terminal gets help.
    Bare,
    Run { no_tray: bool },
    TrayUi,
    Pair { server: String, token: Option<String>, name: Option<String> },
    Unpair { yes: bool },
    Status { json: bool },
    Printers { json: bool },
    Discover { json: bool, timeout: u64 },
    Print { file: PathBuf, params: Vec<(&'static str, String)> },
    Tray { on: bool },
    Pause { paused: bool },
    ConfigGet { key: Option<String> },
    ConfigSet { key: String, value: String },
    Service { action: Action, system: bool, no_tray: bool },
    Logs { follow: bool, lines: usize },
    Doctor { json: bool },
    Update { check: bool, yes: bool },
    /// Run by printbetter-update.service as root (Linux system service).
    UpdateHelper,
    Version,
    Help,
}

pub fn parse(args: Vec<OsString>) -> Result<Cmd, lexopt::Error> {
    let mut p = lexopt::Parser::from_args(args);
    let command = match p.next()? {
        None => return Ok(Cmd::Bare),
        Some(Long("help") | Short('h')) => return Ok(Cmd::Help),
        Some(Long("version") | Short('V')) => return Ok(Cmd::Version),
        Some(Value(v)) => v.string()?,
        Some(other) => return Err(other.unexpected()),
    };
    let cmd = match command.as_str() {
        "run" => Cmd::Run { no_tray: flag(&mut p, "no-tray")? },
        "tray-ui" => {
            end(&mut p)?;
            Cmd::TrayUi
        }
        "pair" => pair(&mut p)?,
        "unpair" => Cmd::Unpair { yes: flag(&mut p, "yes")? },
        "status" => Cmd::Status { json: flag(&mut p, "json")? },
        "printers" => Cmd::Printers { json: flag(&mut p, "json")? },
        "discover" => discover(&mut p)?,
        "print" => print(&mut p)?,
        "tray" => Cmd::Tray { on: on_off(&mut p)? },
        "pause" | "resume" => {
            end(&mut p)?;
            Cmd::Pause { paused: command == "pause" }
        }
        "config" => config(&mut p)?,
        "service" => service(&mut p)?,
        "logs" => logs(&mut p)?,
        "doctor" => Cmd::Doctor { json: flag(&mut p, "json")? },
        "update" => update(&mut p)?,
        "update-helper" => {
            end(&mut p)?;
            Cmd::UpdateHelper
        }
        "version" => Cmd::Version,
        "help" => Cmd::Help,
        other => return Err(format!("unknown command \"{other}\"").into()),
    };
    Ok(cmd)
}

/// Accepts only `--{name}` (optionally); anything else is a usage error.
fn flag(p: &mut lexopt::Parser, name: &str) -> Result<bool, lexopt::Error> {
    let mut set = false;
    while let Some(arg) = p.next()? {
        match arg {
            Long(n) if n == name => set = true,
            other => return Err(other.unexpected()),
        }
    }
    Ok(set)
}

fn end(p: &mut lexopt::Parser) -> Result<(), lexopt::Error> {
    match p.next()? {
        None => Ok(()),
        Some(other) => Err(other.unexpected()),
    }
}

fn pair(p: &mut lexopt::Parser) -> Result<Cmd, lexopt::Error> {
    let (mut server, mut token, mut name) = (None, None, None);
    while let Some(arg) = p.next()? {
        match arg {
            Long("server") => server = Some(p.value()?.string()?),
            Long("token") => token = Some(p.value()?.string()?),
            Long("name") => name = Some(p.value()?.string()?),
            other => return Err(other.unexpected()),
        }
    }
    let server = server.ok_or("missing --server URL")?;
    Ok(Cmd::Pair { server, token, name })
}

fn discover(p: &mut lexopt::Parser) -> Result<Cmd, lexopt::Error> {
    let (mut json, mut timeout) = (false, 4);
    while let Some(arg) = p.next()? {
        match arg {
            Long("json") => json = true,
            Long("timeout") => timeout = p.value()?.parse::<u64>()?.clamp(1, 60),
            other => return Err(other.unexpected()),
        }
    }
    Ok(Cmd::Discover { json, timeout })
}

fn print(p: &mut lexopt::Parser) -> Result<Cmd, lexopt::Error> {
    let (mut file, mut params) = (None, Vec::new());
    while let Some(arg) = p.next()? {
        match arg {
            Value(v) if file.is_none() => file = Some(PathBuf::from(v)),
            Long("printer") => params.push(("printer", p.value()?.string()?)),
            Long("copies") => params.push(("copies", p.value()?.string()?)),
            Long("media") => params.push(("media", p.value()?.string()?)),
            Long("sides") => params.push(("sides", p.value()?.string()?)),
            Long("color") => params.push(("color", "color".into())),
            Long("mono") => params.push(("color", "mono".into())),
            other => return Err(other.unexpected()),
        }
    }
    let file = file.ok_or("missing FILE to print")?;
    Ok(Cmd::Print { file, params })
}

fn on_off(p: &mut lexopt::Parser) -> Result<bool, lexopt::Error> {
    let value = p.value()?.string()?;
    end(p)?;
    match value.as_str() {
        "on" => Ok(true),
        "off" => Ok(false),
        _ => Err("expected on or off".into()),
    }
}

fn config(p: &mut lexopt::Parser) -> Result<Cmd, lexopt::Error> {
    let action = p.value()?.string()?;
    let mut rest = Vec::new();
    while let Some(arg) = p.next()? {
        match arg {
            Value(v) => rest.push(v.string()?),
            other => return Err(other.unexpected()),
        }
    }
    match (action.as_str(), rest.as_slice()) {
        ("get", []) => Ok(Cmd::ConfigGet { key: None }),
        ("get", [key]) => Ok(Cmd::ConfigGet { key: Some(key.clone()) }),
        ("set", [key, value]) => Ok(Cmd::ConfigSet { key: key.clone(), value: value.clone() }),
        _ => Err("usage: printbetter config get [KEY] | config set KEY VALUE".into()),
    }
}

fn service(p: &mut lexopt::Parser) -> Result<Cmd, lexopt::Error> {
    let action = match p.value()?.string()?.as_str() {
        "install" => Action::Install,
        "uninstall" => Action::Uninstall,
        "start" => Action::Start,
        "stop" => Action::Stop,
        "restart" => Action::Restart,
        "status" => Action::Status,
        other => return Err(format!("unknown service action \"{other}\"").into()),
    };
    let (mut system, mut no_tray) = (false, false);
    while let Some(arg) = p.next()? {
        match arg {
            Long("system") => system = true,
            Long("no-tray") if action == Action::Install => no_tray = true,
            other => return Err(other.unexpected()),
        }
    }
    Ok(Cmd::Service { action, system, no_tray })
}

fn update(p: &mut lexopt::Parser) -> Result<Cmd, lexopt::Error> {
    let (mut check, mut yes) = (false, false);
    while let Some(arg) = p.next()? {
        match arg {
            Long("check") => check = true,
            Long("yes") | Short('y') => yes = true,
            other => return Err(other.unexpected()),
        }
    }
    Ok(Cmd::Update { check, yes })
}

fn logs(p: &mut lexopt::Parser) -> Result<Cmd, lexopt::Error> {
    let (mut follow, mut lines) = (false, 200);
    while let Some(arg) = p.next()? {
        match arg {
            Long("follow") | Short('f') => follow = true,
            Long("lines") | Short('n') => lines = p.value()?.parse::<usize>()?.clamp(1, 2000),
            other => return Err(other.unexpected()),
        }
    }
    Ok(Cmd::Logs { follow, lines })
}
