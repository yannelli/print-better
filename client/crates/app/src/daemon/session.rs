//! The WebSocket session with the WorkspaceHub: hello/welcome, heartbeat, reconnect.

use super::{Conn, Daemon, commands, inventory};
use crate::net::ws::{self, ConnectError, Socket};
use crate::net::ServerUrl;
use crate::proto::{ClientMsg, PING, PING_INTERVAL_SECS, PONG, PONG_TIMEOUT_SECS, ServerMsg};
use crate::store::Credentials;
use futures_util::{SinkExt, StreamExt};
use std::hash::BuildHasher;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::{Instant, interval_at, sleep, sleep_until, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

const WELCOME_TIMEOUT: Duration = Duration::from_secs(20);
const STABLE_AFTER: Duration = Duration::from_secs(60);

enum End {
    Lost(String),
    Revoked,
    Replaced,
    /// Credentials changed (paired again or unpaired): reconnect at once.
    Reconnect,
    Stop,
}

pub async fn run(d: Arc<Daemon>) {
    let mut outbox = d.outbox_rx.lock().await;
    let mut attempt = 0u32;
    loop {
        let creds = d.credentials().filter(|c| !d.is_halted(&c.token));
        let Some(creds) = creds else {
            if d.credentials().is_none() {
                d.set_conn(Conn::Unpaired, None);
            }
            tokio::select! {
                _ = d.wake.session.notified() => continue,
                _ = d.stopping.canceled() => return,
            }
        };
        let url = match ServerUrl::parse(&creds.server) {
            Ok(url) => url,
            Err(e) => {
                d.set_conn(Conn::Offline, Some(e));
                tokio::select! {
                    _ = d.wake.session.notified() => continue,
                    _ = d.stopping.canceled() => return,
                }
            }
        };
        d.set_conn(Conn::Connecting, None);
        let started = Instant::now();
        let end = session(&d, &url, &creds, &mut outbox).await;
        d.outbox.set_online(false);
        match end {
            End::Stop => return,
            End::Reconnect => attempt = 0,
            End::Revoked => {
                log::warn!("the server no longer accepts this device's pairing");
                let detail = "This device was removed from Print Better. Pair it again to keep printing.";
                d.halt(&creds.token, Conn::Revoked, detail);
            }
            End::Replaced => {
                log::warn!("another Print Better connected with this device's pairing; standing down");
                let detail = "Another copy of Print Better is using this device's pairing. Restart this one or pair it again.";
                d.halt(&creds.token, Conn::Replaced, detail);
            }
            End::Lost(reason) => {
                if started.elapsed() >= STABLE_AFTER {
                    attempt = 0;
                }
                let delay = backoff(attempt);
                attempt = attempt.saturating_add(1);
                log::info!("disconnected ({reason}); retrying in {} s", delay.as_secs());
                d.set_conn(Conn::Offline, Some(reason));
                tokio::select! {
                    _ = sleep(delay) => {}
                    _ = d.wake.session.notified() => {}
                    _ = d.stopping.canceled() => return,
                }
            }
        }
    }
}

async fn session(d: &Arc<Daemon>, url: &ServerUrl, creds: &Credentials, outbox: &mut UnboundedReceiver<ClientMsg>) -> End {
    let mut socket = match ws::connect(url, &creds.token).await {
        Ok(socket) => socket,
        Err(ConnectError::Unauthorized) => return End::Revoked,
        Err(ConnectError::Failed(e)) => return End::Lost(e),
    };
    while outbox.try_recv().is_ok() {}
    if let Err(e) = send(&mut socket, &d.hello()).await {
        return End::Lost(e);
    }
    let mut welcomed = false;
    let mut deadline = Some(Instant::now() + WELCOME_TIMEOUT);
    let every = Duration::from_secs(PING_INTERVAL_SECS);
    let mut ping = interval_at(Instant::now() + every, every);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let wait = deadline.unwrap_or_else(|| Instant::now() + Duration::from_secs(3600));
        tokio::select! {
            incoming = socket.next() => match incoming {
                None => return End::Lost("the server closed the connection".into()),
                Some(Err(e)) => return End::Lost(e.to_string()),
                Some(Ok(Message::Text(text))) if text.as_str() == PONG => {
                    if welcomed {
                        deadline = None;
                    }
                }
                Some(Ok(Message::Text(text))) => {
                    let msg = match serde_json::from_str::<ServerMsg>(text.as_str()) {
                        Ok(msg) => msg,
                        Err(e) => {
                            log::warn!("ignoring malformed message from the server: {e}");
                            continue;
                        }
                    };
                    if !welcomed && matches!(msg, ServerMsg::Welcome { .. }) {
                        welcomed = true;
                        deadline = None;
                    }
                    if let Some(end) = handle(d, &mut socket, msg).await {
                        return end;
                    }
                }
                Some(Ok(Message::Close(frame))) => return closed(frame),
                Some(Ok(_)) => {}
            },
            Some(msg) = outbox.recv() => {
                if let Err(e) = send(&mut socket, &msg).await {
                    return End::Lost(e);
                }
            }
            _ = ping.tick() => {
                if let Err(e) = socket.send(Message::text(PING)).await {
                    return End::Lost(e.to_string());
                }
                if welcomed && deadline.is_none() {
                    deadline = Some(Instant::now() + Duration::from_secs(PONG_TIMEOUT_SECS));
                }
            }
            _ = sleep_until(wait), if deadline.is_some() => {
                let why = if welcomed { "the server stopped answering" } else { "the server did not say hello" };
                return End::Lost(why.into());
            }
            _ = d.wake.session.notified() => {
                if d.credentials().is_none_or(|c| c.token != creds.token) {
                    close(&mut socket).await;
                    return End::Reconnect;
                }
            }
            _ = d.stopping.canceled() => {
                close(&mut socket).await;
                return End::Stop;
            }
        }
    }
}

async fn handle(d: &Arc<Daemon>, socket: &mut Socket, msg: ServerMsg) -> Option<End> {
    match msg {
        ServerMsg::Welcome { name, settings, settings_updated_at, server_time, printers, .. } => {
            log::info!("connected as \"{name}\"");
            d.outbox.set_online(true);
            d.on_welcome(name, settings, settings_updated_at, server_time, printers);
            d.set_conn(Conn::Online, None);
            d.queue.resync();
            if let Some(snapshot) = inventory::snapshot_message(d) {
                d.outbox.send(snapshot);
            }
            if let Some(report) = super::system_printers_message(d) {
                d.outbox.send(report);
            }
        }
        ServerMsg::Job { job } => d.queue.offer(job, d.server_time_ms()),
        ServerMsg::Cancel { job_id } => {
            d.queue.cancel(&job_id, d.server_time_ms());
        }
        ServerMsg::Settings { settings, updated_at } => d.apply_server_settings(settings, updated_at),
        ServerMsg::PrinterConfig { printers } => d.set_printer_configs(printers),
        ServerMsg::RemotePrinters { printers, direct } => {
            d.set_direct_printers(direct);
            d.set_remote_printers(printers);
        }
        ServerMsg::Command { id, name, args } => match name.as_str() {
            "restart" => {
                let _ = send(socket, &commands::ok(id)).await;
                close(socket).await;
                d.stop(true, "restart requested from the dashboard");
                return Some(End::Stop);
            }
            "unpair" => {
                let _ = send(socket, &commands::ok(id)).await;
                close(socket).await;
                d.forget_credentials();
                return Some(End::Reconnect);
            }
            _ => {
                tokio::task::spawn_local(commands::run(d.clone(), id, name, args));
            }
        },
        ServerMsg::Unknown => log::debug!("ignoring a message type this version does not know"),
    }
    None
}

async fn send(socket: &mut Socket, msg: &ClientMsg) -> Result<(), String> {
    let text = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    socket.send(Message::text(text)).await.map_err(|e| e.to_string())
}

async fn close(socket: &mut Socket) {
    let _ = timeout(Duration::from_secs(2), socket.close(None)).await;
}

fn closed(frame: Option<CloseFrame>) -> End {
    let Some(frame) = frame else { return End::Lost("the server closed the connection".into()) };
    match u16::from(frame.code) {
        4401 => End::Revoked,
        4409 => End::Replaced,
        code if frame.reason.is_empty() => End::Lost(format!("the server closed the connection ({code})")),
        code => End::Lost(format!("the server closed the connection ({code}: {})", frame.reason)),
    }
}

/// 1 s doubling to 60 s, jittered between half and full so many clients don't reconnect in step.
fn backoff(attempt: u32) -> Duration {
    let full_ms = (1000u64 << attempt.min(6)).min(60_000);
    let jitter = std::collections::hash_map::RandomState::new().hash_one(attempt) % (full_ms / 2 + 1);
    Duration::from_millis(full_ms / 2 + jitter)
}
