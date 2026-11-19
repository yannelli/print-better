//! AppSocket / JetDirect (TCP 9100): raw bytes, no framing, no acknowledgements.

use super::{Events, Payload, Progress, connect, endpoint, pump};
use crate::engine::{CancelFlag, PrintEvent};
use crate::error::{Error, Result};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Many printers close the connection once the job is through; wait that long at most.
const DRAIN: Duration = Duration::from_secs(300);

pub(crate) async fn send(uri: &str, payload: &Payload, cancel: &CancelFlag, on_event: Events<'_>) -> Result<()> {
    let ep = endpoint(uri, 9100)?;
    let mut stream = tokio::select! {
        r = connect(&ep.host, ep.port) => r?,
        _ = cancel.canceled() => return Err(Error::Canceled),
    };
    on_event(PrintEvent::Printing { pages_done: None });
    let mut progress = Progress::new(on_event, cancel);
    pump(&mut stream, payload, payload.repeat, &mut progress).await?;
    if stream.shutdown().await.is_err() {
        return Err(progress.failed());
    }
    drain(&mut stream, cancel).await;
    Ok(())
}

/// Reads the back channel until the printer hangs up, so closing never resets unread data.
async fn drain(stream: &mut TcpStream, cancel: &CancelFlag) {
    let mut buf = [0u8; 4096];
    let reading = async {
        while let Ok(n) = stream.read(&mut buf).await {
            if n == 0 {
                break;
            }
        }
    };
    tokio::select! {
        _ = tokio::time::timeout(DRAIN, reading) => {}
        _ = cancel.canceled() => {}
    }
}

/// Connectivity check that sends nothing.
pub(crate) async fn probe(uri: &str, default_port: u16) -> Result<()> {
    let ep = endpoint(uri, default_port)?;
    connect(&ep.host, ep.port).await.map(drop)
}
