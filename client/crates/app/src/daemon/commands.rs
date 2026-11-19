//! Hub `command`s that run in the background; each produces exactly one `result`.

use super::{Daemon, diagnose, inventory, updater};
use crate::{logger, print_error};
use crate::proto::ClientMsg;
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

pub async fn run(d: Arc<Daemon>, id: String, name: String, args: Value) {
    let result = AssertUnwindSafe(execute(&d, &name, &args))
        .catch_unwind()
        .await
        .unwrap_or_else(|_| Err("Print Better hit an internal error running this command.".into()));
    log::debug!("command {name} ({id}) finished");
    let reply = match result {
        Ok(data) => ClientMsg::Result { id, ok: true, data: Some(data), error: None },
        Err(error) => ClientMsg::Result { id, ok: false, data: None, error: Some(error) },
    };
    d.outbox.send(reply);
}

async fn execute(d: &Arc<Daemon>, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "discover" => Ok(json!({ "count": inventory::discover(d, true, None).await })),
        "refresh" => {
            let key = args.get("key").and_then(Value::as_str);
            Ok(json!({ "count": inventory::refresh(d, key).await }))
        }
        "identify" => identify(d, args).await,
        "logs" => {
            let lines = args.get("lines").and_then(Value::as_u64).unwrap_or(200).clamp(1, 2000);
            let lines = usize::try_from(lines).unwrap_or(200);
            Ok(json!({ "lines": logger::tail(&d.paths.log_file(), lines) }))
        }
        "diagnose" => Ok(json!({ "checks": diagnose::for_daemon(d).await })),
        "update" => updater::request(d).await.map(|(from, to)| json!({ "from": from, "to": to })),
        other => Err(format!("Unknown command \"{other}\".")),
    }
}

async fn identify(d: &Daemon, args: &Value) -> Result<Value, String> {
    let key = args.get("key").and_then(Value::as_str).ok_or("Missing printer key.")?;
    let printer = d.printer_report(key).ok_or("That printer is not available right now.")?;
    d.engine.identify(&printer).await.map_err(|e| print_error::sentence(&e))?;
    Ok(json!({}))
}

/// Answers a command that must reply before acting (restart, unpair).
pub fn ok(id: String) -> ClientMsg {
    ClientMsg::Result { id, ok: true, data: Some(json!({})), error: None }
}
