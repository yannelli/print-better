//! LPD client (RFC 1179): control file first, then the data file, one acknowledgement per step.

use super::{Events, Payload, Progress, connect, endpoint, percent_decode, pump};
use crate::engine::{CancelFlag, PrintEvent};
use crate::error::{Error, Result};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const ACK_TIMEOUT: Duration = Duration::from_secs(60);
const HOST: &str = "printbetter";

fn field(value: &str, max: usize) -> String {
    let v: String = value.chars().filter(|c| c.is_ascii_graphic() || *c == ' ').take(max).collect();
    if v.trim().is_empty() { "printbetter".into() } else { v }
}

async fn ack(stream: &mut TcpStream, cancel: &CancelFlag) -> Result<bool> {
    let mut byte = [0u8; 1];
    tokio::select! {
        r = tokio::time::timeout(ACK_TIMEOUT, stream.read_exact(&mut byte)) => Ok(matches!(r, Ok(Ok(_))) && byte[0] == 0),
        _ = cancel.canceled() => Err(Error::Canceled),
    }
}

async fn step(stream: &mut TcpStream, bytes: &[u8], cancel: &CancelFlag, refused: impl Fn() -> Error) -> Result<()> {
    if stream.write_all(bytes).await.is_err() || !ack(stream, cancel).await? {
        return Err(refused());
    }
    Ok(())
}

pub(crate) async fn send(
    uri: &str,
    payload: &Payload,
    job_name: &str,
    user: &str,
    cancel: &CancelFlag,
    on_event: Events<'_>,
) -> Result<()> {
    let ep = endpoint(uri, 515)?;
    let queue = match percent_decode(&ep.path) {
        q if q.is_empty() => "lp".to_string(),
        q => q,
    };
    let mut stream = tokio::select! {
        r = connect(&ep.host, ep.port) => r?,
        _ = cancel.canceled() => return Err(Error::Canceled),
    };
    let not_taken = || Error::Unreachable(format!("The printer at {} didn't accept jobs for queue \"{queue}\".", ep.host));
    step(&mut stream, format!("\x02{queue}\n").as_bytes(), cancel, not_taken).await?;

    let number = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.subsec_millis());
    let data_name = format!("dfA{number:03}{HOST}");
    let name = field(job_name, 99);
    // Copies go inside the data file because some LPD servers ignore repeated print lines.
    let control = format!("H{HOST}\nP{}\nJ{name}\nN{name}\nl{data_name}\nU{data_name}\n", field(user, 31));
    let header = format!("\x02{} cfA{number:03}{HOST}\n", control.len());
    step(&mut stream, header.as_bytes(), cancel, not_taken).await?;
    let mut body = control.into_bytes();
    body.push(0);
    step(&mut stream, &body, cancel, not_taken).await?;

    let copies = payload.repeat.max(1);
    let header = format!("\x03{} {data_name}\n", payload.len()? * u64::from(copies));
    step(&mut stream, header.as_bytes(), cancel, not_taken).await?;
    on_event(PrintEvent::Printing { pages_done: None });
    let mut progress = Progress::new(on_event, cancel);
    pump(&mut stream, payload, copies, &mut progress).await?;
    let refused = || Error::Rejected("The printer refused the job after receiving it.".into());
    step(&mut stream, &[0], cancel, refused).await?;
    let _ = stream.shutdown().await;
    Ok(())
}
