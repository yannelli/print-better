//! Percent-encoding for the few query strings the CLI and local API exchange.

use pb_print::{ColorMode, JobOptions, Sides};
use std::collections::HashMap;

pub fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn parse(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(key), decode(value))
        })
        .collect()
}

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok());
        match (bytes[i], hex.and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 3;
            }
            (b'+', _) => {
                out.push(b' ');
                i += 1;
            }
            (byte, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Print options as passed by `printbetter print` (`copies`, `media`, `sides`, `color`).
pub fn job_options(params: &HashMap<String, String>) -> Result<JobOptions, String> {
    let mut options = JobOptions::default();
    if let Some(copies) = params.get("copies") {
        let n = copies.parse::<u32>().ok().filter(|n| (1..=999).contains(n));
        options.copies = Some(n.ok_or("--copies must be a number from 1 to 999")?);
    }
    options.media = params.get("media").filter(|m| !m.trim().is_empty()).cloned();
    if let Some(sides) = params.get("sides") {
        options.sides = Some(match sides.as_str() {
            "one" => Sides::OneSided,
            "long" => Sides::TwoSidedLongEdge,
            "short" => Sides::TwoSidedShortEdge,
            _ => return Err("--sides must be one, long, or short".into()),
        });
    }
    if let Some(color) = params.get("color") {
        options.color_mode = Some(match color.as_str() {
            "color" => ColorMode::Color,
            "mono" => ColorMode::Monochrome,
            _ => return Err("color must be color or mono".into()),
        });
    }
    Ok(options)
}
