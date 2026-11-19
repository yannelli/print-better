//! `tray on|off`, `pause`/`resume`, and `config get|set`: through the daemon when it runs
//! (applied at once and synced to the server), else straight into the config file.

use super::{Failure, Outcome};
use crate::local::client::{self, LocalError};
use crate::paths::Paths;
use crate::proto::ClientSettings;
use crate::{clock, settings, store};
use serde_json::{Value, json};

pub fn tray(on: bool) -> Outcome {
    apply(&json!({ "tray": on }))?;
    if on {
        println!("The icon is turned on. It appears within a few seconds while Print Better runs.");
    } else {
        println!("The icon is hidden. Bring it back any time with: printbetter tray on");
    }
    Ok(())
}

pub fn pause(paused: bool) -> Outcome {
    apply(&json!({ "paused": paused }))?;
    if paused {
        println!("Printing is paused on this device. New jobs wait until you run: printbetter resume");
    } else {
        println!("Printing resumed.");
    }
    Ok(())
}

pub fn get(key: Option<&str>) -> Outcome {
    let current = current()?;
    match key {
        Some(key) => {
            let value = settings::get(&current, key).ok_or_else(|| Failure::usage(format!("Unknown setting \"{key}\".")))?;
            println!("{}", display(&value));
        }
        None => {
            for (key, value) in settings::flatten(&current) {
                println!("{key} = {}", display(&value));
            }
        }
    }
    Ok(())
}

pub fn set(key: &str, raw: &str) -> Outcome {
    let patch = settings::patch_for(&current()?, key, raw).map_err(Failure::usage)?;
    apply(&patch)?;
    println!("{key} = {raw}");
    Ok(())
}

fn apply(patch: &Value) -> Outcome {
    match client::post("/api/settings", patch) {
        Ok(_) => Ok(()),
        Err(LocalError::NotRunning) => {
            let paths = Paths::resolve();
            let mut config = store::load_config(&paths);
            config.settings = settings::apply(&config.settings, patch).map_err(Failure::usage)?;
            config.settings_updated_at = clock::now_ms().max(config.settings_updated_at + 1);
            store::save_config(&paths, &config).map_err(|e| Failure::error(format!("Could not save settings: {e}")))
        }
        Err(LocalError::Api { status: 400, message }) => Err(Failure::usage(message)),
        Err(e) => Err(e.into()),
    }
}

fn current() -> Result<ClientSettings, Failure> {
    match client::get("/api/settings") {
        Ok(value) => serde_json::from_value(value).map_err(|e| Failure::error(e.to_string())),
        Err(LocalError::NotRunning) => Ok(store::load_config(&Paths::resolve()).settings),
        Err(e) => Err(e.into()),
    }
}

fn display(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(true) => "on".into(),
        Value::Bool(false) => "off".into(),
        Value::Null => "none".into(),
        Value::Array(items) if items.is_empty() => "none".into(),
        Value::Array(items) => items.iter().map(display).collect::<Vec<_>>().join(","),
        other => other.to_string(),
    }
}
