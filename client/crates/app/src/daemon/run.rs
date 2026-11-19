//! Daemon lifecycle: start the subsystems on a current-thread runtime, supervise, shut down.

use super::{Daemon, inventory, remote, session, share, updater};
use crate::paths::Paths;
use crate::platform;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::{JoinHandle, LocalSet, spawn_local};
use tokio::time::{sleep, timeout};

const GRACE: Duration = Duration::from_secs(3);

/// Runs until quit or a signal; returns the process exit code (or re-executes on restart).
pub fn run_blocking(paths: Paths, listener: std::net::TcpListener, tray_capable: bool, tray_running: bool) -> i32 {
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(e) => {
            log::error!("could not start the async runtime: {e}");
            return 1;
        }
    };
    let d = Arc::new(Daemon::new(paths, tray_capable, tray_running));
    let local = LocalSet::new();
    local.block_on(&runtime, serve(d.clone(), listener));
    drop(local);
    // A blocking call stuck in a printer driver must not hold up exit or restart.
    runtime.shutdown_timeout(GRACE);
    if d.restart_requested() {
        let e = platform::restart_self();
        log::error!("could not restart: {e}");
        return 1;
    }
    log::info!("stopped");
    0
}

async fn serve(d: Arc<Daemon>, listener: std::net::TcpListener) {
    log::info!("Print Better {} starting (data in {})", crate::VERSION, d.paths.state.display());
    let tasks = vec![
        supervise("session", d.clone(), session::run),
        supervise("queue", d.clone(), crate::queue::runner::run),
        supervise("inventory", d.clone(), inventory::run),
        supervise("lan-share", d.clone(), share::run),
        supervise("remote-printers", d.clone(), remote::run),
        supervise("updater", d.clone(), updater::run),
        spawn_local(crate::local::serve(d.clone(), listener)),
    ];
    tokio::select! {
        _ = d.stopping.canceled() => {}
        _ = shutdown_signal() => d.stop(false, "signal received"),
    }
    // Lets the session send its close frame and LAN sharing withdraw its adverts.
    let _ = timeout(GRACE, futures_util::future::join_all(tasks)).await;
}

/// Restarts a subsystem that panicked, so one bug can't silently stop printing.
fn supervise<F, Fut>(name: &'static str, d: Arc<Daemon>, task: F) -> JoinHandle<()>
where
    F: Fn(Arc<Daemon>) -> Fut + 'static,
    Fut: Future<Output = ()> + 'static,
{
    spawn_local(async move {
        loop {
            match spawn_local(task(d.clone())).await {
                Err(e) if e.is_panic() && !d.stopping.is_canceled() => {
                    log::error!("{name} crashed ({}); restarting it in 5 s", panic_message(e.into_panic()));
                    sleep(Duration::from_secs(5)).await;
                }
                _ => return,
            }
        }
    })
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into())
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    match (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) {
        (Ok(mut term), Ok(mut int)) => {
            tokio::select! {
                _ = term.recv() => {}
                _ = int.recv() => {}
            }
        }
        _ => std::future::pending().await,
    }
}

#[cfg(windows)]
async fn shutdown_signal() {
    if tokio::signal::ctrl_c().await.is_err() {
        std::future::pending::<()>().await;
    }
}
