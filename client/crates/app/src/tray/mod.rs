//! Tray / menu-bar icon. A thin client of the local API, the same code whether it runs inside
//! the daemon (`run`) or alone (`tray-ui`, next to a root LaunchDaemon on macOS).

#[cfg(all(target_os = "linux", feature = "tray-linux"))]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(target_os = "macos", windows, all(target_os = "linux", feature = "tray-linux")))]
mod menu;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod windows_icon;

pub const SUPPORTED: bool = cfg!(any(target_os = "macos", windows, all(target_os = "linux", feature = "tray-linux")));

/// Shows the icon until quit; returns early only if no tray can be shown.
pub fn run(in_process: bool) {
    #[cfg(target_os = "macos")]
    macos::run(in_process);
    #[cfg(windows)]
    windows::run(in_process);
    #[cfg(all(target_os = "linux", feature = "tray-linux"))]
    linux::run(in_process);
    #[cfg(not(any(target_os = "macos", windows, all(target_os = "linux", feature = "tray-linux"))))]
    let _ = in_process;
}

pub fn state_label(state: &str) -> &'static str {
    match state {
        "idle" => "ready",
        "printing" => "printing",
        "stopped" => "needs attention",
        "offline" => "offline",
        _ => "unknown",
    }
}
