//! Dotted-key access to `ClientSettings` for `printbetter config` and the local API.

use crate::proto::ClientSettings;
use pb_print::DiscoverOptions;
use serde_json::{Map, Value};
use std::time::Duration;

const AUTO_ADD: [&str; 4] = ["smart", "all", "none", "inherit"];
const LOG_LEVELS: [&str; 2] = ["info", "debug"];
const NULLABLE: [&str; 1] = ["defaultPrinter"];

/// Every leaf setting as `(dotted.key, value)`, e.g. `("discovery.snmp", true)`.
pub fn flatten(settings: &ClientSettings) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    flatten_into("", &to_value(settings), &mut out);
    out
}

pub fn get(settings: &ClientSettings, key: &str) -> Option<Value> {
    key.split('.').try_fold(to_value(settings), |value, part| value.get(part).cloned())
}

/// `discovery.snmp` + `off` -> `{"discovery":{"snmp":false}}`, typed like the current value.
/// Lists take comma-separated values; `none` empties a list or clears a nullable setting.
pub fn patch_for(settings: &ClientSettings, key: &str, raw: &str) -> Result<Value, String> {
    let none = matches!(raw.trim().to_ascii_lowercase().as_str(), "" | "none");
    let value = match get(settings, key).ok_or_else(|| unknown(key))? {
        Value::Bool(_) => Value::Bool(parse_bool(raw).ok_or_else(|| format!("'{key}' must be on or off"))?),
        Value::Array(_) if none => Value::Array(Vec::new()),
        Value::Array(_) => raw.split(',').map(str::trim).filter(|v| !v.is_empty()).map(|v| Value::String(v.into())).collect(),
        _ if NULLABLE.contains(&key) && none => Value::Null,
        Value::String(_) | Value::Null => Value::String(raw.trim().to_string()),
        _ => return Err(format!("'{key}' is a group; set one of its keys instead")),
    };
    Ok(key.rsplit('.').fold(value, |inner, part| {
        let mut map = Map::new();
        map.insert(part.to_string(), inner);
        Value::Object(map)
    }))
}

/// Deep-merges a partial settings object, rejecting unknown keys and wrong types.
pub fn apply(settings: &ClientSettings, patch: &Value) -> Result<ClientSettings, String> {
    let mut merged = to_value(settings);
    merge(&mut merged, patch, "")?;
    let next: ClientSettings = serde_json::from_value(merged).map_err(|e| e.to_string())?;
    if !AUTO_ADD.contains(&next.auto_add.as_str()) {
        return Err(format!("autoAdd must be one of: {}", AUTO_ADD.join(", ")));
    }
    if !LOG_LEVELS.contains(&next.log_level.as_str()) {
        return Err(format!("logLevel must be one of: {}", LOG_LEVELS.join(", ")));
    }
    Ok(next)
}

/// Discovery sources the user left on (`settings.discovery`).
pub fn discover_options(settings: &ClientSettings, timeout: Option<Duration>) -> DiscoverOptions {
    let toggles = &settings.discovery;
    DiscoverOptions {
        mdns: toggles.mdns,
        snmp: toggles.snmp,
        usb: toggles.usb,
        os: toggles.os,
        timeout: timeout.unwrap_or(DiscoverOptions::default().timeout),
    }
}

pub fn parse_bool(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "on" | "yes" | "1" => Some(true),
        "false" | "off" | "no" | "0" => Some(false),
        _ => None,
    }
}

fn merge(target: &mut Value, patch: &Value, path: &str) -> Result<(), String> {
    let (Value::Object(target), Value::Object(patch)) = (target, patch) else {
        return Err(format!("'{path}' must be an object"));
    };
    for (key, value) in patch {
        let full = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
        let slot = target.get_mut(key).ok_or_else(|| unknown(&full))?;
        if slot.is_object() {
            merge(slot, value, &full)?;
        } else if std::mem::discriminant(slot) == std::mem::discriminant(value) || slot.is_null() || value.is_null() {
            // A nullable setting switches between null and a value; deserializing the result checks the type.
            *slot = value.clone();
        } else {
            return Err(format!("wrong type for '{full}'"));
        }
    }
    Ok(())
}

fn flatten_into(prefix: &str, value: &Value, out: &mut Vec<(String, Value)>) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                let full = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
                flatten_into(&full, inner, out);
            }
        }
        leaf => out.push((prefix.to_string(), leaf.clone())),
    }
}

fn to_value(settings: &ClientSettings) -> Value {
    serde_json::to_value(settings).unwrap_or(Value::Null)
}

fn unknown(key: &str) -> String {
    format!("unknown setting '{key}' (see `printbetter config get`)")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn flatten_and_get_use_dotted_keys() {
        let settings = ClientSettings::default();
        let keys: Vec<String> = flatten(&settings).into_iter().map(|(k, _)| k).collect();
        assert!(keys.contains(&"discovery.snmp".to_string()) && keys.contains(&"logLevel".to_string()));
        assert_eq!(get(&settings, "discovery.usb"), Some(json!(true)));
        assert_eq!(get(&settings, "nope"), None);
    }

    #[test]
    fn patch_for_types_the_value_like_the_current_one() {
        let settings = ClientSettings::default();
        assert_eq!(patch_for(&settings, "discovery.snmp", "off"), Ok(json!({ "discovery": { "snmp": false } })));
        assert_eq!(patch_for(&settings, "logLevel", "debug"), Ok(json!({ "logLevel": "debug" })));
        assert_eq!(patch_for(&settings, "remotePrinters", "off"), Ok(json!({ "remotePrinters": false })));
        assert_eq!(patch_for(&settings, "remotePrintersHidden", "pr_1, pr_2,"), Ok(json!({ "remotePrintersHidden": ["pr_1", "pr_2"] })));
        assert_eq!(patch_for(&settings, "remotePrintersHidden", "none"), Ok(json!({ "remotePrintersHidden": [] })));
        assert_eq!(patch_for(&settings, "defaultPrinter", "pr_1"), Ok(json!({ "defaultPrinter": "pr_1" })));
        let chosen = ClientSettings { default_printer: Some("pr_1".into()), ..ClientSettings::default() };
        assert_eq!(patch_for(&chosen, "defaultPrinter", "none"), Ok(json!({ "defaultPrinter": null })));
        assert!(patch_for(&settings, "tray", "maybe").is_err());
        assert!(patch_for(&settings, "discovery", "on").is_err());
        assert!(patch_for(&settings, "nope", "on").is_err());
    }

    #[test]
    fn apply_deep_merges_and_validates() {
        let settings = ClientSettings::default();
        let next = apply(&settings, &json!({ "discovery": { "usb": false }, "autoAdd": "all" })).unwrap();
        assert!(!next.discovery.usb && next.discovery.mdns);
        assert_eq!(next.auto_add, "all");
        assert!(apply(&settings, &json!({ "discovery": { "bluetooth": true } })).is_err());
        assert!(apply(&settings, &json!({ "paused": "yes" })).is_err());
        assert!(apply(&settings, &json!({ "autoAdd": "sometimes" })).is_err());
        assert!(apply(&settings, &json!({ "logLevel": "trace" })).is_err());
        assert!(apply(&settings, &json!([1])).is_err());
        let chosen = apply(&settings, &json!({ "defaultPrinter": "pr_1", "remotePrintersHidden": ["pr_2"] })).unwrap();
        assert_eq!((chosen.default_printer.as_deref(), chosen.remote_printers_hidden.as_slice()), (Some("pr_1"), &["pr_2".to_string()][..]));
        assert_eq!(apply(&chosen, &json!({ "defaultPrinter": null })).unwrap().default_printer, None);
        assert!(apply(&settings, &json!({ "defaultPrinter": 7 })).is_err());
        assert!(apply(&settings, &json!({ "remotePrintersHidden": [1] })).is_err());
        assert!(apply(&settings, &json!({ "tray": null })).is_err());
    }

    #[test]
    fn booleans_accept_common_spellings() {
        for raw in ["on", "TRUE", " yes ", "1"] {
            assert_eq!(parse_bool(raw), Some(true), "{raw}");
        }
        for raw in ["off", "False", "no", "0"] {
            assert_eq!(parse_bool(raw), Some(false), "{raw}");
        }
        assert_eq!(parse_bool("maybe"), None);
    }
}
