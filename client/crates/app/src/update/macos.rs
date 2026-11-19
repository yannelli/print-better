//! macOS: an update must carry an Apple Developer ID signature from this app's own team. The
//! machine-wide install runs the pkg through `installer`; a per-user install swaps the app bundle.

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Command, Output};

#[cfg(target_os = "macos")]
const APP: &str = "Print Better.app";

/// The Team ID in `codesign -dv` output; `None` for unsigned or ad hoc signed code.
pub fn team_from_codesign(text: &str) -> Option<String> {
    let team = text.lines().find_map(|l| l.trim().strip_prefix("TeamIdentifier="))?.trim();
    (!team.is_empty() && team != "not set").then(|| team.to_string())
}

/// The Team ID of a Developer ID Installer signature in `pkgutil --check-signature` output.
pub fn pkg_team(text: &str) -> Result<String, String> {
    let status = text.lines().find_map(|l| l.trim().strip_prefix("Status:")).map(str::trim).unwrap_or("no signature");
    if !status.contains("issued by Apple for distribution") {
        return Err(format!("The update package is not signed with a Developer ID ({status})."));
    }
    let leaf = text.lines().find_map(|l| l.trim().strip_prefix("1. ")).unwrap_or_default();
    let team = leaf.strip_prefix("Developer ID Installer: ").and_then(|who| who.rsplit_once('(')).and_then(|(_, t)| t.strip_suffix(')'));
    match team {
        Some(team) if !team.is_empty() => Ok(team.to_string()),
        _ => Err("The update package is not signed with a Developer ID Installer certificate.".into()),
    }
}

pub fn same_team(own: &str, update: &str) -> Result<(), String> {
    if own == update {
        Ok(())
    } else {
        Err(format!("The update is signed by team {update}, not by this app's team {own}; it was not installed."))
    }
}

#[cfg(target_os = "macos")]
pub fn install_pkg(pkg: &Path, app: &Path) -> Result<(), String> {
    let own = own_team(app)?;
    let check = run(Command::new("/usr/sbin/pkgutil").arg("--check-signature").arg(pkg))?;
    if !check.status.success() {
        return Err(format!("The update package's signature is not valid: {}", detail(&check)));
    }
    same_team(&own, &pkg_team(&String::from_utf8_lossy(&check.stdout))?)?;
    let mut installer = Command::new("/usr/sbin/installer");
    installer.arg("-pkg").arg(pkg).args(["-target", "/"]);
    // The postinstall reloads this LaunchDaemon, and launchd kills the old job's process group.
    std::os::unix::process::CommandExt::process_group(&mut installer, 0);
    let installed = run(&mut installer)?;
    if !installed.status.success() {
        return Err(format!("The installer failed: {}", detail(&installed)));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn install_app(zip: &Path, app: &Path, version: &str) -> Result<(), String> {
    let own = own_team(app)?;
    let staging = app.with_file_name(".printbetter-update");
    let _ = std::fs::remove_dir_all(&staging);
    let result = unpack(zip, &staging, &own, version).and_then(|new| swap(&new, app));
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Unzips next to the app (same volume, so the swap is one rename) and checks the new bundle.
#[cfg(target_os = "macos")]
fn unpack(zip: &Path, staging: &Path, own: &str, version: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(staging).map_err(|e| format!("Can't unpack the update: {e}"))?;
    let unzipped = run(Command::new("/usr/bin/ditto").args(["-x", "-k"]).arg(zip).arg(staging))?;
    if !unzipped.status.success() {
        return Err(format!("Can't unpack the update: {}", detail(&unzipped)));
    }
    let new = staging.join(APP);
    if !new.is_dir() {
        return Err(format!("The update does not contain {APP}."));
    }
    let verified = run(Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict"]).arg(&new))?;
    if !verified.status.success() {
        return Err(format!("The update's code signature is not valid: {}", detail(&verified)));
    }
    same_team(own, &team_of(&new).ok_or("The update is not signed by a developer team.")?)?;
    super::reports(&new.join("Contents/MacOS/printbetter"), version)?;
    Ok(new)
}

/// Exchanges the two bundles atomically; afterwards `new` holds the old app.
#[cfg(target_os = "macos")]
pub fn swap(new: &Path, app: &Path) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let path = |p: &Path| std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|e| e.to_string());
    let (from, to) = (path(new)?, path(app)?);
    // SAFETY: both are valid NUL-terminated paths for the duration of the call.
    if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_SWAP) } == 0 {
        return Ok(());
    }
    Err(format!("Can't replace {}: {}", app.display(), std::io::Error::last_os_error()))
}

#[cfg(target_os = "macos")]
fn own_team(app: &Path) -> Result<String, String> {
    team_of(app).ok_or_else(|| "This copy of Print Better is not signed by a developer team, so it can't verify updates.".into())
}

/// `codesign -dv` describes the signature on stderr.
#[cfg(target_os = "macos")]
fn team_of(bundle: &Path) -> Option<String> {
    let shown = run(Command::new("/usr/bin/codesign").args(["-dv", "--verbose=2"]).arg(bundle)).ok()?;
    team_from_codesign(&String::from_utf8_lossy(&shown.stderr))
}

#[cfg(target_os = "macos")]
fn run(cmd: &mut Command) -> Result<Output, String> {
    let program = cmd.get_program().to_string_lossy().into_owned();
    cmd.output().map_err(|e| format!("Can't run {program}: {e}"))
}

#[cfg(target_os = "macos")]
fn detail(output: &Output) -> String {
    let text = if output.stderr.is_empty() { &output.stdout } else { &output.stderr };
    String::from_utf8_lossy(text).trim().lines().last().unwrap_or("no details").to_string()
}
