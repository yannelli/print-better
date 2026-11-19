//! Linux: unpack the tarball's binary and rename it over the running one.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::process::Command;

const BINARY: &str = "printbetter";

/// `tarball` holds the single `printbetter` binary (docs/cli.md, Downloads manifest).
pub fn install(tarball: &Path, exe: &Path, version: &str) -> Result<(), String> {
    let unpacked = tarball.with_extension("unpacked");
    let _ = fs::remove_dir_all(&unpacked);
    fs::create_dir_all(&unpacked).map_err(|e| format!("Can't unpack the update: {e}"))?;
    let result = unpack(tarball, &unpacked).and_then(|new| replace_binary(&new, exe, version));
    let _ = fs::remove_dir_all(&unpacked);
    result
}

pub fn unpack(tarball: &Path, into: &Path) -> Result<std::path::PathBuf, String> {
    let output = Command::new("tar")
        .arg("-xzf")
        .arg(tarball)
        .arg("-C")
        .arg(into)
        .arg(BINARY)
        .output()
        .map_err(|e| format!("Can't run tar: {e}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("Can't unpack the update: {detail}"));
    }
    let new = into.join(BINARY);
    match fs::symlink_metadata(&new) {
        Ok(meta) if meta.is_file() && meta.len() > 0 => Ok(new),
        _ => Err("The update does not contain the printbetter program.".into()),
    }
}

/// Copies `new` next to `exe`, checks it runs and reports `version`, then renames it into place.
/// The rename is atomic: `exe` is either the old binary or the complete new one.
pub fn replace_binary(new: &Path, exe: &Path, version: &str) -> Result<(), String> {
    let dir = exe.parent().ok_or("The program has no folder.")?;
    let staged = dir.join(format!(".{BINARY}.update-{}", std::process::id()));
    let _ = fs::remove_file(&staged);
    let result = stage(new, &staged)
        .map_err(|e| format!("Can't write {}: {e}", staged.display()))
        .and_then(|()| super::reports(&staged, version))
        .and_then(|()| fs::rename(&staged, exe).map_err(|e| format!("Can't replace {}: {e}", exe.display())));
    if result.is_err() {
        let _ = fs::remove_file(&staged);
        return result;
    }
    // Makes the rename itself survive a power loss.
    let _ = File::open(dir).and_then(|d| d.sync_all());
    Ok(())
}

fn stage(new: &Path, staged: &Path) -> io::Result<()> {
    let mut source = File::open(new)?;
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o755).open(staged)?;
    io::copy(&mut source, &mut file)?;
    file.set_permissions(fs::Permissions::from_mode(0o755))?;
    file.sync_all()
}
