//! `run` (daemon, plus the tray when there is a desktop) and the hidden `tray-ui`.

use super::{Failure, Outcome};
use crate::paths::Paths;
use crate::{daemon, first_run, local, logger, platform, store, tray};
use std::time::Duration;

pub fn run(no_tray: bool, gui_launch: bool) -> Outcome {
    let paths = Paths::resolve();
    let to_stderr = platform::stdio_is_terminal() || std::env::var_os("JOURNAL_STREAM").is_some();
    logger::init(Some(paths.log_file()), to_stderr, log::LevelFilter::Info);
    let listener = match local::bind() {
        Ok(listener) => listener,
        Err(_) if local::client::is_running() => {
            if gui_launch {
                platform::open_url(&local::page_url());
                return Ok(());
            }
            // Non-zero, so a service manager that lost the race (e.g. mid-upgrade) retries later.
            return Err(Failure::error("Print Better is already running."));
        }
        Err(e) => {
            return Err(Failure::error(format!("Could not open port {} for the status page: {e}", local::port())));
        }
    };
    if gui_launch && store::load_credentials(&paths).is_none() {
        // Launched from Finder/Explorer: open the pairing page once the API is up.
        first_run::remember(&paths);
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(1));
            platform::open_url(&local::page_url());
        });
    }
    let tray_capable = !no_tray && tray::SUPPORTED && platform::gui_session();
    if !(tray_capable && store::load_config(&paths).settings.tray) {
        return exit(daemon::run_blocking(paths, listener, tray_capable, false));
    }
    // The tray owns the main thread (AppKit requires it); the daemon exits the process itself.
    let daemon = std::thread::Builder::new()
        .name("daemon".into())
        .spawn(move || std::process::exit(daemon::run_blocking(paths, listener, true, true)))
        .map_err(|e| Failure::error(format!("Could not start: {e}")))?;
    tray::run(true);
    log::warn!("the tray icon could not start; Print Better keeps running without it");
    let _ = daemon.join();
    Ok(())
}

pub fn tray_ui() -> Outcome {
    if !tray::SUPPORTED {
        return Err(Failure::error("This build of Print Better has no tray icon."));
    }
    let paths = Paths::resolve();
    logger::init(Some(paths.logs.join("tray.log")), platform::stdio_is_terminal(), log::LevelFilter::Info);
    tray::run(false);
    Ok(())
}

fn exit(code: i32) -> Outcome {
    if code == 0 { Ok(()) } else { Err(Failure { code, message: String::new() }) }
}
