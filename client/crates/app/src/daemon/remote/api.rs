//! `/api/client/jobs`: this device submitting jobs to printers on other devices.

use crate::net::{NetError, ServerUrl, http};
use crate::proto::RemotePrinter;
use pb_print::share::{SharedJob, SharedJobState};
use serde::{Deserialize, Serialize};

const MAX_REQUESTER: usize = 100;

/// The fields of the server's `Job` this client reads.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerJob {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub status_message: Option<String>,
}

#[derive(Deserialize)]
struct One {
    job: ServerJob,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Created {
    job: ServerJob,
    upload_url: String,
}

/// An authenticated connection target: the paired server and the device token.
pub struct Server {
    pub url: ServerUrl,
    pub token: String,
}

impl Server {
    /// Opens a job in `uploading` state; returns it with the path its document goes to.
    pub async fn create(&self, printer_id: &str, job: &SharedJob, size: u64) -> Result<(ServerJob, String), NetError> {
        let content_type = job.doc.format.mime();
        let body = NewJob {
            printer_id,
            title: &job.title,
            content_type,
            size,
            file_name: file_name(&job.title, job.doc.path.extension().and_then(|e| e.to_str())),
            options: &job.options,
            requested_by: job.user.as_deref().map(|u| u.chars().take(MAX_REQUESTER).collect()),
        };
        let created: Created = http::post_json(&self.url, "/api/client/jobs", &body, Some(&self.token)).await?;
        let path = upload_path(&created.upload_url).unwrap_or_else(|| format!("/api/client/jobs/{}/file", created.job.id));
        Ok((created.job, path))
    }

    pub async fn upload(&self, path: &str, job: &SharedJob) -> Result<ServerJob, NetError> {
        let one: One = http::put_file(&self.url, path, &self.token, &job.doc.path, job.doc.format.mime()).await?;
        Ok(one.job)
    }

    pub async fn get(&self, id: &str) -> Result<ServerJob, NetError> {
        let one: One = http::get_json(&self.url, &format!("/api/client/jobs/{id}"), Some(&self.token)).await?;
        Ok(one.job)
    }

    pub async fn cancel(&self, id: &str) -> Result<ServerJob, NetError> {
        let path = format!("/api/client/jobs/{id}/cancel");
        let one: One = http::post_json(&self.url, &path, &serde_json::json!({}), Some(&self.token)).await?;
        Ok(one.job)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewJob<'a> {
    printer_id: &'a str,
    title: &'a str,
    content_type: &'a str,
    size: u64,
    file_name: String,
    options: &'a pb_print::JobOptions,
    #[serde(skip_serializing_if = "Option::is_none")]
    requested_by: Option<String>,
}

fn file_name(title: &str, extension: Option<&str>) -> String {
    match extension {
        Some(ext) if !title.to_ascii_lowercase().ends_with(&format!(".{}", ext.to_ascii_lowercase())) => format!("{title}.{ext}"),
        _ => title.to_string(),
    }
}

/// The path of an absolute `uploadUrl`. Only the path is used: the token goes to the paired server only.
fn upload_path(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    rest.find('/').map(|i| rest[i..].to_string()).filter(|p| p.starts_with("/api/client/jobs/"))
}

/// What the IPP client sees for a server job; `owner` is the printer from the latest snapshot.
pub fn ipp_state(job: &ServerJob, owner: Option<&RemotePrinter>) -> (SharedJobState, Option<String>) {
    let message = job.status_message.clone().filter(|m| !m.is_empty());
    match job.status.as_str() {
        "printing" => (SharedJobState::Processing, message),
        "completed" => (SharedJobState::Completed, None),
        "failed" => (SharedJobState::Aborted, message.or_else(|| Some("The job failed.".into()))),
        "canceled" => (SharedJobState::Canceled, None),
        _ => match owner.filter(|p| !p.online) {
            Some(p) => (SharedJobState::Pending, Some(format!("Waiting for {}", p.client_name))),
            None => (SharedJobState::Pending, message),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_url_keeps_only_a_job_path() {
        let ok = upload_path("https://print.example.com/api/client/jobs/jb_1/file");
        assert_eq!(ok.as_deref(), Some("/api/client/jobs/jb_1/file"));
        assert_eq!(upload_path("/api/client/jobs/jb_1/file").as_deref(), Some("/api/client/jobs/jb_1/file"));
        assert_eq!(upload_path("https://evil.example/steal"), None);
        assert_eq!(upload_path("https://print.example.com"), None);
    }

    #[test]
    fn file_names_carry_the_document_extension_once() {
        assert_eq!(file_name("Report", Some("pdf")), "Report.pdf");
        assert_eq!(file_name("Report.PDF", Some("pdf")), "Report.PDF");
        assert_eq!(file_name("Photo", None), "Photo");
    }
}
