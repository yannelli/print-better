//! The root helper's routine with a fake server, a temp "installed" binary, and a fake restart.

use super::super::Target;
use super::super::helper::{Outcome, available, finish, install_latest, request};
use crate::VERSION;
use crate::fsx;
use crate::net::http;
use crate::store::{self, Credentials};
use crate::test_util::{TempDir, script, serve, tarball};
use serde_json::json;
use std::cell::Cell;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

/// Paired paths, an installed script binary, and a server publishing `version` (binary says `says`).
async fn setup(dir: &TempDir, version: &str, says: &str) -> (Target, PathBuf) {
    let file = fs::read(tarball(dir.path(), Some(says))).unwrap();
    let (sha256, size) = (http::hex(ring::digest::digest(&ring::digest::SHA256, &file).as_ref()), file.len());
    let origin: Arc<OnceLock<String>> = Arc::default();
    let (here, version) = (origin.clone(), version.to_string());
    let (server, _) = serve(move |path| match path {
        p if p.starts_with("/api/client/latest?") => {
            let url = format!("{}/dl/{version}/printbetter.tar.gz", here.get().unwrap());
            (200, json!({ "version": version, "url": url, "sha256": sha256, "size": size }).to_string().into_bytes())
        }
        p if p.starts_with("/dl/") => (200, file.clone()),
        _ => (404, Vec::new()),
    })
    .await;
    origin.set(server.origin()).unwrap();
    let creds = Credentials { server: server.origin(), client_id: "c".into(), workspace_id: "w".into(), name: "Pi".into(), token: "pbc_t".into() };
    store::save_credentials(&dir.paths(), &creds).unwrap();
    fs::create_dir_all(dir.path().join("bin")).unwrap();
    let exe = dir.path().join("bin/printbetter");
    script(&exe, &format!("printbetter {VERSION}"));
    (Target::Binary(exe.clone()), exe)
}

#[test]
fn finish_records_the_outcome_and_restarts_only_after_an_install() {
    let dir = TempDir::new();
    let file = dir.path().join("result.json");
    let restarted = Cell::new(0);
    let restart = || {
        restarted.set(restarted.get() + 1);
        Ok(())
    };
    let done = finish(Ok(Some("9.9.9".into())), &file, restart);
    assert!(done.ok && done.installed.as_deref() == Some("9.9.9"));
    assert_eq!(fsx::read_json::<Outcome>(&file).unwrap(), Some(done));
    assert_eq!(restarted.get(), 1);
    let current = finish(Ok(None), &file, || panic!("nothing to restart"));
    assert!(current.ok && current.message.contains("up to date"));
    let failed = finish(Err("checksum mismatch".into()), &file, || panic!("nothing to restart"));
    assert_eq!((failed.ok, failed.message.as_str()), (false, "checksum mismatch"));
    assert_eq!(fsx::read_json::<Outcome>(&file).unwrap(), Some(failed));
}

#[test]
fn a_failed_restart_is_recorded_as_a_failure() {
    let dir = TempDir::new();
    let file = dir.path().join("result.json");
    let outcome = finish(Ok(Some("9.9.9".into())), &file, || Err("Unit printbetter.service not found.".into()));
    assert!(!outcome.ok && outcome.message.contains("did not restart"), "{outcome:?}");
    assert_eq!(fsx::read_json::<Outcome>(&file).unwrap(), Some(outcome));
}

#[test]
fn the_daemon_only_writes_a_request_in_its_own_folder() {
    let dir = TempDir::new();
    let at = request(&dir.paths()).unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("update-request")).unwrap(), at.to_string());
    assert!(!available(&dir.paths()), "only the machine-wide service's state folder is watched");
}

#[tokio::test]
async fn install_latest_skips_what_is_not_newer() {
    let dir = TempDir::new();
    let (target, exe) = setup(&dir, VERSION, "printbetter whatever").await;
    let download = dir.path().join("download");
    assert_eq!(install_latest(&dir.paths(), &target, &download).await, Ok(None));
    assert!(!download.exists());
    assert!(fs::read_to_string(exe).unwrap().contains(VERSION));
}

#[tokio::test]
async fn install_latest_needs_a_pairing() {
    let dir = TempDir::new();
    let target = Target::Binary(dir.path().join("printbetter"));
    let err = install_latest(&dir.paths(), &target, &dir.path().join("download")).await.unwrap_err();
    assert!(err.contains("not paired"), "{err}");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn install_latest_verifies_and_swaps_the_binary() {
    let dir = TempDir::new();
    let (target, exe) = setup(&dir, "9.9.9", "printbetter 9.9.9").await;
    let download = dir.path().join("download");
    assert_eq!(install_latest(&dir.paths(), &target, &download).await, Ok(Some("9.9.9".into())));
    assert!(fs::read_to_string(exe).unwrap().contains("printbetter 9.9.9"));
    assert!(!download.exists());
}
