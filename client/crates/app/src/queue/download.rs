use super::record::file_name;
use super::{Outcome, Run};
use crate::daemon::Daemon;
use crate::net::{NetError, ServerUrl, http};
use std::fs;
use std::path::PathBuf;

/// Fetches a server job's document with the device token and verifies its SHA-256.
pub async fn fetch(d: &Daemon, run: &Run) -> Result<PathBuf, Outcome> {
    let offer = run.rec.offer.as_ref().ok_or_else(|| Outcome::Failed("The job is missing its document.".into()))?;
    let creds = d.credentials().ok_or_else(|| Outcome::Retry("This device is not paired.".into()))?;
    let server = ServerUrl::parse(&creds.server).map_err(Outcome::Failed)?;
    if !offer.file_url.starts_with('/') {
        return Err(Outcome::Failed("The job has an invalid document address.".into()));
    }
    let dest = d.queue.spool.join(file_name(&run.rec.id));
    let part = dest.with_extension("part");
    let result = tokio::select! {
        result = http::download(&server, &offer.file_url, &creds.token, &part) => result,
        _ = run.cancel.canceled() => {
            let _ = fs::remove_file(&part);
            return Err(Outcome::Canceled);
        }
    };
    match result {
        Ok(got) if got.sha256.eq_ignore_ascii_case(&offer.sha256) => {
            fs::rename(&part, &dest).map_err(|e| Outcome::Retry(format!("Couldn't save the document: {e}")))?;
            log::debug!("job {}: downloaded {} bytes", run.rec.id, got.size);
            d.queue.set_file(run, dest.clone());
            Ok(dest)
        }
        Ok(_) => {
            let _ = fs::remove_file(&part);
            Err(Outcome::Retry("The document arrived damaged. Downloading it again.".into()))
        }
        Err(NetError::Api { status: 404 | 410, .. }) => {
            Err(Outcome::Failed("The document is no longer available on the server.".into()))
        }
        Err(e) => {
            let _ = fs::remove_file(&part);
            Err(Outcome::Retry(format!("Couldn't download the document: {e}")))
        }
    }
}
