//! Enrollment-token and RFC 8628-style device-code pairing (docs/protocol.md).

use crate::net::{NetError, ServerUrl, http};
use crate::platform;
use crate::store::Credentials;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::time::{Instant, sleep};

const EXPIRED: &str = "The code expired. Start pairing again.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceInfo<'a> {
    hostname: String,
    os: &'static str,
    arch: &'static str,
    version: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<&'a str>,
}

impl<'a> DeviceInfo<'a> {
    fn new(name: Option<&'a str>, token: Option<&'a str>) -> Self {
        let name = name.map(str::trim).filter(|n| !n.is_empty());
        DeviceInfo { hostname: platform::hostname(), os: platform::os(), arch: platform::arch(), version: crate::VERSION, name, token }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Issued {
    client_id: String,
    workspace_id: String,
    name: String,
    token: String,
}

impl Issued {
    fn into_credentials(self, server: &ServerUrl) -> Credentials {
        Credentials {
            server: server.origin(),
            client_id: self.client_id,
            workspace_id: self.workspace_id,
            name: self.name,
            token: self.token,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub interval: u64,
    pub expires_in: u64,
}

pub async fn enroll(server: &ServerUrl, token: &str, name: Option<&str>) -> Result<Credentials, String> {
    let body = DeviceInfo::new(name, Some(token.trim()));
    let issued: Issued = http::post_json(server, "/api/client/enroll", &body, None).await.map_err(describe)?;
    Ok(issued.into_credentials(server))
}

pub async fn request_code(server: &ServerUrl, name: Option<&str>) -> Result<DeviceCode, String> {
    http::post_json(server, "/api/client/device/code", &DeviceInfo::new(name, None), None).await.map_err(describe)
}

/// Polls until the code is approved, denied, or expires, honoring `slow_down`.
pub async fn wait_for_approval(server: &ServerUrl, code: &DeviceCode) -> Result<Credentials, String> {
    let mut interval = Duration::from_secs(code.interval.max(1));
    let deadline = Instant::now() + Duration::from_secs(code.expires_in.max(1));
    let body = serde_json::json!({ "deviceCode": code.device_code });
    loop {
        sleep(interval).await;
        if Instant::now() >= deadline {
            return Err(EXPIRED.into());
        }
        match step(http::post_json::<_, Issued>(server, "/api/client/device/token", &body, None).await) {
            Step::Approved(issued) => return Ok(issued.into_credentials(server)),
            Step::Pending => {}
            Step::SlowDown => interval += Duration::from_secs(5),
            Step::Failed(message) => return Err(message),
        }
    }
}

/// What one `device/token` answer means for the polling loop.
enum Step {
    Approved(Issued),
    Pending,
    SlowDown,
    Failed(String),
}

fn step(answer: Result<Issued, NetError>) -> Step {
    match answer {
        Ok(issued) => Step::Approved(issued),
        Err(NetError::Api { status, message, .. }) if status >= 500 => {
            log::warn!("pairing check failed, will retry: {message}");
            Step::Pending
        }
        Err(NetError::Api { code, .. }) => match code.as_str() {
            "authorization_pending" => Step::Pending,
            "slow_down" => Step::SlowDown,
            "access_denied" => Step::Failed("Pairing was declined in the browser.".into()),
            "expired_token" => Step::Failed(EXPIRED.into()),
            _ => Step::Failed(format!("Pairing failed ({code}).")),
        },
        Err(NetError::Network(e)) => {
            log::warn!("pairing check failed, will retry: {e}");
            Step::Pending
        }
    }
}

fn describe(e: NetError) -> String {
    match e {
        NetError::Network(m) => format!("Could not reach the server: {m}"),
        NetError::Api { message, .. } => message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn api(status: u16, code: &str) -> Result<Issued, NetError> {
        Err(NetError::Api { status, code: code.into(), message: format!("{code} message") })
    }

    #[test]
    fn enroll_answer_becomes_credentials_for_the_normalized_origin() {
        let body = json!({ "clientId": "c1", "workspaceId": "w1", "name": "Kitchen", "token": "pbc_x", "extra": 1 });
        let issued: Issued = serde_json::from_value(body).unwrap();
        let creds = issued.into_credentials(&ServerUrl::parse("Print.Example.com:443/ignored").unwrap());
        assert_eq!(creds.server, "https://print.example.com");
        assert_eq!((creds.client_id.as_str(), creds.workspace_id.as_str()), ("c1", "w1"));
        assert_eq!((creds.name.as_str(), creds.token.as_str()), ("Kitchen", "pbc_x"));
    }

    #[test]
    fn enroll_answer_missing_a_field_is_rejected() {
        let body = json!({ "clientId": "c1", "workspaceId": "w1", "name": "Kitchen" });
        assert!(serde_json::from_value::<Issued>(body).is_err());
    }

    #[test]
    fn device_code_answer_parses() {
        let body = json!({
            "deviceCode": "pbd_secret", "userCode": "ABCD-EFGH",
            "verificationUri": "https://p.example/device",
            "verificationUriComplete": "https://p.example/device?code=ABCD-EFGH",
            "interval": 5, "expiresIn": 600
        });
        let code: DeviceCode = serde_json::from_value(body).unwrap();
        assert_eq!((code.device_code.as_str(), code.user_code.as_str()), ("pbd_secret", "ABCD-EFGH"));
        assert_eq!(code.verification_uri_complete, "https://p.example/device?code=ABCD-EFGH");
        assert_eq!((code.interval, code.expires_in), (5, 600));
    }

    #[test]
    fn polling_answers_map_to_steps() {
        let issued = Issued { client_id: "c".into(), workspace_id: "w".into(), name: "n".into(), token: "t".into() };
        assert!(matches!(step(Ok(issued)), Step::Approved(_)));
        assert!(matches!(step(api(400, "authorization_pending")), Step::Pending));
        assert!(matches!(step(api(400, "slow_down")), Step::SlowDown));
        assert!(matches!(step(api(503, "unavailable")), Step::Pending));
        assert!(matches!(step(Err(NetError::Network("reset".into()))), Step::Pending));
        let failed = |answer| match step(answer) {
            Step::Failed(message) => message,
            _ => panic!("expected a failure"),
        };
        assert_eq!(failed(api(400, "access_denied")), "Pairing was declined in the browser.");
        assert_eq!(failed(api(400, "expired_token")), EXPIRED);
        assert_eq!(failed(api(401, "invalid_token")), "Pairing failed (invalid_token).");
    }

    #[test]
    fn device_info_omits_blank_name_and_missing_token() {
        let body = serde_json::to_value(DeviceInfo::new(Some("   "), None)).unwrap();
        assert!(body.get("name").is_none() && body.get("token").is_none());
        assert_eq!(body["version"], crate::VERSION);
        let body = serde_json::to_value(DeviceInfo::new(Some(" Den "), Some("pbe_1"))).unwrap();
        assert_eq!((body["name"].clone(), body["token"].clone()), (Value::from("Den"), Value::from("pbe_1")));
    }
}
