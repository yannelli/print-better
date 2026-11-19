#![cfg_attr(windows, windows_subsystem = "windows")]

mod choose;
mod cli;
mod clock;
mod daemon;
mod doc;
mod first_run;
mod fsx;
mod local;
mod logger;
mod net;
mod pairing;
mod paths;
mod platform;
mod print_error;
mod proto;
mod query;
mod queue;
mod service;
mod settings;
mod store;
#[cfg(test)]
mod test_util;
mod tray;
mod update;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let has_console = platform::attach_console();
    std::process::exit(cli::main(has_console));
}
