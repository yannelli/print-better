//! Small OS facts and actions: identity, privilege, GUI session, browser, self-restart.

use std::ffi::OsString;
use std::io::{self, IsTerminal};
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub fn os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

pub fn arch() -> &'static str {
    std::env::consts::ARCH
}

#[cfg(unix)]
pub fn is_root() -> bool {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() == 0 }
}

#[cfg(not(unix))]
pub fn is_root() -> bool {
    false
}

/// System mode = the machine-wide service: root, or the Linux `printbetter` service user.
pub fn is_system() -> bool {
    let service_env = std::env::var_os("PRINTBETTER_SYSTEM").is_some_and(|v| v == "1");
    (cfg!(target_os = "linux") && service_env) || (cfg!(unix) && is_root())
}

#[cfg(unix)]
pub fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for `buf.len()` bytes; the result is NUL-terminated or truncated.
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
    let raw = if ok { std::ffi::CStr::from_bytes_until_nul(&buf).ok() } else { None };
    let name = raw.map(|c| c.to_string_lossy().into_owned()).unwrap_or_default();
    let name = name.strip_suffix(".local").unwrap_or(&name).to_string();
    if name.is_empty() { "printbetter".into() } else { name }
}

#[cfg(windows)]
pub fn hostname() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows PC".into())
}

pub fn user_name() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_else(|_| "printbetter".into())
}

/// Whether a tray/menu-bar icon can be shown by this process.
pub fn gui_session() -> bool {
    if cfg!(target_os = "macos") {
        !is_root() && std::env::var_os("SSH_CONNECTION").is_none()
    } else if cfg!(windows) {
        true
    } else {
        let set = |var: &str| std::env::var_os(var).is_some_and(|v| !v.is_empty());
        !is_system() && (set("WAYLAND_DISPLAY") || set("DISPLAY"))
    }
}

pub fn stdio_is_terminal() -> bool {
    io::stdin().is_terminal() || io::stdout().is_terminal()
}

/// Capabilities announced in `hello`.
pub fn features(tray: bool) -> Vec<String> {
    let mut out = vec!["snmp", "lan-share"];
    if cfg!(unix) {
        out.extend(["cups", "usb"]);
    }
    if cfg!(windows) {
        out.push("gdi");
    }
    if tray {
        out.push("tray");
    }
    out.into_iter().map(String::from).collect()
}

#[cfg(not(windows))]
pub fn open_url(url: &str) -> bool {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(opener)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(windows)]
pub fn open_url(url: &str) -> bool {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let (verb, file) = (wide("open"), wide(url));
    // SAFETY: both strings are NUL-terminated UTF-16 buffers that outlive the call.
    let result = unsafe {
        ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL)
    };
    result as isize > 32
}

#[cfg(windows)]
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Lets the GUI-subsystem exe print to the console it was started from.
#[cfg(windows)]
pub fn attach_console() -> bool {
    use windows_sys::Win32::System::Console::{ATTACH_PARENT_PROCESS, AttachConsole};
    // SAFETY: plain Win32 call without pointers.
    unsafe { AttachConsole(ATTACH_PARENT_PROCESS) != 0 }
}

#[cfg(not(windows))]
pub fn attach_console() -> bool {
    true
}

/// The running binary; after an in-place upgrade Linux reports "<path> (deleted)".
pub fn current_exe() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let text = exe.to_string_lossy();
    Ok(match text.strip_suffix(" (deleted)") {
        Some(original) => PathBuf::from(original),
        None => exe,
    })
}

/// Replaces this process with a fresh copy of the binary (same arguments).
pub fn restart_self() -> io::Error {
    let exe = match current_exe() {
        Ok(exe) => exe,
        Err(e) => return e,
    };
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let mut cmd = Command::new(exe);
    cmd.args(args);
    exec(cmd)
}

#[cfg(unix)]
fn exec(mut cmd: Command) -> io::Error {
    use std::os::unix::process::CommandExt;
    cmd.exec()
}

#[cfg(windows)]
fn exec(mut cmd: Command) -> io::Error {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    match cmd.creation_flags(DETACHED_PROCESS).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        Ok(_) => std::process::exit(0),
        Err(e) => e,
    }
}
