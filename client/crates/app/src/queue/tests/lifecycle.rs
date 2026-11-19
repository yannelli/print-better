//! Restarts, pause notes, retention, reconnect resync, listings, and LAN-share views.

use super::{Fixture, HOUR, NOW, offer};
use crate::proto::{ClientMsg, JobStatus};
use crate::queue::record::Source;
use crate::queue::{LocalJob, Outcome, PAUSED_PREFIX};
use pb_print::JobOptions;
use pb_print::share::SharedJobState;

const DAY: i64 = 24 * HOUR;

#[test]
fn restart_fails_printing_jobs_and_keeps_waiting_ones() {
    let mut f = Fixture::new();
    let printing = f.start("printing", "p1");
    f.queue.progress(&printing, JobStatus::Printing, "Printing".into(), None, NOW);
    let retrying = f.start("retrying", "p2");
    f.queue.finish(&retrying, Outcome::Retry("The printer is off.".into()), NOW);
    let mut f = f.restart();
    assert_eq!(f.status("printing"), JobStatus::Failed);
    assert_eq!(f.message("printing").as_deref(), Some(crate::queue::RESTARTED));
    let rec = f.queue.get("retrying").unwrap();
    assert_eq!((rec.status, rec.tries), (JobStatus::Dispatched, 1));
    assert!(f.drain().is_empty(), "nothing is reported until the hub re-offers or a resync");
    assert_eq!(super::ids(&f.take(rec.retry_at)), ["retrying"]);
}

#[test]
fn restart_removes_orphaned_spool_files_and_keeps_queued_ones() {
    let mut f = Fixture::new();
    let run = f.start("j", "p1");
    let kept = f.queue.spool.join("j.pdf");
    let orphan = f.queue.spool.join("leftover.part");
    std::fs::write(&kept, b"%PDF").unwrap();
    std::fs::write(&orphan, b"junk").unwrap();
    f.queue.set_file(&run, kept.clone());
    let f = f.restart();
    assert!(kept.exists() && !orphan.exists());
    assert_eq!(f.queue.get("j").unwrap().file.as_deref(), Some(kept.as_path()));
}

fn local(f: &Fixture, source: Source) -> LocalJob {
    let file = f.queue.spool.join(format!("doc-{}.pdf", f.queue.list().len()));
    std::fs::write(&file, b"%PDF").unwrap();
    let options = JobOptions::default();
    let (title, content_type) = ("doc.pdf".into(), "application/pdf".into());
    LocalJob { source, printer_key: "p1".into(), title, user: None, file, content_type, options }
}

#[test]
fn restart_continues_share_ids() {
    let f = Fixture::new();
    f.queue.add_local(local(&f, Source::Lan), NOW);
    f.queue.add_local(local(&f, Source::Lan), NOW);
    let f = f.restart();
    assert_eq!(f.queue.add_local(local(&f, Source::Lan), NOW).1, 3);
}

#[test]
fn pause_notes_waiting_jobs_and_resume_clears_only_pause_notes() {
    let mut f = Fixture::new();
    let running = f.start("running", "p1");
    let retried = f.start("retried", "p2");
    f.queue.finish(&retried, Outcome::Retry("The printer is off.".into()), NOW);
    f.queue.offer(offer("waiting", "p3", 1, NOW), NOW);
    f.drain();
    let note = format!("{PAUSED_PREFIX}Kitchen Mac");
    f.queue.hold(Some(&note), NOW + 1);
    assert_eq!(f.message("waiting").as_deref(), Some(note.as_str()));
    assert_eq!(f.message("retried").as_deref(), Some(note.as_str()));
    assert_eq!(f.message("running"), None, "the running job is left alone");
    assert_eq!(f.reports().len(), 2);
    f.queue.hold(Some(&note), NOW + 2);
    assert!(f.reports().is_empty(), "holding again changes nothing");
    f.queue.finish(&running, Outcome::Retry("Out of paper.".into()), NOW + 3);
    f.queue.hold(None, NOW + 4);
    assert_eq!((f.message("waiting"), f.message("retried")), (None, None));
    assert_eq!(f.message("running").as_deref(), Some("Out of paper."));
}

#[test]
fn finished_jobs_are_forgotten_after_seven_days() {
    let mut f = Fixture::new();
    let run = f.start("done", "p1");
    f.queue.finish(&run, Outcome::Done(None), NOW);
    f.queue.offer(offer("waiting", "p2", 1, NOW), NOW);
    f.queue.purge(NOW + 7 * DAY - 1);
    assert!(f.queue.get("done").is_some());
    f.queue.purge(NOW + 7 * DAY);
    assert!(f.queue.get("done").is_none() && !f.dir.path().join("jobs/done.json").exists());
    assert!(f.queue.get("waiting").is_some(), "unfinished jobs are never purged");
}

#[test]
fn resync_resends_every_jobs_latest_state() {
    let mut f = Fixture::new();
    let run = f.start("server", "p1");
    f.queue.finish(&run, Outcome::Done(Some(1)), NOW);
    let (lan, _) = f.queue.add_local(local(&f, Source::Lan), NOW);
    f.queue.add_local(local(&f, Source::Local), NOW);
    f.drain();
    f.queue.resync();
    let mut sent: Vec<String> = f
        .drain()
        .into_iter()
        .map(|msg| match msg {
            ClientMsg::JobStatus { job_id, status, attempt, .. } => format!("{job_id} {status:?} {attempt:?}"),
            ClientMsg::LanJob { local_id, status, .. } => format!("{local_id} {status}"),
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    sent.sort();
    assert_eq!(sent, [format!("{lan} queued"), "server Completed Some(1)".into()]);
}

#[test]
fn list_shows_unfinished_and_the_twenty_latest_finished_newest_first() {
    let f = Fixture::new();
    for n in 0..22 {
        f.queue.offer(offer(&format!("done-{n:02}"), &format!("p{n}"), 1, NOW), NOW);
    }
    for run in f.take(NOW) {
        let n: i64 = run.rec.id[5..].parse().unwrap();
        f.queue.finish(&run, Outcome::Done(None), NOW + n);
    }
    f.queue.offer(offer("waiting", "p1", 1, NOW), NOW);
    let list = f.queue.list();
    assert_eq!(list.len(), 21);
    assert_eq!(list[0].id, "done-21");
    assert!(list.iter().any(|r| r.id == "waiting"));
    assert!(list.iter().all(|r| r.id != "done-00" && r.id != "done-01"));
}

#[test]
fn shared_jobs_map_to_ipp_states_and_can_be_canceled() {
    let mut f = Fixture::new();
    let (_, waiting) = f.queue.add_local(local(&f, Source::Lan), NOW);
    assert_eq!(f.queue.shared_state(waiting).unwrap().0, SharedJobState::Pending);
    let run = f.take(NOW).remove(0);
    assert_eq!(f.queue.shared_state(waiting).unwrap().0, SharedJobState::Processing);
    f.queue.finish(&run, Outcome::Failed("Jammed.".into()), NOW);
    assert_eq!(f.queue.shared_state(waiting), Some((SharedJobState::Aborted, Some("Jammed.".into()))));
    let (_, other) = f.queue.add_local(local(&f, Source::Lan), NOW);
    assert!(f.queue.cancel_shared(other, NOW));
    assert_eq!(f.queue.shared_state(other).unwrap().0, SharedJobState::Canceled);
    assert!(f.queue.shared_state(999).is_none() && !f.queue.cancel_shared(999, NOW));
    f.drain();
}

#[test]
fn clear_cancels_and_forgets_everything() {
    let mut f = Fixture::new();
    let run = f.start("j", "p1");
    f.queue.clear();
    assert!(run.cancel.is_canceled() && f.queue.get("j").is_none());
    assert!(!f.dir.path().join("jobs/j.json").exists());
    assert!(f.restart().queue.list().is_empty());
}
