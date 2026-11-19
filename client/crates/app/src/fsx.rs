use serde::Serialize;
use serde::de::DeserializeOwned;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;

/// Write-then-rename so a crash or power loss never leaves a half-written file.
pub fn write_atomic(path: &Path, data: &[u8], private: bool) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| io::Error::other("path has no parent directory"))?;
    fs::create_dir_all(dir)?;
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    let _ = fs::remove_file(&tmp);
    let written = open_new(&tmp, private).and_then(|mut file| {
        file.write_all(data)?;
        file.sync_all()
    });
    if let Err(e) = written.and_then(|()| fs::rename(&tmp, path)) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    match_owner(path, dir);
    Ok(())
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> io::Result<Option<T>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn write_json<T: Serialize>(path: &Path, value: &T, private: bool) -> io::Result<()> {
    let data = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    write_atomic(path, &data, private)
}

pub fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

#[cfg(unix)]
fn open_new(path: &Path, private: bool) -> io::Result<File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mode = if private { 0o600 } else { 0o644 };
    let file = fs::OpenOptions::new().write(true).create_new(true).mode(mode).open(path)?;
    // A restrictive umask (e.g. in a pkg postinstall) must not change what launchd and the service user see.
    file.set_permissions(fs::Permissions::from_mode(mode))?;
    Ok(file)
}

#[cfg(not(unix))]
fn open_new(path: &Path, _private: bool) -> io::Result<File> {
    File::create_new(path)
}

/// Files written by root (e.g. `sudo printbetter pair`) must stay readable by the
/// service user that owns the directory.
#[cfg(unix)]
fn match_owner(path: &Path, dir: &Path) {
    use std::os::unix::fs::MetadataExt;
    if !crate::platform::is_root() {
        return;
    }
    if let Ok(meta) = fs::metadata(dir)
        && meta.uid() != 0
    {
        let _ = std::os::unix::fs::chown(path, Some(meta.uid()), Some(meta.gid()));
    }
}

#[cfg(not(unix))]
fn match_owner(_path: &Path, _dir: &Path) {}
