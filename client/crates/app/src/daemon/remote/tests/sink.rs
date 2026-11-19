use super::{FakeServer, TOKEN, daemon, printer, until};
use crate::daemon::remote::api::{ServerJob, ipp_state};
use crate::daemon::remote::sink::{NOT_READY, RemoteSink};
use crate::test_util::TempDir;
use pb_print::share::{ShareSink, SharedJob, SharedJobState};
use pb_print::{DocFormat, Document, JobOptions};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};

const PDF: &[u8] = b"%PDF-1.7\n% remote job\n";
type Poll = (&'static str, Option<&'static str>);

fn job(dir: &TempDir) -> SharedJob {
    let path = dir.path().join("spooled.pdf");
    std::fs::write(&path, PDF).unwrap();
    SharedJob {
        printer_key: "pr_07".into(),
        title: "Quarterly report".into(),
        user: Some("ryan".into()),
        doc: Document { path, format: DocFormat::Pdf, name: "Quarterly report".into() },
        options: JobOptions { copies: Some(2), ..JobOptions::default() },
    }
}

fn reply(status: &str, message: Option<&str>) -> Value {
    json!({ "job": { "id": "jb_1", "status": status, "statusMessage": message } })
}

/// Creates jb_1 (with an uploadUrl on another origin), takes its upload, and answers each
/// poll with the next of `polls`, repeating the last.
async fn server(polls: &'static [Poll]) -> FakeServer {
    let gets = AtomicUsize::new(0);
    FakeServer::start(move |seen| match (seen.method.as_str(), seen.path.as_str()) {
        ("POST", "/api/client/jobs") => {
            let mut created = reply("uploading", None);
            created["uploadUrl"] = json!("https://cdn.example.com/api/client/jobs/jb_1/file");
            (201, created)
        }
        ("PUT", "/api/client/jobs/jb_1/file") => (200, reply("queued", None)),
        ("GET", "/api/client/jobs/jb_1") => {
            let (status, message) = polls[gets.fetch_add(1, Ordering::SeqCst).min(polls.len() - 1)];
            (200, reply(status, message))
        }
        ("POST", "/api/client/jobs/jb_1/cancel") => (200, reply("canceled", None)),
        _ => (404, json!({ "error": { "code": "not_found", "message": "Not found" } })),
    })
    .await
}

fn state(sink: &RemoteSink, id: u32) -> (SharedJobState, Option<String>) {
    sink.state(id).unwrap()
}

#[tokio::test]
async fn jobs_are_refused_as_not_ready_while_the_session_is_down() {
    let dir = TempDir::new();
    let d = daemon(&dir, "http://127.0.0.1:1");
    d.outbox.set_online(false);
    let sink = RemoteSink::new(d.clone());
    assert_eq!(sink.submit(job(&dir)), Err(NOT_READY.to_string()));
    d.forget_credentials();
    d.outbox.set_online(true);
    assert_eq!(sink.submit(job(&dir)), Err(NOT_READY.to_string()));
    assert!(dir.path().join("spooled.pdf").exists(), "the share server owns a refused document");
}

#[tokio::test]
async fn a_job_is_created_uploaded_and_followed_to_completion() {
    let server = server(&[("dispatched", None), ("printing", None), ("completed", None)]).await;
    let dir = TempDir::new();
    let d = daemon(&dir, &server.origin);
    d.set_remote_printers(vec![printer("pr_07", "Upstairs laser", None, "Den Pi", true)]);
    let sink = RemoteSink::new(d);
    let id = sink.submit(job(&dir)).unwrap();
    assert_eq!(state(&sink, id), (SharedJobState::Pending, Some("Sending to Print Better".into())));
    until("completion", || state(&sink, id).0 == SharedJobState::Completed).await;
    let polls = vec!["GET /api/client/jobs/jb_1"; 3];
    let expected = [vec!["POST /api/client/jobs", "PUT /api/client/jobs/jb_1/file"], polls].concat();
    assert_eq!(server.requests(), expected);
    server.with(|seen| {
        assert!(seen.iter().all(|s| s.auth.as_deref() == Some(&*format!("Bearer {TOKEN}"))));
        let created: Value = serde_json::from_slice(&seen[0].body).unwrap();
        let wanted = json!({
            "printerId": "pr_07", "title": "Quarterly report", "contentType": "application/pdf", "size": PDF.len(),
            "fileName": "Quarterly report.pdf", "options": { "copies": 2 }, "requestedBy": "ryan"
        });
        assert_eq!(created, wanted);
        let upload = &seen[1];
        assert_eq!((upload.content_type.as_deref(), upload.content_length.as_deref()), (Some("application/pdf"), Some("22")));
        assert_eq!(upload.body, PDF);
    });
    assert!(!dir.path().join("spooled.pdf").exists(), "the spool file goes once uploaded");
}

#[tokio::test]
async fn a_waiting_job_names_the_offline_device_and_cancel_reaches_the_server() {
    let server = server(&[("queued", None)]).await;
    let dir = TempDir::new();
    let d = daemon(&dir, &server.origin);
    d.set_remote_printers(vec![printer("pr_07", "Upstairs laser", None, "Den Pi", false)]);
    let sink = RemoteSink::new(d);
    let id = sink.submit(job(&dir)).unwrap();
    let waiting = (SharedJobState::Pending, Some("Waiting for Den Pi".to_string()));
    until("the waiting message", || server.requests().len() > 2 && state(&sink, id) == waiting).await;
    assert!(sink.cancel(id));
    until("cancellation", || state(&sink, id).0 == SharedJobState::Canceled).await;
    assert_eq!(server.requests().iter().filter(|r| r.ends_with("/cancel")).count(), 1);
    assert!(!sink.cancel(id), "already over");
}

#[tokio::test]
async fn failures_carry_the_servers_message() {
    let server = server(&[("failed", Some("Out of paper"))]).await;
    let dir = TempDir::new();
    let sink = RemoteSink::new(daemon(&dir, &server.origin));
    let id = sink.submit(job(&dir)).unwrap();
    until("failure", || state(&sink, id).0 == SharedJobState::Aborted).await;
    assert_eq!(state(&sink, id).1.as_deref(), Some("Out of paper"));

    let refusing = FakeServer::start(|_| (404, json!({ "error": { "code": "printer_not_found", "message": "Printer not found" } }))).await;
    let dir = TempDir::new();
    let sink = RemoteSink::new(daemon(&dir, &refusing.origin));
    let id = sink.submit(job(&dir)).unwrap();
    until("refusal", || state(&sink, id).0 == SharedJobState::Aborted).await;
    assert!(state(&sink, id).1.unwrap().contains("Printer not found"));
    assert_eq!(refusing.requests(), ["POST /api/client/jobs"]);
    assert!(!dir.path().join("spooled.pdf").exists());
}

#[tokio::test]
async fn a_printer_this_computer_may_not_use_fails_the_job_with_a_plain_reason() {
    for status in [403, 404] {
        let refusing = FakeServer::start(move |_| (status, json!({ "error": { "code": "printer_access_denied", "message": "Denied" } }))).await;
        let dir = TempDir::new();
        let sink = RemoteSink::new(daemon(&dir, &refusing.origin));
        let id = sink.submit(job(&dir)).unwrap();
        until("refusal", || state(&sink, id).0 == SharedJobState::Aborted).await;
        assert_eq!(state(&sink, id).1.as_deref(), Some("You can't print to this printer from this computer"), "{status}");
        assert_eq!(refusing.requests(), ["POST /api/client/jobs"]);
    }
}

#[tokio::test]
async fn a_broken_upload_is_aborted_and_withdrawn_from_the_server() {
    let server = FakeServer::start(|seen| match seen.method.as_str() {
        "PUT" => (500, json!({ "error": { "code": "internal", "message": "Storage is down" } })),
        _ => (201, json!({ "job": { "id": "jb_1", "status": "uploading" }, "uploadUrl": "/api/client/jobs/jb_1/file" })),
    })
    .await;
    let dir = TempDir::new();
    let sink = RemoteSink::new(daemon(&dir, &server.origin));
    let id = sink.submit(job(&dir)).unwrap();
    until("the abort", || state(&sink, id).0 == SharedJobState::Aborted && server.requests().len() == 3).await;
    assert!(state(&sink, id).1.unwrap().contains("Storage is down"));
    assert_eq!(server.requests()[2], "POST /api/client/jobs/jb_1/cancel");
    assert!(!dir.path().join("spooled.pdf").exists());
}

#[test]
fn server_states_map_to_ipp_states() {
    let job = |status: &str, message: Option<&str>| ServerJob { id: "j".into(), status: status.into(), status_message: message.map(String::from) };
    let online = printer("pr_07", "Laser", None, "Den Pi", true);
    let offline = printer("pr_07", "Laser", None, "Den Pi", false);
    let waiting = Some("Waiting for Den Pi".to_string());
    for status in ["uploading", "queued", "dispatched"] {
        assert_eq!(ipp_state(&job(status, None), Some(&offline)), (SharedJobState::Pending, waiting.clone()), "{status}");
        assert_eq!(ipp_state(&job(status, Some("Paused")), Some(&online)), (SharedJobState::Pending, Some("Paused".into())));
        assert_eq!(ipp_state(&job(status, None), None), (SharedJobState::Pending, None));
    }
    assert_eq!(ipp_state(&job("printing", Some("Page 2")), Some(&online)), (SharedJobState::Processing, Some("Page 2".into())));
    assert_eq!(ipp_state(&job("completed", Some("done")), Some(&offline)), (SharedJobState::Completed, None));
    assert_eq!(ipp_state(&job("failed", Some("Jammed")), None), (SharedJobState::Aborted, Some("Jammed".into())));
    assert_eq!(ipp_state(&job("failed", None), None), (SharedJobState::Aborted, Some("The job failed.".into())));
    assert_eq!(ipp_state(&job("canceled", None), Some(&online)), (SharedJobState::Canceled, None));
}
