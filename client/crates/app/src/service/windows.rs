//! Windows: an HKCU Run entry (per user) or a startup scheduled task running as SYSTEM.

use super::{Action, SYSTEM_ALREADY, command, copy_pairing, quit_daemon, report, templates, write};
use crate::cli::{Failure, Outcome};
use crate::local::client;
use crate::paths::{self, Paths};
use crate::platform::wide;
use std::path::Path;
use std::process::{Command, Stdio};
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ, RegCloseKey,
    RegCreateKeyExW, RegDeleteValueW, RegGetValueW, RegSetValueExW,
};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "PrintBetter";
const TASK: &str = "Print Better";

pub fn run(action: Action, system: bool, no_tray: bool) -> Outcome {
    let system = system || (action != Action::Install && task_exists() && !run_value_exists());
    match action {
        Action::Install if system => install_system(),
        Action::Install => install_user(no_tray),
        Action::Uninstall if system => {
            let _ = command("schtasks", &["/End", "/TN", TASK]);
            command("schtasks", &["/Delete", "/TN", TASK, "/F"])?;
            println!("Removed. Your pairing and settings are kept.");
            Ok(())
        }
        Action::Uninstall => {
            quit_daemon();
            delete_run_value()?;
            println!("Removed. Print Better no longer starts automatically; your pairing and settings are kept.");
            Ok(())
        }
        Action::Start if system => command("schtasks", &["/Run", "/TN", TASK]).map(|_| println!("Started.")),
        Action::Start => start_user(),
        Action::Stop if system => command("schtasks", &["/End", "/TN", TASK]).map(|_| println!("Stopped.")),
        Action::Stop => {
            quit_daemon();
            println!("Stopped.");
            Ok(())
        }
        Action::Restart if system => {
            let _ = command("schtasks", &["/End", "/TN", TASK]);
            command("schtasks", &["/Run", "/TN", TASK]).map(|_| println!("Restarted."))
        }
        Action::Restart => {
            quit_daemon();
            start_user()
        }
        Action::Status => {
            let installed = if system { task_exists() } else { run_value_exists() };
            let kind = if system { "startup task as SYSTEM" } else { "starts at sign-in" };
            report(kind, installed.then(client::is_running), "")
        }
    }
}

fn install_user(no_tray: bool) -> Outcome {
    if task_exists() {
        println!("{SYSTEM_ALREADY}");
        return Ok(());
    }
    let exe = super::exe()?;
    let command_line = format!("\"{}\" run{}", exe.display(), if no_tray { " --no-tray" } else { "" });
    set_run_value(&command_line)?;
    if !client::is_running() {
        spawn(&exe, no_tray)?;
    }
    println!("Installed. Print Better is running and starts whenever you sign in.");
    Ok(())
}

fn install_system() -> Outcome {
    let exe = super::exe()?;
    // The SYSTEM account has its own data folder; hand it this user's pairing.
    copy_pairing(&Paths::resolve().config, &paths::windows_system_dir())?;
    if run_value_exists() {
        delete_run_value()?;
        quit_daemon();
        println!("Removed the per-user install; the machine-wide service replaces it.");
    }
    let xml = templates::scheduled_task(&exe);
    // schtasks expects the UTF-16 encoding the XML declaration promises.
    let mut bytes = vec![0xFF, 0xFE];
    bytes.extend(xml.encode_utf16().flat_map(u16::to_le_bytes));
    let file = std::env::temp_dir().join("printbetter-task.xml");
    write(&file, &bytes)?;
    let created = command("schtasks", &["/Create", "/TN", TASK, "/XML", &file.to_string_lossy(), "/F"]);
    let _ = std::fs::remove_file(&file);
    created.map_err(|e| Failure::error(format!("{} (run from an administrator PowerShell)", e.message)))?;
    // Re-running upgrades in place: stop the old instance so the task starts the new binary.
    let _ = command("schtasks", &["/End", "/TN", TASK]);
    let _ = command("schtasks", &["/Run", "/TN", TASK]);
    println!("Installed for this computer. Print Better runs in the background from startup.");
    Ok(())
}

fn start_user() -> Outcome {
    if client::is_running() {
        println!("Already running.");
        return Ok(());
    }
    spawn(&super::exe()?, false)?;
    println!("Started.");
    Ok(())
}

fn spawn(exe: &Path, no_tray: bool) -> Outcome {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    let mut cmd = Command::new(exe);
    cmd.arg("run");
    if no_tray {
        cmd.arg("--no-tray");
    }
    cmd.creation_flags(DETACHED_PROCESS).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd.spawn().map(drop).map_err(|e| Failure::error(format!("Could not start Print Better: {e}")))
}

fn task_exists() -> bool {
    command("schtasks", &["/Query", "/TN", TASK]).is_ok()
}

fn open_run_key() -> Result<HKEY, Failure> {
    let path = wide(RUN_KEY);
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: valid NUL-terminated path and out-pointer; optional arguments are null.
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            0,
            std::ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            std::ptr::null(),
            &mut key,
            std::ptr::null_mut(),
        )
    };
    if status == ERROR_SUCCESS { Ok(key) } else { Err(Failure::error(format!("Can't open the startup key (error {status})."))) }
}

fn set_run_value(command_line: &str) -> Outcome {
    let key = open_run_key()?;
    let (name, data) = (wide(RUN_VALUE), wide(command_line));
    let bytes = u32::try_from(data.len() * 2).unwrap_or(u32::MAX);
    // SAFETY: `key` is open; `data` is a NUL-terminated UTF-16 buffer of `bytes` bytes.
    let status = unsafe { RegSetValueExW(key, name.as_ptr(), 0, REG_SZ, data.as_ptr().cast(), bytes) };
    // SAFETY: closing the key opened above.
    unsafe { RegCloseKey(key) };
    if status == ERROR_SUCCESS { Ok(()) } else { Err(Failure::error(format!("Can't write the startup entry (error {status})."))) }
}

fn delete_run_value() -> Outcome {
    let key = open_run_key()?;
    let name = wide(RUN_VALUE);
    // SAFETY: `key` is open and `name` is NUL-terminated; a missing value is fine.
    unsafe {
        RegDeleteValueW(key, name.as_ptr());
        RegCloseKey(key);
    }
    Ok(())
}

fn run_value_exists() -> bool {
    let (path, name) = (wide(RUN_KEY), wide(RUN_VALUE));
    let mut size = 0u32;
    // SAFETY: size query only (null data pointer) with valid NUL-terminated strings.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    status == ERROR_SUCCESS
}
