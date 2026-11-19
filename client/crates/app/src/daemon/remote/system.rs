//! Read-only questions for the print system: the default queue, each queue's device, and
//! whether macOS opens the print window on the last printer used.

use std::path::Path;
use std::process::{Command, Stdio};

/// Runs lpstat without macOS "last used" defaults, in the C locale (`SOFTWARE` makes macOS CUPS honor `LANG`).
pub fn lpstat(path: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new(path)
        .args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("SOFTWARE", "1")
        .env("CUPS_DISABLE_APPLE_DEFAULT", "1")
        .env("CUPS_NO_APPLE_DEFAULT", "1")
        .env_remove("LPDEST")
        .env_remove("PRINTER")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let said = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if said.is_empty() { format!("lpstat exited with {}", out.status) } else { said })
}

/// "system default destination: NAME[/instance]" in any language, or None when there is no default.
pub fn parse_default(out: &str) -> Option<String> {
    let name = out.lines().find_map(|l| l.split_once(": "))?.1.trim();
    name.split('/').next().filter(|n| !n.is_empty()).map(String::from)
}

/// The "Description:" line of `lpstat -l -p NAME`: the name people see in print windows.
pub fn parse_description(out: &str) -> Option<String> {
    let line = out.lines().map(str::trim).find_map(|l| l.strip_prefix("Description:"))?;
    Some(line.trim().to_string()).filter(|d| !d.is_empty())
}

/// "device for NAME: URI" lines; queue names have no spaces, so NAME is the last word before ": ".
pub fn parse_devices(out: &str) -> Vec<(String, String)> {
    out.lines()
        .filter_map(|line| {
            let (left, uri) = line.split_once(": ")?;
            Some((left.rsplit(' ').next()?.to_string(), uri.trim().to_string()))
        })
        .collect()
}

/// The printer uuid a device URI names (`dnssd://…/?uuid=…`, as macOS and cups-browsed write them).
pub fn device_uuid(uri: &str) -> Option<String> {
    let query = uri.split_once('?')?.1;
    let uuid = query.split('&').find_map(|pair| pair.strip_prefix("uuid="))?;
    let bare = uuid.trim_start_matches("urn:uuid:").to_ascii_lowercase();
    (!bare.is_empty()).then_some(bare)
}

/// The queue on this computer whose device is the printer with `uuid`, ignoring Print Better's own.
pub fn native_queue(devices: &[(String, String)], uuid: Option<&str>) -> Option<String> {
    let uuid = uuid?.to_ascii_lowercase();
    devices
        .iter()
        .find(|(queue, uri)| !queue.starts_with(super::cups::PREFIX) && device_uuid(uri).as_deref() == Some(uuid.as_str()))
        .map(|(queue, _)| queue.clone())
}

/// The signed-in user's UseLastPrinter, else the computer-wide one; CUPS treats a missing value as on.
#[cfg(target_os = "macos")]
pub fn last_printer_used() -> bool {
    let user = console_home().map(|home| format!("{home}/Library/Preferences/org.cups.PrintingPrefs"));
    user.and_then(|domain| use_last_printer(&domain))
        .or_else(|| use_last_printer("/Library/Preferences/org.cups.PrintingPrefs"))
        .unwrap_or(true)
}

#[cfg(not(target_os = "macos"))]
pub fn last_printer_used() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn use_last_printer(domain: &str) -> Option<bool> {
    let out = Command::new("/usr/bin/defaults").args(["read", domain, "UseLastPrinter"]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    match String::from_utf8_lossy(&out.stdout).trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" => Some(true),
        "0" | "false" | "no" => Some(false),
        _ => None,
    }
}

/// Home folder of the user at the login window, who owns /dev/console (root means nobody).
#[cfg(target_os = "macos")]
fn console_home() -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let uid = std::fs::metadata("/dev/console").ok()?.uid();
    if uid == 0 {
        return None;
    }
    let out = Command::new("/usr/bin/id").args(["-P", &uid.to_string()]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    let entry = String::from_utf8_lossy(&out.stdout).trim().to_string();
    entry.split(':').nth(8).filter(|home| home.starts_with('/')).map(String::from)
}
