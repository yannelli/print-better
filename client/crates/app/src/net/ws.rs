use super::stream::{self, Stream};
use super::{ServerUrl, USER_AGENT};
use crate::proto::PROTOCOL_VERSION;
use std::time::Duration;
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::http::Uri;
use tokio_tungstenite::tungstenite::{self, ClientRequestBuilder};

pub type Socket = WebSocketStream<Stream>;

pub enum ConnectError {
    /// 401 on upgrade: the device token was revoked.
    Unauthorized,
    Failed(String),
}

pub async fn connect(url: &ServerUrl, token: &str) -> Result<Socket, ConnectError> {
    let uri: Uri = url.websocket("/api/client/ws").parse().map_err(|e| ConnectError::Failed(format!("{e}")))?;
    let request = ClientRequestBuilder::new(uri)
        .with_header("Authorization", format!("Bearer {token}"))
        .with_header("X-PB-Protocol", PROTOCOL_VERSION.to_string())
        .with_header("User-Agent", USER_AGENT);
    let io = stream::connect(url).await.map_err(|e| ConnectError::Failed(e.to_string()))?;
    match timeout(Duration::from_secs(15), tokio_tungstenite::client_async(request, io)).await {
        Err(_) => Err(ConnectError::Failed("the server did not accept the connection in time".into())),
        Ok(Ok((socket, _))) => Ok(socket),
        Ok(Err(tungstenite::Error::Http(response))) if response.status() == 401 => Err(ConnectError::Unauthorized),
        Ok(Err(tungstenite::Error::Http(response))) => {
            Err(ConnectError::Failed(format!("the server refused the connection (HTTP {})", response.status())))
        }
        Ok(Err(e)) => Err(ConnectError::Failed(e.to_string())),
    }
}
