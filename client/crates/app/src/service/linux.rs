//! systemd: a user unit, or a hardened system unit running as `printbetter` (group `lp`)
//! with a udev rule for USB printer-class devices.

use super::{Action, SYSTEM_ALREADY, command, output, remove, report, require_root, takeover, templates, write};
use crate::cli::{Failure, Outcome};
use crate::{fsx, platform, update};
use std::path::{Path, PathBuf};

const UNIT: &str = "printbetter.service";
const SYSTEM_UNIT_PATH: &str = "/etc/systemd/system/printbetter.service";
const UDEV_PATH: &str = "/etc/udev/rules.d/60-printbetter.rules";
const UPDATER_PATH: &str = "/etc/systemd/system/printbetter-update.service";
const TRIGGER: &str = "printbetter-update.path";
const SYSTEM_DIRS: [&str; 2] = ["/etc/printbetter", "/var/lib/printbetter"];

pub fn run(action: Action, system: bool, no_tray: bool) -> Outcome {
    let system = system || (action != Action::Install && Path::new(SYSTEM_UNIT_PATH).exists() && !user_unit().exists());
    let done = |message: &str| {
        println!("{message}");
        Ok(())
    };
    match action {
        Action::Install if system => install_system(),
        Action::Install => install_user(no_tray),
        Action::Uninstall => uninstall(system),
        Action::Start => systemctl(system, &["start", UNIT]).and_then(|_| done("Started.")),
        Action::Stop => systemctl(system, &["stop", UNIT]).and_then(|_| done("Stopped.")),
        Action::Restart => systemctl(system, &["restart", UNIT]).and_then(|_| done("Restarted.")),
        Action::Status => {
            let scope: &[&str] = if system { &[] } else { &["--user"] };
            let query = |verb: &str| output("systemctl", &[scope, &[verb, UNIT]].concat());
            let installed = if system { Path::new(SYSTEM_UNIT_PATH).exists() } else { user_unit().exists() };
            let running = query("is-active") == "active";
            let kind = if system { "system service" } else { "user service" };
            report(kind, installed.then_some(running), &format!(", {}", query("is-enabled")))
        }
    }
}

fn install_user(no_tray: bool) -> Outcome {
    if Path::new(SYSTEM_UNIT_PATH).exists() {
        println!("{SYSTEM_ALREADY}");
        return Ok(());
    }
    if platform::is_root() {
        return Err(Failure::usage("As root, add --system for a machine-wide service."));
    }
    write(&user_unit(), templates::user_unit(&super::exe()?, no_tray).as_bytes())?;
    systemctl(false, &["daemon-reload"])?;
    systemctl(false, &["enable", UNIT])?;
    systemctl(false, &["restart", UNIT])?;
    println!("Installed. Print Better is running and starts whenever you log in.");
    println!(
        "To keep printing while nobody is logged in, run: loginctl enable-linger {}",
        platform::user_name()
    );
    Ok(())
}

fn install_system() -> Outcome {
    require_root("A machine-wide install")?;
    let exe = super::exe()?;
    if exe.starts_with("/home") || exe.starts_with("/root") {
        return Err(Failure::error("Move printbetter to /usr/local/bin first: the system service can't read home folders."));
    }
    ensure_user()?;
    for dir in SYSTEM_DIRS {
        std::fs::create_dir_all(dir).map_err(|e| Failure::error(format!("Can't create {dir}: {e}")))?;
    }
    let units = takeover::find("/home", &format!(".config/systemd/user/{UNIT}"));
    for unit in &units {
        // `systemctl --user enable` linked it here; the link would dangle once the unit is gone.
        let _ = fsx::remove_if_exists(&unit.file.with_file_name("default.target.wants").join(UNIT));
    }
    takeover::finish(&units)?;
    // After the takeover, so a carried-over pairing belongs to the service user too.
    command("chown", &[&["-R", "printbetter:printbetter"][..], &SYSTEM_DIRS].concat())?;
    write(Path::new(SYSTEM_UNIT_PATH), templates::system_unit(&exe).as_bytes())?;
    write(Path::new(UPDATER_PATH), templates::update_unit(&exe).as_bytes())?;
    write(Path::new(update::helper::TRIGGER_UNIT), templates::UPDATE_TRIGGER.as_bytes())?;
    write(Path::new(UDEV_PATH), templates::UDEV_RULE.as_bytes())?;
    let _ = command("udevadm", &["control", "--reload"]);
    let _ = command("udevadm", &["trigger", "--subsystem-match=usb", "--action=change"]);
    systemctl(true, &["daemon-reload"])?;
    systemctl(true, &["enable", UNIT, TRIGGER])?;
    systemctl(true, &["restart", TRIGGER])?;
    systemctl(true, &["restart", UNIT])?;
    println!("Installed for this computer. Print Better runs in the background from startup.");
    Ok(())
}

/// Dedicated system user in group `lp`, so it can reach CUPS and USB printers.
fn ensure_user() -> Outcome {
    if command("id", &["-u", "printbetter"]).is_ok() {
        let _ = command("usermod", &["-a", "-G", "lp", "printbetter"]);
        return Ok(());
    }
    let base = ["--system", "--no-create-home", "--home-dir", "/var/lib/printbetter", "--shell", "/usr/sbin/nologin", "--user-group"];
    if command("useradd", &[&base[..], &["--groups", "lp", "printbetter"]].concat()).is_ok() {
        return Ok(());
    }
    command("useradd", &[&base[..], &["printbetter"]].concat()).map(drop)
}

fn uninstall(system: bool) -> Outcome {
    if system {
        require_root("Removing the machine-wide install")?;
        let _ = systemctl(true, &["disable", "--now", UNIT, TRIGGER]);
        remove(Path::new(SYSTEM_UNIT_PATH))?;
        remove(Path::new(UPDATER_PATH))?;
        remove(Path::new(update::helper::TRIGGER_UNIT))?;
        remove(Path::new(UDEV_PATH))?;
        let _ = command("udevadm", &["control", "--reload"]);
        let _ = systemctl(true, &["daemon-reload"]);
        println!("Removed. Settings stay in /etc/printbetter and /var/lib/printbetter.");
    } else {
        let _ = systemctl(false, &["disable", "--now", UNIT]);
        remove(&user_unit())?;
        let _ = systemctl(false, &["daemon-reload"]);
        println!("Removed. Print Better no longer starts automatically; your pairing and settings are kept.");
    }
    Ok(())
}

fn systemctl(system: bool, args: &[&str]) -> Result<String, Failure> {
    let scope: &[&str] = if system { &[] } else { &["--user"] };
    command("systemctl", &[scope, args].concat())
}

fn user_unit() -> PathBuf {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::home_dir().unwrap_or_default().join(".config"));
    config.join("systemd/user").join(UNIT)
}
