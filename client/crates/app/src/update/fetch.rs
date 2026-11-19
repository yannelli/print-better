//! Downloads a release from the paired server only, and keeps it only if size and SHA-256 match.

use super::Release;
use crate::net::{ServerUrl, http};
use std::fs;
use std::path::{Path, PathBuf};

/// Streams the release into `dir` and returns the verified file.
pub async fn download(server: &ServerUrl, token: &str, release: &Release, dir: &Path) -> Result<PathBuf, String> {
    let path = path_on(server, &release.url)?;
    let name = path.rsplit('/').next().unwrap_or_default().to_string();
    if release.sha256.len() != 64 || !release.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("The server offered an update without a valid checksum.".into());
    }
    fs::create_dir_all(dir).map_err(|e| format!("Can't create {}: {e}", dir.display()))?;
    let part = dir.join(format!("{name}.part"));
    let result = http::download(server, &path, token, &part).await;
    let verdict = match result {
        Err(e) => Err(format!("Couldn't download the update: {e}")),
        Ok(got) if got.size != release.size => {
            Err(format!("The update download was incomplete ({} of {} bytes).", got.size, release.size))
        }
        Ok(got) if !got.sha256.eq_ignore_ascii_case(&release.sha256) => {
            Err("The update download was damaged (checksum mismatch).".into())
        }
        Ok(_) => Ok(()),
    };
    if let Err(e) = verdict {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    let file = dir.join(&name);
    fs::rename(&part, &file).map_err(|e| format!("Can't save the update: {e}"))?;
    Ok(file)
}

/// The path of `url` when it points at `server` itself; anything else is refused.
pub fn path_on(server: &ServerUrl, url: &str) -> Result<String, String> {
    let refused = || format!("Refusing an update from {url}: it is not on {}.", server.origin());
    let rest = url.split_once("://").map(|(_, rest)| rest).ok_or_else(refused)?;
    if ServerUrl::parse(url).ok().as_ref() != Some(server) {
        return Err(refused());
    }
    let path = rest.find('/').map(|i| &rest[i..]).ok_or_else(refused)?;
    let safe = path.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c));
    let name = path.rsplit('/').next().unwrap_or_default();
    if !safe || path.split('/').any(|part| part == "..") || name.is_empty() || name.starts_with('.') {
        return Err(format!("The server offered an update with an invalid address: {url}"));
    }
    Ok(path.to_string())
}
