use super::{Harness, PDF, ipp, request};
use crate::error::Error;
use crate::ipp::tags::{group, op};
use crate::ipp::{Attribute, IppBody, IppJob, JobStateKind, Value};
use crate::model::{DocFormat, JobOptions, PrinterState, Sides};
use crate::share::SharedJobState;

fn job(format: &str, options: JobOptions) -> IppJob {
    IppJob { name: "Report".into(), user: "alice".into(), format: format.into(), options }
}

async fn print(h: &Harness, format: &str, doc: &[u8]) -> Result<i32, Error> {
    h.ipp.print_job(&h.uri(), &job(format, JobOptions::default()), IppBody::Bytes(doc.to_vec())).await
}

async fn state(h: &Harness, id: i32) -> JobStateKind {
    h.ipp.job_state(&h.uri(), id).await.unwrap().state
}

async fn job_ids(h: &Harness, which: &str) -> Vec<i32> {
    let mut msg = request(op::GET_JOBS, &h.uri());
    msg.operation().push("which-jobs", Value::keyword(which));
    let reply = ipp(h, &msg, b"").await;
    reply.groups_of(group::JOB).filter_map(|g| g.get("job-id").and_then(Attribute::int)).collect()
}

#[tokio::test]
async fn get_printer_attributes_describes_the_shared_printer() {
    let h = Harness::start().await;
    let a = h.ipp.get_printer_attributes(&h.uri()).await.unwrap();
    assert_eq!(a.name.as_deref(), Some("Office Laser"));
    assert_eq!(a.make_model.as_deref(), Some("HP LaserJet Pro M404-M405"));
    assert_eq!(a.uuid, Some(h.served().uuid));
    assert_eq!(a.location.as_deref(), Some("2nd floor"));
    let caps = &a.capabilities;
    assert!(caps.duplex && !caps.color);
    assert_eq!(caps.copies_max, 99);
    for f in ["application/pdf", "image/urf", "image/pwg-raster", "image/jpeg", "image/png"] {
        assert!(caps.formats.iter().any(|x| x == f), "{f} in {:?}", caps.formats);
    }
    assert!(!caps.formats.iter().any(|x| x == "application/postscript"), "not printable here");
    assert!(a.page_ranges_supported && a.identify_supported);
    assert_eq!(a.status.state, PrinterState::Idle);
    h.ipp.identify(&h.uri()).await.unwrap();
}

#[tokio::test]
async fn print_job_spools_the_document_with_its_format_and_options() {
    let h = Harness::start().await;
    let options = JobOptions { copies: Some(2), sides: Some(Sides::TwoSidedLongEdge), page_ranges: Some("2,1".into()), ..JobOptions::default() };
    let id = h.ipp.print_job(&h.uri(), &job("application/pdf", options), IppBody::Bytes(PDF.to_vec())).await.unwrap();
    assert!(id > 0);
    let jobs = h.sink.jobs();
    let j = &jobs[0];
    assert_eq!((j.printer_key.as_str(), j.title.as_str(), j.user.as_deref()), ("uuid:5f0c2a7e", "Report", Some("alice")));
    assert_eq!(j.doc.format, DocFormat::Pdf);
    assert_eq!(j.doc.path.parent(), Some(h.spool.path()));
    assert_eq!(j.doc.path.extension().and_then(|e| e.to_str()), Some("pdf"));
    assert_eq!(std::fs::read(&j.doc.path).unwrap(), PDF);
    assert_eq!((j.options.copies, j.options.sides, j.options.page_ranges.as_deref()), (Some(2), Some(Sides::TwoSidedLongEdge), Some("1-2")));
}

#[tokio::test]
async fn octet_stream_documents_are_sniffed() {
    let h = Harness::start().await;
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    print(&h, "", png).await.unwrap();
    let doc = &h.sink.jobs()[0].doc;
    assert_eq!((doc.format, doc.path.extension().and_then(|e| e.to_str())), (DocFormat::Png, Some("png")));
}

#[tokio::test]
async fn unprintable_documents_are_refused_and_nothing_is_kept() {
    let h = Harness::start().await;
    assert!(matches!(print(&h, "application/postscript", b"%!PS").await, Err(Error::Unsupported(_))));
    assert!(matches!(print(&h, "application/octet-stream", b"just some words").await, Err(Error::Unsupported(_))));
    assert!(h.sink.jobs().is_empty());
    assert!(h.spooled_after_cleanup().await.is_empty());
}

#[tokio::test]
async fn job_state_and_cancel_follow_the_sink() {
    let h = Harness::start().await;
    let id = print(&h, "application/pdf", PDF).await.unwrap();
    assert_eq!(state(&h, id).await, JobStateKind::Pending);
    h.sink.set(101, SharedJobState::Processing);
    assert_eq!(state(&h, id).await, JobStateKind::Processing);
    h.ipp.cancel_job(&h.uri(), id).await.unwrap();
    assert_eq!(*h.sink.canceled.lock().unwrap(), [101]);
    assert_eq!(state(&h, id).await, JobStateKind::Canceled);
    assert!(matches!(h.ipp.cancel_job(&h.uri(), id).await, Err(Error::Rejected(_))), "already ended");
    assert!(matches!(h.ipp.cancel_job(&h.uri(), 999).await, Err(Error::Rejected(_))), "unknown job");
}

#[tokio::test]
async fn create_job_then_send_document() {
    let h = Harness::start().await;
    let mut create = request(op::CREATE_JOB, &h.uri());
    create.operation().push("job-name", Value::name("Two-step"));
    let created = ipp(&h, &create, b"").await;
    assert_eq!(created.code, 0);
    let id = created.attr(group::JOB, "job-id").and_then(Attribute::int).unwrap();
    assert_eq!(created.attr(group::JOB, "job-state").and_then(Attribute::int), Some(4), "held until its document arrives");
    assert!(h.sink.jobs().is_empty());

    let mut send = request(op::SEND_DOCUMENT, &h.uri());
    send.operation().push("job-id", Value::Integer(id));
    send.operation().push("last-document", Value::Boolean(true));
    send.operation().push("document-format", Value::mime("application/pdf"));
    assert_eq!(ipp(&h, &send, PDF).await.code, 0);
    let jobs = h.sink.jobs();
    assert_eq!((jobs.len(), jobs[0].title.as_str(), jobs[0].user.as_deref()), (1, "Two-step", Some("bob")));
    assert_eq!(std::fs::read(&jobs[0].doc.path).unwrap(), PDF);
    assert_eq!(ipp(&h, &send, PDF).await.code, 0x0404, "the job no longer takes documents");
    assert_eq!(h.spool.files().len(), 1);
}

#[tokio::test]
async fn get_jobs_filters_by_state() {
    let h = Harness::start().await;
    let first = print(&h, "application/pdf", PDF).await.unwrap();
    let second = print(&h, "application/pdf", PDF).await.unwrap();
    h.sink.set(101, SharedJobState::Completed);
    assert_eq!(job_ids(&h, "not-completed").await, [second]);
    assert_eq!(job_ids(&h, "completed").await, [first]);
    assert_eq!(job_ids(&h, "all").await, [second, first], "newest first");
    let mut bogus = request(op::GET_JOBS, &h.uri());
    bogus.operation().push("which-jobs", Value::keyword("fetchable"));
    assert_eq!(ipp(&h, &bogus, b"").await.code, 0x040B);
}

#[tokio::test]
async fn a_job_that_finished_with_a_warning_says_so() {
    let h = Harness::start().await;
    let clean = print(&h, "application/pdf", PDF).await.unwrap();
    let short = print(&h, "application/pdf", PDF).await.unwrap();
    h.sink.set(101, SharedJobState::Completed);
    h.sink.finish_with_warning(102, "The printer stopped after 4 of 11 pages. It didn't report an error.");
    let clean = h.ipp.job_state(&h.uri(), clean).await.unwrap();
    assert_eq!((clean.state, clean.reasons, clean.message), (JobStateKind::Completed, vec!["job-completed-successfully".into()], None));
    let short = h.ipp.job_state(&h.uri(), short).await.unwrap();
    assert_eq!((short.state, &short.reasons[..]), (JobStateKind::Completed, &["job-completed-with-warnings".to_string()][..]));
    assert_eq!(short.message.as_deref(), Some("The printer stopped after 4 of 11 pages. It didn't report an error."));
}

#[tokio::test]
async fn bad_requests_get_ipp_errors() {
    let h = Harness::start().await;
    let unknown = format!("ipp://{}/ipp/print/000000000000", h.addr);
    match h.ipp.get_printer_attributes(&unknown).await {
        Err(Error::Rejected(m)) => assert!(m.contains("0x0406"), "{m}"),
        other => panic!("expected not-found, got {:?}", other.map(|a| a.name)),
    }
    let mut v3 = request(op::GET_PRINTER_ATTRIBUTES, &h.uri());
    v3.version = (3, 0);
    assert_eq!(ipp(&h, &v3, b"").await.code, 0x0503);
    let mut no_id = request(op::GET_PRINTER_ATTRIBUTES, &h.uri());
    no_id.request_id = 0;
    assert_eq!(ipp(&h, &no_id, b"").await.code, 0x0400);
    assert_eq!(ipp(&h, &request(0x0010, &h.uri()), b"").await.code, 0x0501, "Pause-Printer");
}

#[tokio::test]
async fn a_refusing_queue_reads_as_not_ready_and_keeps_no_file() {
    let h = Harness::start().await;
    *h.sink.refuse.lock().unwrap() = Some("queue paused".into());
    match print(&h, "application/pdf", PDF).await {
        Err(Error::NotReady(m)) => assert!(m.contains("queue paused"), "{m}"),
        other => panic!("expected NotReady, got {other:?}"),
    }
    let mut msg = request(op::PRINT_JOB, &h.uri());
    msg.operation().push("document-format", Value::mime("application/pdf"));
    assert_eq!(ipp(&h, &msg, PDF).await.code, 0x0502, "server-error-service-unavailable, so CUPS retries");
    assert!(h.spooled_after_cleanup().await.is_empty());
}

#[tokio::test]
async fn stop_frees_the_port() {
    let mut h = Harness::start().await;
    let addr = h.addr;
    h.server.take().unwrap().stop().await;
    assert!(std::net::TcpListener::bind(addr).is_ok());
}
