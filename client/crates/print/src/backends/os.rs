//! `os://QUEUE` routes: CUPS queues on macOS and Linux (spoken to over IPP), the spooler on Windows.

use super::percent_decode;
use crate::error::{Error, Result};

/// The queue or printer name in `os://NAME` (percent-encoded on the wire).
pub(crate) fn queue_name(uri: &str) -> Result<String> {
    let name = uri.strip_prefix("os://").map(percent_decode).unwrap_or_default();
    let name = name.trim_end_matches('/').to_string();
    if name.is_empty() {
        return Err(Error::Unsupported(format!("The printer address \"{uri}\" isn't valid.")));
    }
    Ok(name)
}

/// The local CUPS scheduler's IPP address for a queue.
#[cfg(not(windows))]
pub(crate) fn cups_uri(uri: &str) -> Result<String> {
    Ok(format!("ipp://localhost:631/printers/{}", super::percent_encode(&queue_name(uri)?)))
}
