//! Intake from the hub, idempotency, superseding attempts, and every cancel path.

use super::{Fixture, NOW, offer};
use crate::proto::{ClientMsg, JobStatus};
use crate::queue::LocalJob;
use crate::queue::record::Source;
use crate::queue::Outcome;
use pb_print::JobOptions;

#[test]
fn offer_is_persisted_then_acked_as_dispatched() {
    let mut f = Fixture::new();
    f.queue.offer(offer("j1", "p1", 1, NOW), NOW);
    assert_eq!(f.reports(), [("j1".into(), JobStatus::Dispatched, Some(1))]);
    assert!(f.dir.path().join("jobs/j1.json").exists());
    let f = f.restart();
    assert_eq!(f.status("j1"), JobStatus::Dispatched);
}

#[test]
fn repeated_offer_resends_the_latest_status_without_printing_again() {
    let mut f = Fixture::new();
    let run = f.start("j1", "p1");
    f.queue.finish(&run, Outcome::Done(Some(2)), NOW);
    f.drain();
    f.queue.offer(offer("j1", "p1", 1, NOW), NOW + 1);
    assert_eq!(f.reports(), [("j1".into(), JobStatus::Completed, Some(1))]);
    assert_eq!(f.status("j1"), JobStatus::Completed);
    assert!(f.take(NOW + 1).is_empty());
}

#[test]
fn older_attempt_is_answered_with_the_current_one() {
    let mut f = Fixture::new();
    f.queue.offer(offer("j1", "p1", 2, NOW), NOW);
    f.queue.offer(offer("j1", "p1", 1, NOW), NOW);
    assert_eq!(f.reports().last().unwrap(), &("j1".into(), JobStatus::Dispatched, Some(2)));
    assert_eq!(f.queue.get("j1").unwrap().attempt(), 2);
}

#[test]
fn higher_attempt_supersedes_and_cancels_the_running_one() {
    let mut f = Fixture::new();
    let old = f.start("j1", "p1");
    f.queue.offer(offer("j1", "p1", 2, NOW), NOW + 1);
    assert!(old.cancel.is_canceled());
    assert_eq!(f.reports(), [("j1".into(), JobStatus::Dispatched, Some(2))]);
    assert!(f.take(NOW + 1).is_empty(), "the printer is busy until the old run returns");
    f.queue.finish(&old, Outcome::Done(Some(1)), NOW + 2);
    assert_eq!(f.status("j1"), JobStatus::Dispatched, "a superseded run must not finish the new attempt");
    assert!(f.reports().is_empty());
    let runs = f.take(NOW + 2);
    assert_eq!(runs[0].rec.attempt(), 2);
}

#[test]
fn cancel_of_an_unknown_job_reports_canceled() {
    let mut f = Fixture::new();
    assert!(!f.queue.cancel("ghost", NOW));
    assert_eq!(f.reports(), [("ghost".into(), JobStatus::Canceled, None)]);
}

#[test]
fn cancel_of_a_waiting_job_finishes_it_at_once() {
    let mut f = Fixture::new();
    f.queue.offer(offer("j1", "p1", 1, NOW), NOW);
    f.drain();
    assert!(f.queue.cancel("j1", NOW + 1));
    assert_eq!(f.status("j1"), JobStatus::Canceled);
    assert_eq!(f.reports(), [("j1".into(), JobStatus::Canceled, Some(1))]);
    assert!(f.take(NOW + 1).is_empty());
}

#[test]
fn cancel_of_a_running_job_waits_for_the_runner() {
    let mut f = Fixture::new();
    let run = f.start("j1", "p1");
    assert!(f.queue.cancel("j1", NOW + 1));
    assert!(run.cancel.is_canceled());
    assert_eq!(f.status("j1"), JobStatus::Dispatched);
    assert!(f.reports().is_empty());
    f.queue.finish(&run, Outcome::Canceled, NOW + 2);
    assert_eq!(f.reports(), [("j1".into(), JobStatus::Canceled, Some(1))]);
}

#[test]
fn cancel_after_the_printer_finished_reports_completed() {
    let mut f = Fixture::new();
    let run = f.start("j1", "p1");
    f.queue.finish(&run, Outcome::Done(None), NOW + 1);
    f.drain();
    assert!(f.queue.cancel("j1", NOW + 2));
    assert_eq!(f.status("j1"), JobStatus::Completed);
    assert_eq!(f.reports(), [("j1".into(), JobStatus::Completed, Some(1))]);
}

fn local(f: &Fixture, source: Source, name: &str) -> LocalJob {
    let file = f.queue.spool.join(name);
    std::fs::write(&file, b"%PDF-1.4").unwrap();
    LocalJob {
        source,
        printer_key: "p1".into(),
        title: name.into(),
        user: Some("alice".into()),
        file,
        content_type: "application/pdf".into(),
        options: JobOptions::default(),
    }
}

#[test]
fn lan_jobs_are_reported_as_lan_job_and_local_jobs_not_at_all() {
    let mut f = Fixture::new();
    let (lan_id, first) = f.queue.add_local(local(&f, Source::Lan, "a.pdf"), NOW);
    let (local_id, second) = f.queue.add_local(local(&f, Source::Local, "b.pdf"), NOW);
    assert_eq!((first, second), (1, 2));
    assert!(lan_id.starts_with("lan-") && local_id.starts_with("local-"));
    let sent = f.drain();
    assert_eq!(sent.len(), 1);
    let ClientMsg::LanJob { local_id: id, status, size, user, .. } = &sent[0] else { panic!("expected lan_job") };
    assert_eq!((id.as_str(), status.as_str(), *size, user.as_deref()), (lan_id.as_str(), "queued", 8, Some("alice")));
}
