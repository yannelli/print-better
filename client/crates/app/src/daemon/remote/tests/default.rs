use super::{FakeCups, printer};
use crate::daemon::remote::cups::{self, Queue};
use crate::daemon::remote::default::{Outcome, apply, target};
use crate::daemon::remote::report::{Survey, survey};
use crate::daemon::remote::system::{device_uuid, native_queue, parse_default, parse_description, parse_devices};
use crate::proto::{DefaultPrinterProblem as Problem, DirectPrinter, SystemPrinter, SystemPrinterState as State};
use crate::store::AppliedDefault;

const UUID: &str = "7d3b9a1e-2c4f-4e8a-9b6d-1f0e5c2a8b34";

fn applied(id: &str, queue: &str, seen: &str) -> Option<AppliedDefault> {
    Some(AppliedDefault { printer_id: id.into(), queue: queue.into(), seen: Some(seen.into()) })
}

fn fake(default: Option<&str>, queues: &[&str]) -> FakeCups {
    let fake = FakeCups::default();
    *fake.default.lock().unwrap() = default.map(String::from);
    fake.queues.lock().unwrap().extend(queues.iter().map(|q| q.to_string()));
    fake
}

#[test]
fn lpstat_output_is_read_in_any_language() {
    assert_eq!(parse_default("system default destination: Office_Laser\n"), Some("Office_Laser".into()));
    assert_eq!(parse_default("Standardziel des Systems: Office_Laser/duplex\n"), Some("Office_Laser".into()));
    assert_eq!(parse_default("no system default destination\n"), None);
    let devices = parse_devices(&format!(
        "device for Office_Laser: dnssd://Office%20Laser._ipp._tcp.local./?uuid={}\nGerät für pb_pr_1: ipp://127.0.0.1:8632/ipp/print/x\n",
        UUID.to_uppercase()
    ));
    assert_eq!(devices.iter().map(|(q, _)| q.as_str()).collect::<Vec<_>>(), ["Office_Laser", "pb_pr_1"]);
    assert_eq!(device_uuid(&devices[0].1).as_deref(), Some(UUID));
    assert_eq!(device_uuid("ipp://printer.local:631/ipp/print?uuid=urn:uuid:ABC&x=1").as_deref(), Some("abc"));
    assert_eq!(device_uuid("usb://Brother/HL?serial=1"), None);
    let long = "printer Office_Laser is idle.  enabled since Thu\n\tForm mounted:\n\tDescription: Office laser\n\tAlerts: none\n";
    assert_eq!(parse_description(long).as_deref(), Some("Office laser"));
    assert_eq!(parse_description("printer x is idle.\n\tDescription: \n"), None);
}

#[test]
fn the_native_queue_is_matched_by_uuid_and_never_one_of_ours() {
    let uri = format!("dnssd://Laser._ipp._tcp.local./?uuid={UUID}");
    let devices = vec![("pb_pr_1".to_string(), uri.clone()), ("Office_Laser".to_string(), uri)];
    assert_eq!(native_queue(&devices, Some(&UUID.to_uppercase())).as_deref(), Some("Office_Laser"));
    assert_eq!(native_queue(&devices[..1], Some(UUID)), None);
    assert_eq!(native_queue(&devices, None), None);
}

#[test]
fn a_target_is_a_queue_or_the_reason_there_is_none() {
    let at = |state: State, queue: Option<&str>, installed: Option<&str>| {
        let (queue, installed) = (queue.map(String::from), installed.map(String::from));
        [SystemPrinter { id: "pr_1".into(), state, queue, installed, installed_name: None, direct: true }]
    };
    assert_eq!(target(&at(State::Added, Some("pb_pr_1"), Some("Office_Laser")), "pr_1"), Ok("pb_pr_1".into()), "ours first");
    assert_eq!(target(&at(State::Hidden, None, Some("Office_Laser")), "pr_1"), Ok("Office_Laser".into()));
    assert_eq!(target(&at(State::Hidden, None, None), "pr_1"), Err(Problem::Hidden));
    assert_eq!(target(&at(State::Error, None, Some("Office_Laser")), "pr_1"), Err(Problem::Waiting));
    assert_eq!(target(&at(State::Added, Some("pb_pr_1"), None), "pr_2"), Err(Problem::Unavailable));
}

#[test]
fn no_choice_never_touches_the_default() {
    let cups = fake(Some("Office_Laser"), &[]);
    let out = apply(&cups, None, Ok("pb_pr_1".into()), applied("pr_1", "pb_pr_1", "pb_pr_1"));
    assert_eq!(out, Outcome { current: Some("Office_Laser".into()), ..Outcome::default() });
    assert!(cups.calls().is_empty());
}

#[test]
fn the_default_is_set_once_and_only_when_it_differs() {
    let cups = fake(Some("Office_Laser"), &["pb_pr_1"]);
    let out = apply(&cups, Some("pr_1"), Ok("pb_pr_1".into()), None);
    assert_eq!((out.current.as_deref(), &out.applied), (Some("pb_pr_1"), &applied("pr_1", "pb_pr_1", "pb_pr_1")));
    assert_eq!(cups.calls(), [["-d", "pb_pr_1"]]);
    let again = apply(&cups, Some("pr_1"), Ok("pb_pr_1".into()), out.applied);
    assert_eq!((again.problem, cups.calls().len()), (None, 1), "already the default");

    let already = fake(Some("pb_pr_1"), &["pb_pr_1"]);
    assert_eq!(apply(&already, Some("pr_1"), Ok("pb_pr_1".into()), None).applied, applied("pr_1", "pb_pr_1", "pb_pr_1"));
    assert!(already.calls().is_empty());
}

#[test]
fn a_default_changed_on_the_computer_wins() {
    let cups = fake(Some("Office_Laser"), &["pb_pr_1", "Office_Laser"]);
    let out = apply(&cups, Some("pr_1"), Ok("pb_pr_1".into()), applied("pr_1", "pb_pr_1", "pb_pr_1"));
    assert!(out.released && out.applied.is_none() && cups.calls().is_empty(), "{out:?}");
}

#[test]
fn a_default_that_vanished_with_our_queue_is_set_again_on_the_new_queue() {
    let cups = fake(Some("Other"), &["Office_Laser", "Other"]);
    let out = apply(&cups, Some("pr_1"), Ok("Office_Laser".into()), applied("pr_1", "pb_pr_1", "pb_pr_1"));
    assert!(!out.released, "pb_pr_1 is gone, so CUPS moved the default, not a person");
    assert_eq!(cups.calls(), [["-d", "Office_Laser"]]);
}

#[test]
fn a_users_own_default_is_not_fought() {
    let cups = fake(Some("Office_Laser"), &["pb_pr_1", "Office_Laser"]);
    let out = apply(&cups, Some("pr_1"), Ok("pb_pr_1".into()), applied("pr_1", "pb_pr_1", "Office_Laser"));
    assert!(!out.released && out.applied.is_some() && cups.calls().is_empty(), "{out:?}");
}

#[test]
fn problems_leave_the_default_alone() {
    let cups = fake(Some("Office_Laser"), &[]);
    let out = apply(&cups, Some("pr_1"), Err(Problem::Hidden), applied("pr_1", "pb_pr_1", "pb_pr_1"));
    assert_eq!((out.problem, out.applied, out.released), (Some(Problem::Hidden), None, false));
    *cups.refuse.lock().unwrap() = Some("lpadmin: Forbidden".into());
    let out = apply(&cups, Some("pr_1"), Ok("pb_pr_1".into()), None);
    assert_eq!(out.problem, Some(Problem::Failed));
    assert!(out.error.unwrap().contains("Forbidden"));
    assert_eq!(cups.default.lock().unwrap().as_deref(), Some("Office_Laser"));
}

fn survey_of(cups: &FakeCups, want: Option<&str>) -> crate::daemon::remote::report::Found {
    let mut seen = printer("pr_2", "Seen here too", None, "Den Pi", true);
    seen.uuid = Some(UUID.into());
    let snapshot = vec![
        printer("pr_1", "Added", None, "Den Pi", true),
        seen,
        printer("pr_3", "Hidden", None, "Den Pi", true),
        printer("pr_4", "Waiting", None, "Den Pi", true),
    ];
    let managed = vec![Queue::for_printer(&snapshot[0], 1), Queue::for_printer(&snapshot[1], 1)];
    let s = Survey {
        snapshot,
        direct: vec![DirectPrinter { id: "pr_2".into(), uuid: Some(UUID.into()) }],
        hidden: vec!["pr_3".into()],
        managed,
        failed: false,
        want: want.map(String::from),
        applied: None,
    };
    survey(cups, s)
}

#[test]
fn the_report_names_each_printers_place_and_the_default() {
    let cups = fake(None, &["pb_pr_1", "pb_pr_2"]);
    cups.devices.lock().unwrap().push(("Office_Laser".into(), format!("dnssd://Laser._ipp._tcp.local./?uuid={UUID}")));
    *cups.last_used.lock().unwrap() = true;
    cups.descriptions.lock().unwrap().extend([("Office_Laser".into(), "Office laser".into()), ("pb_pr_2".into(), "Seen here too".into())]);
    let found = survey_of(&cups, Some("pr_2"));
    let states: Vec<_> = found.report.printers.iter().map(|p| (p.id.as_str(), p.state, p.queue.as_deref(), p.installed_name.as_deref(), p.direct)).collect();
    assert_eq!(
        states,
        [
            ("pr_1", State::Added, Some(cups::queue_name("pr_1").as_str()), None, false),
            ("pr_2", State::Added, Some("pb_pr_2"), Some("Office laser"), true),
            ("pr_3", State::Hidden, None, None, false),
            ("pr_4", State::Waiting, None, None, false),
        ],
        "a printer installed directly keeps its pb_ queue"
    );
    let r = &found.report;
    assert_eq!((r.default_queue.as_deref(), r.default_printer_id.as_deref(), r.last_used), (Some("pb_pr_2"), Some("pr_2"), true));
    assert_eq!(r.default_name.as_deref(), Some("Seen here too"));
    assert_eq!(survey_of(&cups, Some("pr_3")).report.default_problem, Some(Problem::Hidden));
    *cups.default.lock().unwrap() = Some("Office_Laser".into());
    let native = survey_of(&cups, None).report;
    assert_eq!((native.default_printer_id.as_deref(), native.default_name.as_deref()), (Some("pr_2"), Some("Office laser")), "its installed copy is still that printer");
    cups.descriptions.lock().unwrap().push(("Garage".into(), "Garage inkjet".into()));
    *cups.default.lock().unwrap() = Some("Garage".into());
    assert_eq!(survey_of(&cups, None).report.default_name.as_deref(), Some("Garage inkjet"));
    assert_eq!(survey_of(&cups, Some("pr_9")).report.default_problem, Some(Problem::Unavailable));
}
