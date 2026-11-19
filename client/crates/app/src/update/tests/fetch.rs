//! Downloads and checks against a fake Print Better server on an ephemeral loopback port.

use super::super::fetch::{download, path_on};
use super::super::{Release, Target, check};
use crate::net::{ServerUrl, http};
use crate::test_util::{Requests, TempDir};
use std::path::PathBuf;

const TOKEN: &str = "pbc_update_test";
const BODY: &[u8] = b"pretend this is a tarball";

async fn serve(status: u16, body: Vec<u8>) -> (ServerUrl, Requests) {
    crate::test_util::serve(move |_| (status, body.clone())).await
}

fn release(server: &ServerUrl, size: u64, sha256: String) -> Release {
    Release { version: "9.9.9".into(), url: format!("{}/dl/9.9.9/printbetter-9.9.9-linux-x86_64.tar.gz", server.origin()), sha256, size }
}

fn sha256(data: &[u8]) -> String {
    http::hex(ring::digest::digest(&ring::digest::SHA256, data).as_ref())
}

fn files(dir: &std::path::Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir).map(|d| d.flatten().map(|e| e.path()).collect()).unwrap_or_default()
}

#[test]
fn updates_come_only_from_the_paired_origin() {
    let server = ServerUrl::parse("https://print.example.com").unwrap();
    assert_eq!(path_on(&server, "https://print.example.com/dl/1.0.0/printbetter-1.0.0-linux-x86_64.tar.gz").unwrap(), "/dl/1.0.0/printbetter-1.0.0-linux-x86_64.tar.gz");
    assert_eq!(path_on(&server, "https://PRINT.example.com:443/dl/1.0.0/a.zip").unwrap(), "/dl/1.0.0/a.zip");
    for url in [
        "https://evil.example.com/dl/1.0.0/a.zip",
        "https://print.example.com.evil.net/dl/a.zip",
        "https://print.example.com:8443/dl/a.zip",
        "http://print.example.com/dl/a.zip",
        "print.example.com/dl/a.zip",
        "https://print.example.com/dl/../../etc/passwd",
        "https://print.example.com/dl/a.zip?x=1",
        "https://print.example.com/dl/",
        "https://print.example.com",
    ] {
        assert!(path_on(&server, url).is_err(), "{url}");
    }
}

#[tokio::test]
async fn a_verified_download_is_kept_with_the_token_sent() {
    let (server, seen) = serve(200, BODY.to_vec()).await;
    let dir = TempDir::new();
    let file = download(&server, TOKEN, &release(&server, BODY.len() as u64, sha256(BODY)), dir.path()).await.unwrap();
    assert_eq!(file, dir.path().join("printbetter-9.9.9-linux-x86_64.tar.gz"));
    assert_eq!(std::fs::read(&file).unwrap(), BODY);
    assert_eq!(files(dir.path()), vec![file]);
    assert_eq!(seen.lock().unwrap()[0], ("/dl/9.9.9/printbetter-9.9.9-linux-x86_64.tar.gz".into(), Some(format!("Bearer {TOKEN}"))));
}

#[tokio::test]
async fn wrong_size_wrong_checksum_and_errors_leave_nothing_behind() {
    let (server, _) = serve(200, BODY.to_vec()).await;
    let dir = TempDir::new();
    let short = download(&server, TOKEN, &release(&server, BODY.len() as u64 + 1, sha256(BODY)), dir.path()).await;
    assert!(short.unwrap_err().contains("incomplete"));
    let damaged = download(&server, TOKEN, &release(&server, BODY.len() as u64, sha256(b"other")), dir.path()).await;
    assert!(damaged.unwrap_err().contains("checksum"));
    let no_sum = download(&server, TOKEN, &release(&server, BODY.len() as u64, "abc".into()), dir.path()).await;
    assert!(no_sum.unwrap_err().contains("checksum"));
    let (missing, _) = serve(404, br#"{"error":{"code":"not_found","message":"Not found"}}"#.to_vec()).await;
    assert!(download(&missing, TOKEN, &release(&missing, 1, sha256(BODY)), dir.path()).await.is_err());
    assert_eq!(files(dir.path()), Vec::<PathBuf>::new());
}

#[tokio::test]
async fn check_reads_the_release_and_treats_404_as_nothing_published() {
    let target = Target::Binary(PathBuf::from("/usr/local/bin/printbetter"));
    let json = br#"{"version":"9.9.9","url":"http://127.0.0.1/dl/x.tar.gz","sha256":"ab","size":3}"#.to_vec();
    let (server, seen) = serve(200, json).await;
    let found = check(&server, TOKEN, &target).await.unwrap().unwrap();
    assert_eq!((found.version.as_str(), found.size), ("9.9.9", 3));
    assert!(seen.lock().unwrap()[0].0.starts_with("/api/client/latest?os="));
    let (none, _) = serve(404, br#"{"error":{"code":"no_build","message":"No build"}}"#.to_vec()).await;
    assert_eq!(check(&none, TOKEN, &target).await, Ok(None));
    let (broken, _) = serve(500, b"oops".to_vec()).await;
    assert!(check(&broken, TOKEN, &target).await.unwrap_err().contains("Couldn't check"));
}
