//! The updater against a fake server publishing a tarball, with a script as the installed binary.

use super::{automatic, check, install, request_for};
use crate::VERSION;
use crate::daemon::Daemon;
use crate::net::http;
use crate::proto::ClientSettings;
use crate::store::{self, Credentials};
use crate::test_util::{Requests, TempDir, script, serve, tarball};
use crate::update::Target;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

const TOKEN: &str = "pbc_updater";

struct World {
    d: Arc<Daemon>,
    exe: PathBuf,
    target: Target,
    seen: Requests,
    _dir: TempDir,
}

/// A paired daemon whose server publishes `version`, packaged with a binary that prints `says`.
async fn world(version: &str, says: &str) -> World {
    let dir = TempDir::new();
    let file = fs::read(tarball(dir.path(), Some(says))).unwrap();
    let (sha256, size) = (http::hex(ring::digest::digest(&ring::digest::SHA256, &file).as_ref()), file.len());
    let origin: Arc<OnceLock<String>> = Arc::default();
    let (here, version) = (origin.clone(), version.to_string());
    let (server, seen) = serve(move |path| {
        if path.starts_with("/api/client/latest?") {
            let url = format!("{}/dl/{version}/printbetter-{version}-linux-x86_64.tar.gz", here.get().unwrap());
            (200, json!({ "version": version, "url": url, "sha256": sha256, "size": size }).to_string().into_bytes())
        } else if path.starts_with("/dl/") {
            (200, file.clone())
        } else {
            (404, Vec::new())
        }
    })
    .await;
    origin.set(server.origin()).unwrap();
    let paths = dir.paths();
    let creds = Credentials { server: server.origin(), client_id: "cl_1".into(), workspace_id: "ws_1".into(), name: "Pi".into(), token: TOKEN.into() };
    store::save_credentials(&paths, &creds).unwrap();
    let bin = dir.path().join("bin");
    fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("printbetter");
    script(&exe, &format!("printbetter {VERSION}"));
    let d = Arc::new(Daemon::new(paths, false, false));
    World { d, target: Target::Binary(exe.clone()), exe, seen, _dir: dir }
}

impl World {
    fn downloads(&self) -> usize {
        self.seen.lock().unwrap().iter().filter(|(path, _)| path.starts_with("/dl/")).count()
    }

    fn untouched(&self) -> bool {
        fs::read_to_string(&self.exe).unwrap().contains(&format!("printbetter {VERSION}"))
    }
}

#[tokio::test]
async fn a_request_checks_now_and_queues_the_newer_release() {
    let w = world("9.9.9", "printbetter 9.9.9").await;
    assert_eq!(request_for(&w.d, &w.target).await, Ok((VERSION.to_string(), "9.9.9".to_string())));
    assert_eq!(w.d.lock().pending_update.as_ref().map(|r| r.version.clone()).as_deref(), Some("9.9.9"));
    let status = w.d.with_state(super::status);
    assert_eq!((status["latest"].as_str(), status["available"].as_bool()), (Some("9.9.9"), Some(true)));
    assert!(status["checkedAt"].is_i64() && status["error"].is_null() && status["autoUpdate"] == true);
    let (path, auth) = w.seen.lock().unwrap()[0].clone();
    assert!(path.starts_with("/api/client/latest?os="), "{path}");
    assert_eq!(auth, Some(format!("Bearer {TOKEN}")));
}

#[tokio::test]
async fn a_request_refuses_the_same_or_an_older_version() {
    for version in [VERSION, "0.0.1"] {
        let w = world(version, "printbetter whatever").await;
        let refused = request_for(&w.d, &w.target).await.unwrap_err();
        assert!(refused.contains("up to date"), "{refused}");
        assert!(w.d.lock().pending_update.is_none());
        assert_eq!(w.d.with_state(super::status)["available"], false);
    }
}

#[tokio::test]
async fn automatic_checks_respect_auto_update_off() {
    let w = world("9.9.9", "printbetter 9.9.9").await;
    w.d.change_settings(ClientSettings { auto_update: false, ..w.d.settings() }).unwrap();
    automatic(&w.d, &w.target).await;
    assert_eq!(w.d.with_state(super::status)["available"], true);
    assert_eq!(w.downloads(), 0);
    assert!(w.untouched() && !w.d.restart_requested());
}

#[tokio::test]
async fn a_damaged_download_is_reported_and_changes_nothing() {
    let w = world("9.9.9", "printbetter 9.9.9").await;
    let mut release = check(&w.d, &w.target).await.unwrap().unwrap();
    release.sha256 = "0".repeat(64);
    install(&w.d, &w.target, release, true).await;
    let status = w.d.with_state(super::status);
    assert!(status["error"].as_str().unwrap().contains("checksum"), "{status}");
    assert!(status["phase"].is_null());
    assert!(w.untouched() && !w.d.restart_requested());
    assert!(!w.d.paths.updates().exists());
}

#[tokio::test]
async fn a_new_binary_that_does_not_start_changes_nothing() {
    let w = world("9.9.9", "printbetter 9.9.8").await;
    let release = check(&w.d, &w.target).await.unwrap().unwrap();
    install(&w.d, &w.target, release, true).await;
    assert!(w.d.with_state(super::status)["error"].is_string());
    assert!(w.untouched() && !w.d.restart_requested());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn an_update_swaps_the_binary_and_restarts() {
    let w = world("9.9.9", "printbetter 9.9.9").await;
    let release = check(&w.d, &w.target).await.unwrap().unwrap();
    install(&w.d, &w.target, release, true).await;
    let status = w.d.with_state(super::status);
    assert!(status["error"].is_null() && status["phase"].is_null(), "{status}");
    assert!(fs::read_to_string(&w.exe).unwrap().contains("printbetter 9.9.9"));
    assert!(w.d.restart_requested());
}
