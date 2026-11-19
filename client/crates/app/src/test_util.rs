//! Helpers shared by unit tests.

use crate::net::ServerUrl;
use crate::paths::Paths;
use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

/// A fresh directory under the system temp folder, removed on drop.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new() -> TempDir {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("printbetter-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Config, state, and logs all inside this directory, like `PRINTBETTER_HOME`.
    pub fn paths(&self) -> Paths {
        Paths { config: self.0.clone(), state: self.0.clone(), logs: self.0.join("logs") }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Every request a `serve` server saw: path with query, and the Authorization header.
pub type Requests = Arc<Mutex<Vec<(String, Option<String>)>>>;

/// An HTTP server on an ephemeral loopback port, answering `route(path_and_query)` with
/// `(status, body)`. Runs until the test's runtime ends.
pub async fn serve(route: impl Fn(&str) -> (u16, Vec<u8>) + Send + Sync + 'static) -> (ServerUrl, Requests) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = ServerUrl::parse(&format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port())).unwrap();
    let seen: Requests = Arc::default();
    let (log, route) = (seen.clone(), Arc::new(route));
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let (log, route) = (log.clone(), route.clone());
            let service = service_fn(move |req: Request<Incoming>| {
                let auth = req.headers().get("authorization").and_then(|v| v.to_str().ok()).map(String::from);
                let path = req.uri().to_string();
                let (status, body) = route(&path);
                log.lock().unwrap().push((path, auth));
                let mut resp = Response::new(Full::new(Bytes::from(body)));
                *resp.status_mut() = StatusCode::from_u16(status).unwrap();
                async move { Ok::<_, std::convert::Infallible>(resp) }
            });
            tokio::spawn(async move { drop(http1::Builder::new().serve_connection(TokioIo::new(tcp), service).await) });
        }
    });
    (url, seen)
}

/// An executable shell script that prints `says`, standing in for a printbetter binary.
#[cfg(unix)]
pub fn script(path: &Path, says: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, format!("#!/bin/sh\necho \"{says}\"\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A release tarball in `dir` holding `printbetter` (a script printing `says`), or no binary.
#[cfg(unix)]
pub fn tarball(dir: &Path, says: Option<&str>) -> PathBuf {
    let src = dir.join("tarball-src");
    std::fs::create_dir_all(&src).unwrap();
    let member = match says {
        Some(says) => {
            script(&src.join("printbetter"), says);
            "printbetter"
        }
        None => {
            std::fs::write(src.join("README"), "no binary here").unwrap();
            "README"
        }
    };
    let out = dir.join("printbetter-9.9.9-linux-x86_64.tar.gz");
    let made = std::process::Command::new("tar").arg("-czf").arg(&out).arg("-C").arg(&src).arg(member).status().unwrap();
    assert!(made.success());
    out
}
