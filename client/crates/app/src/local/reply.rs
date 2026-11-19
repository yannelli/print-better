use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode, header};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::json;

pub type Reply = Response<Full<Bytes>>;

pub const MAX_JSON: usize = 64 * 1024;
const CSP: &str = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; \
                   connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

pub fn json(status: StatusCode, value: &impl Serialize) -> Reply {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    build(status, "application/json", Bytes::from(body))
}

/// Same error shape as the server API: `{ error: { code, message } }`.
pub fn error(status: StatusCode, code: &str, message: &str) -> Reply {
    json(status, &json!({ "error": { "code": code, "message": message } }))
}

pub fn asset(content_type: &str, body: &'static str) -> Reply {
    let mut reply = build(StatusCode::OK, content_type, Bytes::from_static(body.as_bytes()));
    let headers = reply.headers_mut();
    if let Ok(csp) = CSP.parse() {
        headers.insert(header::CONTENT_SECURITY_POLICY, csp);
    }
    headers.insert(header::X_FRAME_OPTIONS, header::HeaderValue::from_static("DENY"));
    reply
}

fn build(status: StatusCode, content_type: &str, body: Bytes) -> Reply {
    let mut reply = Response::new(Full::new(body));
    *reply.status_mut() = status;
    let headers = reply.headers_mut();
    if let Ok(value) = content_type.parse() {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, header::HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, header::HeaderValue::from_static("no-referrer"));
    reply
}

/// Reads and drops up to `limit` bytes of the request body. Replying without reading it makes
/// the close reset the connection, and the client can lose the reply.
pub async fn discard(req: Request<Incoming>, limit: usize) {
    let mut body = req.into_body();
    let mut seen = 0;
    while seen <= limit {
        match body.frame().await {
            Some(Ok(frame)) => seen += frame.data_ref().map_or(0, Bytes::len),
            _ => return,
        }
    }
}

pub async fn read_json<T: DeserializeOwned>(req: Request<Incoming>) -> Result<T, Reply> {
    let bytes = Limited::new(req.into_body(), MAX_JSON)
        .collect()
        .await
        .map_err(|_| error(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "Request body is too large."))?
        .to_bytes();
    let bytes = if bytes.is_empty() { Bytes::from_static(b"{}") } else { bytes };
    serde_json::from_slice(&bytes).map_err(|e| error(StatusCode::BAD_REQUEST, "bad_request", &e.to_string()))
}
