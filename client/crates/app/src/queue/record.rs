//! One persisted JSON file per job, so the queue survives crashes and restarts.

use crate::fsx;
use crate::proto::{JobOffer, JobStatus};
use pb_print::JobOptions;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// Dispatched by the server; status is reported with `job_status`.
    Server,
    /// Received over LAN sharing; reported with `lan_job` (history only).
    Lan,
    /// `printbetter print` through the local API; not reported.
    Local,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub id: String,
    pub source: Source,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offer: Option<JobOffer>,
    /// Job id handed to IPP clients for LAN and local jobs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_id: Option<u32>,
    pub printer_key: String,
    pub title: String,
    pub user: Option<String>,
    pub content_type: String,
    pub size: u64,
    pub options: JobOptions,
    /// Server-clock milliseconds; the 24 h give-up window starts here.
    pub created_at: i64,
    pub status: JobStatus,
    pub message: Option<String>,
    pub pages: Option<u32>,
    /// Spooled document, deleted once the job is final.
    pub file: Option<PathBuf>,
    pub updated_at: i64,
    #[serde(default)]
    pub tries: u32,
    #[serde(default)]
    pub retry_at: i64,
}

impl JobRecord {
    pub fn from_offer(offer: JobOffer, now: i64) -> JobRecord {
        JobRecord {
            id: offer.id.clone(),
            source: Source::Server,
            share_id: None,
            printer_key: offer.printer_key.clone(),
            title: offer.title.clone(),
            user: None,
            content_type: offer.content_type.clone(),
            size: offer.size,
            options: offer.options.clone(),
            created_at: offer.created_at,
            status: JobStatus::Dispatched,
            message: None,
            pages: None,
            file: None,
            updated_at: now,
            tries: 0,
            retry_at: 0,
            offer: Some(offer),
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self.status, JobStatus::Completed | JobStatus::Failed | JobStatus::Canceled)
    }

    pub fn attempt(&self) -> u32 {
        self.offer.as_ref().map_or(0, |o| o.attempt)
    }

    /// Marks the job final and deletes its spooled document.
    pub fn finish(&mut self, status: JobStatus, message: Option<String>, pages: Option<u32>, now: i64) {
        self.status = status;
        self.message = message;
        self.pages = pages.or(self.pages);
        self.updated_at = now;
        if let Some(file) = self.file.take() {
            let _ = fs::remove_file(file);
        }
    }
}

/// Job ids come from the server; keep file names to a safe alphabet.
pub fn file_name(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Store {
        Store { dir }
    }

    pub fn load_all(&self) -> Vec<JobRecord> {
        let Ok(entries) = fs::read_dir(&self.dir) else { return Vec::new() };
        entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "json"))
            .filter_map(|path| match fsx::read_json::<JobRecord>(&path) {
                Ok(record) => record,
                Err(e) => {
                    log::warn!("dropping unreadable job file {}: {e}", path.display());
                    let _ = fs::remove_file(&path);
                    None
                }
            })
            .collect()
    }

    pub fn save(&self, record: &JobRecord) {
        let path = self.dir.join(format!("{}.json", file_name(&record.id)));
        if let Err(e) = fsx::write_json(&path, record, false) {
            log::error!("could not save job {}: {e}", record.id);
        }
    }

    pub fn remove(&self, id: &str) {
        let _ = fsx::remove_if_exists(&self.dir.join(format!("{}.json", file_name(id))));
    }
}
