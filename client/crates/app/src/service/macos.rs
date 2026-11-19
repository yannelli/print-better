//! launchd: a LaunchAgent per user, or a root LaunchDaemon plus a per-user tray agent.
//! The root daemon is exempt from Local Network prompts; the tray agent never touches the LAN.

use super::{Action, SYSTEM_ALREADY, command, remove, report, require_root, takeover, templates, write};
use crate::cli::{Failure, Outcome};
use crate::platform;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

const LABEL: &str = "dev.yannelli.printbetter";
const TRAY_LABEL: &str = "dev.yannelli.printbetter.tray";
const DAEMON_PLIST: &str = "/Library/LaunchDaemons/dev.yannelli.printbetter.plist";
const TRAY_PLIST: &str = "/Library/LaunchAgents/dev.yannelli.printbetter.tray.plist";

pub fn run(action: Action, system: bool, no_tray: bool) -> Outcome {
    let system = system || (action != Action::Install && Path::new(DAEMON_PLIST).exists() && !user_plist().exists());
    let target = format!("{}/{LABEL}", domain(system));
    match action {
        Action::Install if system => install_system(no_tray),
        Action::Install => install_user(no_tray),
        Action::Uninstall => uninstall(system),
        Action::Start => {
            let plist = if system { PathBuf::from(DAEMON_PLIST) } else { user_plist() };
            if !plist.exists() {
                return report("", None, "");
            }
            if command("launchctl", &["kickstart", &target]).is_err() {
                bootstrap(&domain(system), &plist)?;
            }
            println!("Started.");
            Ok(())
        }
        Action::Stop => {
            command("launchctl", &["kill", "SIGTERM", &target])?;
            println!("Stopped. It starts again at the next login, or with: printbetter service start");
            Ok(())
        }
        Action::Restart => {
            command("launchctl", &["kickstart", "-k", &target])?;
            println!("Restarted.");
            Ok(())
        }
        Action::Status => {
            let installed = if system { Path::new(DAEMON_PLIST).exists() } else { user_plist().exists() };
            let info = super::output("launchctl", &["print", &target]);
            let running = info.lines().any(|l| l.trim() == "state = running");
            let pid = info.lines().find_map(|l| l.trim().strip_prefix("pid = ")).map(|p| format!(" (pid {p})"));
            let kind = if system { "system LaunchDaemon" } else { "LaunchAgent" };
            report(kind, installed.then_some(running), &pid.unwrap_or_default())
        }
    }
}

fn install_user(no_tray: bool) -> Outcome {
    if Path::new(DAEMON_PLIST).exists() {
        println!("{SYSTEM_ALREADY}");
        return Ok(());
    }
    if platform::is_root() {
        return Err(Failure::usage("Run this without sudo, or add --system for a machine-wide install."));
    }
    let plist = templates::launch_agent(&super::exe()?, no_tray);
    let path = user_plist();
    write(&path, plist.as_bytes())?;
    let _ = command("launchctl", &["bootout", &format!("{}/{LABEL}", domain(false))]);
    bootstrap(&domain(false), &path)?;
    println!("Installed. Print Better is running and starts whenever you log in.");
    Ok(())
}

fn install_system(no_tray: bool) -> Outcome {
    require_root("A machine-wide install")?;
    let exe = super::exe()?;
    let agents = takeover::find("/Users", &format!("Library/LaunchAgents/{LABEL}.plist"));
    for agent in &agents {
        if let Ok(meta) = std::fs::metadata(&agent.file) {
            let _ = command("launchctl", &["bootout", &format!("gui/{}/{LABEL}", meta.uid())]);
        }
    }
    takeover::finish(&agents)?;
    write(Path::new(DAEMON_PLIST), templates::launch_daemon(&exe).as_bytes())?;
    let _ = command("launchctl", &["bootout", &format!("system/{LABEL}")]);
    bootstrap("system", Path::new(DAEMON_PLIST))?;
    let console = console_uid();
    if let Some(uid) = console {
        let _ = command("launchctl", &["bootout", &format!("gui/{uid}/{TRAY_LABEL}")]);
    }
    if no_tray {
        remove(Path::new(TRAY_PLIST))?;
    } else {
        write(Path::new(TRAY_PLIST), templates::tray_agent(&exe).as_bytes())?;
        if let Some(uid) = console {
            let _ = bootstrap(&format!("gui/{uid}"), Path::new(TRAY_PLIST));
        }
    }
    println!("Installed for all users. Print Better runs in the background from startup.");
    Ok(())
}

fn uninstall(system: bool) -> Outcome {
    if system {
        require_root("Removing the machine-wide install")?;
        let _ = command("launchctl", &["bootout", &format!("system/{LABEL}")]);
        remove(Path::new(DAEMON_PLIST))?;
        if let Some(uid) = console_uid() {
            let _ = command("launchctl", &["bootout", &format!("gui/{uid}/{TRAY_LABEL}")]);
        }
        remove(Path::new(TRAY_PLIST))?;
    } else {
        let _ = command("launchctl", &["bootout", &format!("{}/{LABEL}", domain(false))]);
        remove(&user_plist())?;
    }
    println!("Removed. Print Better no longer starts automatically; your pairing and settings are kept.");
    Ok(())
}

/// `bootstrap` right after `bootout` can fail while launchd is still tearing the job down.
fn bootstrap(domain: &str, plist: &Path) -> Outcome {
    let plist = plist.to_string_lossy();
    let mut result = command("launchctl", &["bootstrap", domain, &plist]);
    for _ in 0..10 {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
        result = command("launchctl", &["bootstrap", domain, &plist]);
    }
    result.map(drop)
}

fn domain(system: bool) -> String {
    if system {
        "system".into()
    } else {
        // SAFETY: getuid has no preconditions and cannot fail.
        format!("gui/{}", unsafe { libc::getuid() })
    }
}

fn user_plist() -> PathBuf {
    std::env::home_dir()
        .unwrap_or_default()
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist"))
}

/// The user at the login window owns /dev/console; root means nobody is logged in.
fn console_uid() -> Option<u32> {
    std::fs::metadata("/dev/console").ok().map(|m| m.uid()).filter(|uid| *uid != 0)
}
