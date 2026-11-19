//! Request bodies: the IPP message is parsed incrementally, then the document that follows it is
//! streamed to the spool directory without buffering it in memory.

use crate::ipp::codec::DecodeError;
use crate::ipp::Message;
use crate::model::DocFormat;
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;

const MAX_HEAD: usize = 1 << 20;
// Small under test so the cap can be exercised without spooling a gigabyte.
const MAX_DOCUMENT: u64 = if cfg!(test) { 1 << 20 } else { 1 << 30 };
const READ_TIMEOUT: Duration = Duration::from_secs(60);

static SEQ: AtomicU64 = AtomicU64::new(0);

pub(super) enum HeadError {
    TooLarge,
    Invalid(&'static str),
    Read(String),
}

pub(super) enum SpoolError {
    TooLarge,
    Disk(std::io::Error),
    Read(String),
}

/// The part of a request body after the IPP message: document data, possibly empty.
pub(super) struct Upload {
    leftover: Bytes,
    body: Incoming,
}

pub(super) async fn read_head(mut body: Incoming) -> Result<(Message, Upload), HeadError> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match Message::decode(&buf) {
            Ok((msg, used)) => {
                let leftover = Bytes::copy_from_slice(buf.get(used..).unwrap_or_default());
                return Ok((msg, Upload { leftover, body }));
            }
            Err(DecodeError::Truncated) if buf.len() >= MAX_HEAD => return Err(HeadError::TooLarge),
            Err(DecodeError::Truncated) => {}
            Err(DecodeError::Invalid(why)) => return Err(HeadError::Invalid(why)),
        }
        match next(&mut body).await.map_err(HeadError::Read)? {
            Some(data) => buf.extend_from_slice(&data),
            None => return Err(HeadError::Invalid("request ended inside the IPP message")),
        }
    }
}

/// Next data chunk of the body; None at the end.
async fn next(body: &mut Incoming) -> Result<Option<Bytes>, String> {
    loop {
        let frame = match tokio::time::timeout(READ_TIMEOUT, body.frame()).await {
            Err(_) => return Err("client stopped sending".into()),
            Ok(None) => return Ok(None),
            Ok(Some(Err(e))) => return Err(e.to_string()),
            Ok(Some(Ok(frame))) => frame,
        };
        if let Ok(data) = frame.into_data() {
            return Ok(Some(data));
        }
    }
}

impl Upload {
    /// Writes the document into `dir`; None when the request carried no document data.
    pub async fn spool(mut self, dir: &Path) -> Result<Option<Spooled>, SpoolError> {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let base = format!("{nanos}-{}", SEQ.fetch_add(1, Ordering::Relaxed));
        let temp = TempFile { path: dir.join(format!("{base}.part")), keep: false };
        let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&temp.path).await.map_err(SpoolError::Disk)?;
        let mut size = 0u64;
        let mut head = Vec::with_capacity(16);
        let mut chunk = Some(std::mem::take(&mut self.leftover)).filter(|b| !b.is_empty());
        loop {
            let data = match chunk.take() {
                Some(data) => data,
                None => match next(&mut self.body).await.map_err(SpoolError::Read)? {
                    Some(data) => data,
                    None => break,
                },
            };
            size += data.len() as u64;
            if size > MAX_DOCUMENT {
                return Err(SpoolError::TooLarge);
            }
            if head.len() < 16 {
                head.extend(data.iter().take(16 - head.len()));
            }
            file.write_all(&data).await.map_err(SpoolError::Disk)?;
        }
        file.flush().await.map_err(SpoolError::Disk)?;
        Ok((size > 0).then_some(Spooled { temp, base, head }))
    }
}

pub(super) struct Spooled {
    temp: TempFile,
    base: String,
    head: Vec<u8>,
}

impl Spooled {
    pub fn sniff(&self) -> DocFormat {
        DocFormat::sniff(&self.head)
    }

    /// Gives the file its final name; from here on the caller owns it.
    pub async fn keep(mut self, format: DocFormat) -> std::io::Result<PathBuf> {
        let dir = self.temp.path.parent().map(Path::to_path_buf).unwrap_or_default();
        let path = dir.join(format!("{}.{}", self.base, extension(format)));
        tokio::fs::rename(&self.temp.path, &path).await?;
        self.temp.keep = true;
        Ok(path)
    }
}

/// Deletes the spool file unless it was handed on, including when a request is abandoned midway.
struct TempFile {
    path: PathBuf,
    keep: bool,
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if !self.keep
            && let Err(e) = std::fs::remove_file(&self.path)
        {
            log::debug!("share: removing {}: {e}", self.path.display());
        }
    }
}

fn extension(format: DocFormat) -> &'static str {
    match format {
        DocFormat::Pdf => "pdf",
        DocFormat::Jpeg => "jpg",
        DocFormat::Png => "png",
        DocFormat::Text => "txt",
        DocFormat::Urf => "urf",
        DocFormat::PwgRaster => "pwg",
        DocFormat::Pcl => "pcl",
        DocFormat::PostScript => "ps",
        DocFormat::Unknown => "bin",
    }
}
