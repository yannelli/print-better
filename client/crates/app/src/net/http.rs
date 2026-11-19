//! Minimal HTTP/1.1 client (hyper conn API over our own TCP/TLS stream).

use super::{ServerUrl, USER_AGENT, stream};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::{Body, Frame, Incoming};
use hyper::header::HeaderName;
use hyper::{Method, Request, Response, StatusCode, header};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::fmt;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::timeout;

const TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_JSON: usize = 1 << 20;
const CHUNK: usize = 64 * 1024;
/// Upload time allowed on top of `TIMEOUT`: one second per 100 kB.
const UPLOAD_BYTES_PER_SEC: u64 = 100_000;

#[derive(Debug)]
pub enum NetError {
    /// Could not reach the server or the transfer broke off.
    Network(String),
    /// The server answered with an error body `{ error: { code, message } }`.
    Api { status: u16, code: String, message: String },
}

impl fmt::Display for NetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NetError::Network(m) => f.write_str(m),
            NetError::Api { message, .. } => f.write_str(message),
        }
    }
}

fn network(e: impl fmt::Display) -> NetError {
    NetError::Network(e.to_string())
}

pub async fn post_json<T: Serialize, R: DeserializeOwned>(
    url: &ServerUrl,
    path: &str,
    body: &T,
    bearer: Option<&str>,
) -> Result<R, NetError> {
    let body = serde_json::to_vec(body).map_err(network)?;
    json_call(url, Method::POST, path, bearer, Some(body)).await
}

pub async fn get_json<R: DeserializeOwned>(url: &ServerUrl, path: &str, bearer: Option<&str>) -> Result<R, NetError> {
    json_call(url, Method::GET, path, bearer, None).await
}

async fn json_call<R: DeserializeOwned>(
    url: &ServerUrl,
    method: Method,
    path: &str,
    bearer: Option<&str>,
    body: Option<Vec<u8>>,
) -> Result<R, NetError> {
    let call = async { json_reply(send(url, method, path, bearer, body).await?).await };
    timeout(TIMEOUT, call).await.unwrap_or_else(|_| Err(network("the server did not answer in time")))
}

/// PUTs the file at `file` as the raw request body, streamed, and reads a JSON reply.
pub async fn put_file<R: DeserializeOwned>(
    url: &ServerUrl,
    path: &str,
    bearer: &str,
    file: &Path,
    content_type: &str,
) -> Result<R, NetError> {
    let file = tokio::fs::File::open(file).await.map_err(network)?;
    let size = file.metadata().await.map_err(network)?.len();
    let chunks = futures_util::stream::unfold(Some(file), |file| async move {
        let mut file = file?;
        let mut buf = vec![0u8; CHUNK];
        match file.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok(Frame::data(Bytes::from(buf))), Some(file)))
            }
            Err(e) => Some((Err(e), None)),
        }
    });
    let headers = [(header::CONTENT_TYPE, content_type.to_string()), (header::CONTENT_LENGTH, size.to_string())];
    let call = async {
        let response = send_body(url, Method::PUT, path, Some(bearer), &headers, StreamBody::new(chunks)).await?;
        json_reply(response).await
    };
    let limit = TIMEOUT + Duration::from_secs(size / UPLOAD_BYTES_PER_SEC);
    timeout(limit, call).await.unwrap_or_else(|_| Err(network("the upload did not finish in time")))
}

async fn json_reply<R: DeserializeOwned>(response: Response<Incoming>) -> Result<R, NetError> {
    let status = response.status();
    let bytes = read_body(response).await?;
    if !status.is_success() {
        return Err(api_error(status, &bytes));
    }
    serde_json::from_slice(&bytes).map_err(|e| NetError::Network(format!("unexpected reply from the server: {e}")))
}

pub struct Downloaded {
    pub sha256: String,
    pub size: u64,
}

/// Streams `path` into `dest`, hashing as it goes.
pub async fn download(url: &ServerUrl, path: &str, bearer: &str, dest: &Path) -> Result<Downloaded, NetError> {
    let response = timeout(TIMEOUT, send(url, Method::GET, path, Some(bearer), None))
        .await
        .map_err(|_| network("the server did not answer in time"))??;
    let status = response.status();
    if !status.is_success() {
        let bytes = read_body(response).await.unwrap_or_default();
        return Err(api_error(status, &bytes));
    }
    let mut file = tokio::fs::File::create(dest).await.map_err(network)?;
    let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
    let mut size = 0u64;
    let mut body = response.into_body();
    loop {
        let frame = match timeout(IDLE_TIMEOUT, body.frame()).await {
            Err(_) => return Err(network("the download stalled")),
            Ok(None) => break,
            Ok(Some(frame)) => frame.map_err(network)?,
        };
        if let Ok(data) = frame.into_data() {
            digest.update(&data);
            size += data.len() as u64;
            file.write_all(&data).await.map_err(network)?;
        }
    }
    file.sync_all().await.map_err(network)?;
    Ok(Downloaded { sha256: hex(digest.finish().as_ref()), size })
}

async fn send(
    url: &ServerUrl,
    method: Method,
    path: &str,
    bearer: Option<&str>,
    body: Option<Vec<u8>>,
) -> Result<Response<Incoming>, NetError> {
    let json = [(header::CONTENT_TYPE, "application/json".to_string())];
    let headers: &[(HeaderName, String)] = if body.is_some() { &json } else { &[] };
    send_body(url, method, path, bearer, headers, Full::new(Bytes::from(body.unwrap_or_default()))).await
}

async fn send_body<B>(
    url: &ServerUrl,
    method: Method,
    path: &str,
    bearer: Option<&str>,
    headers: &[(HeaderName, String)],
    body: B,
) -> Result<Response<Incoming>, NetError>
where
    B: Body + Send + 'static,
    B::Data: Send,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let io = stream::connect(url).await.map_err(network)?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(io)).await.map_err(network)?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, url.authority())
        .header(header::USER_AGENT, USER_AGENT)
        .header(header::ACCEPT, "application/json");
    if let Some(token) = bearer {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let request = request.body(body).map_err(network)?;
    sender.send_request(request).await.map_err(network)
}

async fn read_body(response: Response<Incoming>) -> Result<Bytes, NetError> {
    let collected = Limited::new(response.into_body(), MAX_JSON).collect().await.map_err(network)?;
    Ok(collected.to_bytes())
}

fn api_error(status: StatusCode, body: &[u8]) -> NetError {
    #[derive(serde::Deserialize)]
    struct Envelope {
        error: Detail,
    }
    #[derive(serde::Deserialize)]
    struct Detail {
        code: String,
        message: String,
    }
    match serde_json::from_slice::<Envelope>(body) {
        Ok(e) => NetError::Api { status: status.as_u16(), code: e.error.code, message: e.error.message },
        Err(_) => NetError::Api {
            status: status.as_u16(),
            code: format!("http_{}", status.as_u16()),
            message: format!("The server answered with HTTP {status}."),
        },
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::{NetError, api_error, hex};
    use hyper::StatusCode;

    #[test]
    fn error_envelope_is_parsed() {
        let body = br#"{"error":{"code":"slow_down","message":"Wait a little longer"}}"#;
        match api_error(StatusCode::BAD_REQUEST, body) {
            NetError::Api { status, code, message } => {
                assert_eq!((status, code.as_str(), message.as_str()), (400, "slow_down", "Wait a little longer"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn non_json_error_body_falls_back_to_the_status() {
        match api_error(StatusCode::BAD_GATEWAY, b"<html>oops</html>") {
            NetError::Api { status, code, message } => {
                assert_eq!((status, code.as_str()), (502, "http_502"));
                assert_eq!(message, "The server answered with HTTP 502 Bad Gateway.");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn hex_is_lowercase_and_padded() {
        assert_eq!(hex(&[0x00, 0x0f, 0xab]), "000fab");
    }
}
