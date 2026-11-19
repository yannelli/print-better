//! Service definitions rendered from client/packaging, with the binary path filled in.

use std::path::Path;

#[cfg(any(test, target_os = "macos"))]
pub fn launch_agent(exe: &Path, no_tray: bool) -> String {
    let extra = if no_tray { "<string>--no-tray</string>" } else { "" };
    let plist = fill_exe(include_str!("../../../../packaging/macos/launch-agent.plist"), &xml_escape(exe));
    plist.replace("<!--EXTRA_ARGS-->", extra)
}

#[cfg(any(test, target_os = "macos"))]
pub fn launch_daemon(exe: &Path) -> String {
    fill_exe(include_str!("../../../../packaging/macos/launch-daemon.plist"), &xml_escape(exe))
}

#[cfg(any(test, target_os = "macos"))]
pub fn tray_agent(exe: &Path) -> String {
    fill_exe(include_str!("../../../../packaging/macos/tray-agent.plist"), &xml_escape(exe))
}

#[cfg(any(test, target_os = "linux"))]
pub fn user_unit(exe: &Path, no_tray: bool) -> String {
    let unit = fill_exe(include_str!("../../../../packaging/linux/printbetter-user.service"), &unit_path(exe));
    unit.replace("{{ARGS}}", if no_tray { " --no-tray" } else { "" })
}

#[cfg(any(test, target_os = "linux"))]
pub fn system_unit(exe: &Path) -> String {
    fill_exe(include_str!("../../../../packaging/linux/printbetter.service"), &unit_path(exe))
}

/// The root update helper and its trigger (`crate::update::helper`).
#[cfg(any(test, target_os = "linux"))]
pub fn update_unit(exe: &Path) -> String {
    fill_exe(include_str!("../../../../packaging/linux/printbetter-update.service"), &unit_path(exe))
}

#[cfg(any(test, target_os = "linux"))]
pub const UPDATE_TRIGGER: &str = include_str!("../../../../packaging/linux/printbetter-update.path");

#[cfg(any(test, target_os = "linux"))]
pub const UDEV_RULE: &str = include_str!("../../../../packaging/linux/60-printbetter.rules");

#[cfg(any(test, windows))]
pub fn scheduled_task(exe: &Path) -> String {
    fill_exe(include_str!("../../../../packaging/windows/task.xml"), &xml_escape(exe))
}

fn fill_exe(template: &str, exe: &str) -> String {
    template.replace("{{EXE}}", exe)
}

#[cfg(any(test, target_os = "macos", windows))]
fn xml_escape(exe: &Path) -> String {
    let text = exe.to_string_lossy();
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Unit files treat `%` as a specifier and split on spaces unless quoted.
#[cfg(any(test, target_os = "linux"))]
fn unit_path(exe: &Path) -> String {
    let text = exe.to_string_lossy().replace('%', "%%");
    if text.contains(char::is_whitespace) { format!("\"{}\"", text.replace('"', "\\\"")) } else { text }
}
