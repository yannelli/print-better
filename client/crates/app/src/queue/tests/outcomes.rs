//! Scheduling (FIFO per printer, parallel across printers, retry times) and every run outcome.

use super::{Fixture, HOUR, NOW, ids, offer};
use crate::proto::JobStatus;
use crate::queue::Outcome;

#[test]
fn oldest_job_per_printer_runs_and_printers_run_in_parallel() {
    let f = Fixture::new();
    f.queue.offer(offer("p1-new", "p1", 1, NOW + 10), NOW);
    f.queue.offer(offer("p1-old", "p1", 1, NOW), NOW);
    f.queue.offer(offer("p2-only", "p2", 1, NOW + 5), NOW);
    let runs = f.take(NOW);
    assert_eq!(ids(&runs), ["p1-old", "p2-only"]);
    assert!(f.take(NOW).is_empty(), "both printers are busy");
    let old = runs.iter().find(|r| r.rec.id == "p1-old").unwrap();
    f.queue.finish(old, Outcome::Done(Some(1)), NOW + 1);
    assert_eq!(ids(&f.take(NOW + 1)), ["p1-new"]);
}

#[test]
fn retry_waits_for_its_time_and_keeps_newer_jobs_behind_it() {
    let mut f = Fixture::new();
    let run = f.start("first", "p1");
    f.queue.offer(offer("second", "p1", 1, NOW + 1), NOW);
    f.queue.finish(&run, Outcome::Retry("The printer is off.".into()), NOW);
    let rec = f.queue.get("first").unwrap();
    assert_eq!((rec.status, rec.tries, rec.retry_at), (JobStatus::Dispatched, 1, NOW + 5_000));
    assert_eq!(rec.message.as_deref(), Some("The printer is off."));
    let (runs, next) = f.queue.take_runnable(NOW + 4_999);
    assert!(runs.is_empty());
    assert_eq!(next, Some(NOW + 5_000));
    assert_eq!(ids(&f.take(NOW + 5_000)), ["first"]);
    assert!(f.reports().iter().all(|(_, status, _)| *status == JobStatus::Dispatched));
}

#[test]
fn retry_backoff_doubles_from_five_seconds_to_five_minutes() {
    let f = Fixture::new();
    f.queue.offer(offer("j", "p1", 1, NOW), NOW);
    let mut waits = Vec::new();
    let mut now = NOW;
    for _ in 0..8 {
        let run = f.take(now).remove(0);
        f.queue.finish(&run, Outcome::Retry("Not ready.".into()), now);
        let retry_at = f.queue.get("j").unwrap().retry_at;
        waits.push((retry_at - now) / 1000);
        now = retry_at;
    }
    assert_eq!(waits, [5, 10, 20, 40, 80, 160, 300, 300]);
}

#[test]
fn retry_after_printing_started_goes_back_to_dispatched() {
    let mut f = Fixture::new();
    let run = f.start("j", "p1");
    f.queue.progress(&run, JobStatus::Printing, "Sending to the printer".into(), None, NOW + 1);
    f.queue.finish(&run, Outcome::Retry("The printer went offline.".into()), NOW + 2);
    assert_eq!(f.status("j"), JobStatus::Dispatched);
    let reports: Vec<JobStatus> = f.reports().into_iter().map(|(_, status, _)| status).collect();
    assert_eq!(reports, [JobStatus::Printing, JobStatus::Dispatched]);
}

#[test]
fn done_completes_with_pages_and_deletes_the_spooled_file() {
    let mut f = Fixture::new();
    let run = f.start("j", "p1");
    let file = f.queue.spool.join("j.pdf");
    std::fs::write(&file, b"%PDF").unwrap();
    f.queue.set_file(&run, file.clone());
    f.queue.progress(&run, JobStatus::Printing, "Printing (2 done)".into(), Some(2), NOW + 1);
    f.queue.finish(&run, Outcome::Done(Some(3)), NOW + 2);
    let rec = f.queue.get("j").unwrap();
    assert_eq!((rec.status, rec.pages, rec.message), (JobStatus::Completed, Some(3), None));
    assert!(rec.file.is_none() && !file.exists());
    assert_eq!(f.reports().last().unwrap().1, JobStatus::Completed);
}

#[test]
fn warned_completes_with_the_warning_as_its_message() {
    let mut f = Fixture::new();
    let run = f.start("j", "p1");
    let warning = "The printer stopped after 4 of 11 pages. It didn't report an error.";
    f.queue.finish(&run, Outcome::Warned(Some(4), warning.into()), NOW + 1);
    let rec = f.queue.get("j").unwrap();
    assert_eq!((rec.status, rec.pages, rec.message.as_deref()), (JobStatus::Completed, Some(4), Some(warning)));
    assert_eq!(f.reports().last().unwrap().1, JobStatus::Completed);
}

#[test]
fn done_without_a_page_count_keeps_the_last_progress_count() {
    let mut f = Fixture::new();
    let run = f.start("j", "p1");
    f.queue.progress(&run, JobStatus::Printing, "Printing (4 done)".into(), Some(4), NOW);
    f.queue.finish(&run, Outcome::Done(None), NOW);
    assert_eq!(f.queue.get("j").unwrap().pages, Some(4));
}

#[test]
fn failed_keeps_the_engine_sentence_as_is() {
    let mut f = Fixture::new();
    let run = f.start("j", "p1");
    let sentence = "The printer may have printed this; it won't be sent again.";
    f.queue.finish(&run, Outcome::Failed(sentence.into()), NOW + 1);
    assert_eq!((f.status("j"), f.message("j").as_deref()), (JobStatus::Failed, Some(sentence)));
    assert_eq!(f.reports(), [("j".into(), JobStatus::Failed, Some(1))]);
}

#[test]
fn canceled_outcomes_and_retry_after_cancel_end_canceled() {
    let mut f = Fixture::new();
    let run = f.start("a", "p1");
    f.queue.finish(&run, Outcome::Canceled, NOW + 1);
    assert_eq!(f.status("a"), JobStatus::Canceled);
    let run = f.start("b", "p2");
    f.queue.cancel("b", NOW + 1);
    f.queue.finish(&run, Outcome::Retry("Connection reset.".into()), NOW + 2);
    assert_eq!(f.status("b"), JobStatus::Canceled);
}

#[test]
fn retries_give_up_after_24_hours() {
    let f = Fixture::new();
    f.queue.offer(offer("j", "p1", 1, NOW), NOW);
    let run = f.take(NOW).remove(0);
    f.queue.finish(&run, Outcome::Retry("Out of paper.".into()), NOW + 24 * HOUR);
    assert_eq!(f.status("j"), JobStatus::Dispatched, "exactly 24 h is still inside the window");
    let run = f.take(NOW + 25 * HOUR).remove(0);
    f.queue.finish(&run, Outcome::Retry("Out of paper.".into()), NOW + 24 * HOUR + 1);
    assert_eq!(f.status("j"), JobStatus::Failed);
    assert_eq!(f.message("j").as_deref(), Some("Gave up after 24 hours. Out of paper."));
}

#[test]
fn a_finished_job_ignores_late_outcomes() {
    let f = Fixture::new();
    f.queue.offer(offer("j", "p1", 1, NOW), NOW);
    let run = f.take(NOW).remove(0);
    f.queue.finish(&run, Outcome::Done(Some(1)), NOW);
    f.queue.finish(&run, Outcome::Failed("late".into()), NOW + 1);
    f.queue.progress(&run, JobStatus::Printing, "late".into(), None, NOW + 1);
    assert_eq!((f.status("j"), f.message("j")), (JobStatus::Completed, None));
}
