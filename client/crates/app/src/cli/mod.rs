//! `printbetter` entry point: parse, dispatch, and map failures to exit codes.

mod info;
mod pair;
mod parse;
#[cfg(test)]
mod parse_tests;
mod print;
mod run;
mod settings;
mod update;

use crate::local::client::LocalError;
use crate::{logger, service};
use parse::Cmd;
use std::ffi::OsString;
use std::future::Future;
use std::io::{IsTerminal, Write};

pub const EXIT_ERROR: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_NOT_PAIRED: i32 = 3;
pub const EXIT_NO_DAEMON: i32 = 4;

const HELP: &str = "\
Print Better: reliable printing from anywhere

Usage: printbetter <command> [options]

  run [--no-tray]                    Start Print Better (with its menu bar / tray icon)
  pair --server URL [--token pbe_...] [--name NAME]
                                     Connect this device to your Print Better server
  unpair [--yes]                     Disconnect this device from the server
  status [--json]                    Connection, device name, printers, and queue
  printers [--json]                  Printers known to Print Better
  discover [--json] [--timeout SECS] Look for printers now (works without a server)
  print FILE [--printer KEY|NAME] [--copies N] [--media NAME]
             [--sides one|long|short] [--color|--mono]
  tray on|off                        Show or hide the menu bar / tray icon
  pause | resume                     Hold or release printing on this device
  config get [KEY] | set KEY VALUE   Local settings, e.g. config set discovery.snmp off
  service install [--system] [--no-tray] | uninstall [--system]
          | start | stop | restart | status
                                     Start Print Better automatically
  logs [--follow] [--lines N]        Show recent log lines
  doctor [--json]                    Check connection, clock, storage, and printers
  update [--check] [--yes]           Install the newest Print Better from your server
  version | help

Exit codes: 0 ok, 1 error, 2 usage, 3 not paired, 4 Print Better not running.
Environment: PRINTBETTER_HOME (data folder), PRINTBETTER_LOG=debug.
";

pub struct Failure {
    pub code: i32,
    pub message: String,
}

impl Failure {
    pub fn error(message: impl Into<String>) -> Failure {
        Failure { code: EXIT_ERROR, message: message.into() }
    }

    pub fn usage(message: impl Into<String>) -> Failure {
        Failure { code: EXIT_USAGE, message: message.into() }
    }

    pub fn not_paired() -> Failure {
        Failure { code: EXIT_NOT_PAIRED, message: "This device is not paired. Run: printbetter pair --server URL".into() }
    }

    pub fn no_daemon() -> Failure {
        let message = "Print Better is not running. Start it with: printbetter service start (or printbetter run)";
        Failure { code: EXIT_NO_DAEMON, message: message.into() }
    }
}

impl From<LocalError> for Failure {
    fn from(e: LocalError) -> Failure {
        match e {
            LocalError::NotRunning => Failure::no_daemon(),
            other => Failure::error(other.to_string()),
        }
    }
}

pub type Outcome = Result<(), Failure>;

pub fn main(has_console: bool) -> i32 {
    // Finder passes a process serial number on old macOS versions.
    let args: Vec<OsString> = std::env::args_os().skip(1).filter(|a| !a.to_string_lossy().starts_with("-psn_")).collect();
    let cmd = match parse::parse(args) {
        Ok(cmd) => cmd,
        Err(e) => {
            eprintln!("printbetter: {e}\nRun \"printbetter help\" for usage.");
            return EXIT_USAGE;
        }
    };
    if !matches!(cmd, Cmd::Run { .. } | Cmd::TrayUi | Cmd::Bare) {
        logger::init(None, true, log::LevelFilter::Warn);
    }
    let outcome = match cmd {
        Cmd::Bare if !has_console || !crate::platform::stdio_is_terminal() => run::run(false, true),
        Cmd::Bare => Err(Failure::usage(HELP)),
        Cmd::Run { no_tray } => run::run(no_tray, false),
        Cmd::TrayUi => run::tray_ui(),
        Cmd::Pair { server, token, name } => pair::pair(&server, token.as_deref(), name.as_deref()),
        Cmd::Unpair { yes } => pair::unpair(yes),
        Cmd::Status { json } => info::status(json),
        Cmd::Printers { json } => info::printers(json),
        Cmd::Discover { json, timeout } => print::discover(json, timeout),
        Cmd::Print { file, params } => print::print(&file, params),
        Cmd::Tray { on } => settings::tray(on),
        Cmd::Pause { paused } => settings::pause(paused),
        Cmd::ConfigGet { key } => settings::get(key.as_deref()),
        Cmd::ConfigSet { key, value } => settings::set(&key, &value),
        Cmd::Service { action, system, no_tray } => service::run(action, system, no_tray),
        Cmd::Logs { follow, lines } => info::logs(follow, lines),
        Cmd::Doctor { json } => info::doctor(json),
        Cmd::Update { check, yes } => update::update(check, yes),
        Cmd::UpdateHelper => update::helper(),
        Cmd::Version => {
            println!("printbetter {}", crate::VERSION);
            Ok(())
        }
        Cmd::Help => {
            print!("{HELP}");
            Ok(())
        }
    };
    match outcome {
        Ok(()) => 0,
        Err(failure) => {
            if !failure.message.is_empty() {
                eprintln!("{}", failure.message.trim_end());
            }
            failure.code
        }
    }
}

/// Runs async work for one-shot commands on a throwaway current-thread runtime.
pub fn block_on<F: Future>(future: F) -> Result<F::Output, Failure> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map(|runtime| runtime.block_on(future))
        .map_err(|e| Failure::error(format!("Could not start: {e}")))
}

/// Asks a yes/no question on the terminal; without one, fails with `no_tty` as the usage hint.
pub fn confirm(question: &str, no_tty: &str) -> Result<bool, Failure> {
    if !std::io::stdin().is_terminal() {
        return Err(Failure::usage(no_tty));
    }
    print!("{question}");
    let _ = std::io::stdout().flush();
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer).map_err(|e| Failure::error(e.to_string()))?;
    Ok(answer.trim().to_ascii_lowercase().starts_with('y'))
}

pub fn print_json(value: &impl serde::Serialize) {
    match serde_json::to_string_pretty(value) {
        Ok(text) => println!("{text}"),
        Err(e) => eprintln!("printbetter: {e}"),
    }
}
