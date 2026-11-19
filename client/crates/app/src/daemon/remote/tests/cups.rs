use super::{FakeCups, printer};
use crate::daemon::remote::cups::{Op, Queue, airprint_ppd, apply, plan, queue_name};
use pb_print::share::printer_path;
use pb_print::{PrinterState, Quality, Supply, SupplyKind};

/// Nothing listens on port 1, so the fake's reachability probe never touches a real service.
fn queue(id: &str, name: &str) -> Queue {
    Queue::for_printer(&printer(id, name, Some("Office"), "Den Pi", true), 1)
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| a.to_string()).collect()
}

#[test]
fn queue_names_are_prefixed_and_safe_for_cups() {
    assert_eq!(queue_name("pr_01"), "pb_pr_01");
    assert_eq!(queue_name("pr 1/2#x?\"'"), "pb_pr_1_2_x___");
    assert_eq!(queue_name("Ünï-cødé"), "pb__n_-c_d_");
    assert_eq!(queue_name(&"x".repeat(300)).len(), 127);
}

#[test]
fn a_queue_points_at_the_loopback_server_and_names_the_owner() {
    let q = Queue::for_printer(&printer("pr_07", "Upstairs\tlaser\n", Some("Office"), "Den Pi", true), 8632);
    assert_eq!(q.uri, format!("ipp://127.0.0.1:8632{}", printer_path("pr_07")));
    assert_eq!((q.name.as_str(), q.description.as_str()), ("pb_pr_07", "Upstairs laser"));
    assert_eq!(q.location, "Office (via Print Better)");
    let unplaced = Queue::for_printer(&printer("pr_08", "Label maker", Some("  "), "Garage Mac", false), 8632);
    assert_eq!(unplaced.location, "Garage Mac (via Print Better)");
}

#[test]
fn lpadmin_arguments_follow_the_contract() {
    let q = queue("pr_07", "Upstairs laser");
    let uri = q.uri.clone();
    let add = strings(&[
        "-p", "pb_pr_07", "-E", "-v", &uri, "-m", "everywhere", "-D", "Upstairs laser", "-L", "Office (via Print Better)", "-o",
        "printer-is-shared=false",
    ]);
    assert_eq!(Op::Add(q.clone()).args(), add);
    let update = strings(&["-p", "pb_pr_07", "-v", &uri, "-D", "Upstairs laser", "-L", "Office (via Print Better)"]);
    assert_eq!(Op::Update(q.clone()).args(), update);
    let refresh = strings(&["-p", "pb_pr_07", "-v", &uri, "-m", "everywhere", "-D", "Upstairs laser", "-L", "Office (via Print Better)"]);
    assert_eq!(Op::Refresh(q.clone()).args(), refresh);
    assert_eq!(Op::Remove(q).args(), strings(&["-x", "pb_pr_07"]));
}

#[test]
fn plan_is_a_diff_with_removals_first() {
    let (a, b, c) = (queue("a", "A"), queue("b", "B"), queue("c", "C"));
    let renamed = queue("b", "B2");
    assert_eq!(plan(&[a.clone(), b.clone()], &[a.clone(), b.clone()]), []);
    assert_eq!(plan(&[], std::slice::from_ref(&a)), [Op::Add(a.clone())]);
    assert_eq!(
        plan(&[a.clone(), b.clone()], &[renamed.clone(), c.clone()]),
        [Op::Remove(a.clone()), Op::Update(renamed), Op::Add(c)]
    );
    assert_eq!(plan(&[a.clone(), b.clone()], &[]), [Op::Remove(a), Op::Remove(b)]);
}

#[test]
fn apply_records_only_what_succeeded() {
    let cups = FakeCups::default();
    let (a, b) = (queue("a", "A"), queue("b", "B"));
    let mut managed = Vec::new();
    let ops = plan(&managed, &[a.clone(), b.clone()]);
    assert_eq!(apply(&cups, &mut managed, ops), None);
    assert_eq!(managed, [a.clone(), b.clone()]);
    *cups.refuse.lock().unwrap() = Some("lpadmin: Forbidden".into());
    let renamed = queue("a", "A2");
    let ops = plan(&managed, &[renamed]);
    let error = apply(&cups, &mut managed, ops).unwrap();
    assert!(error.contains("pb_b") && error.contains("Forbidden"), "{error}");
    assert_eq!(managed, [a, b], "a refused removal keeps the queue recorded, a refused rename keeps the old name");
}

#[test]
fn queues_print_better_did_not_create_are_never_touched() {
    let cups = FakeCups::default();
    cups.queues.lock().unwrap().insert("pb_a".into());
    let mut managed = Vec::new();
    let error = apply(&cups, &mut managed, vec![Op::Add(queue("a", "A"))]).unwrap();
    assert!(error.contains("already exists"), "{error}");
    let stranger = queue("b", "B");
    assert!(apply(&cups, &mut managed, vec![Op::Remove(stranger.clone()), Op::Update(stranger)]).is_some());
    let mut odd = queue("c", "C");
    odd.name = "Office_Laser".into();
    let mut recorded = vec![odd.clone()];
    assert!(apply(&cups, &mut recorded, vec![Op::Remove(odd)]).unwrap().contains("did not create"));
    assert!(cups.calls().is_empty() && managed.is_empty() && recorded.len() == 1);
}

#[test]
fn removing_a_queue_someone_already_deleted_just_forgets_it() {
    let cups = FakeCups::default();
    *cups.refuse.lock().unwrap() = Some("lpadmin: The printer or class does not exist.".into());
    let mut managed = vec![queue("a", "A")];
    assert_eq!(apply(&cups, &mut managed, vec![Op::Remove(queue("a", "A"))]), None);
    assert!(managed.is_empty());
}

#[test]
fn printers_this_computer_already_reaches_are_recognized() {
    let native = crate::daemon::remote::native::Native::with(&["7d3b9a1e-2c4f-4e8a-9b6d-1f0e5c2a8b34"]);
    let mut same = printer("pr_1", "Laser", None, "Den Pi", true);
    same.uuid = Some("7D3B9A1E-2C4F-4E8A-9B6D-1F0E5C2A8B34".into());
    let mut other = printer("pr_2", "Label maker", None, "Den Pi", true);
    other.uuid = Some("00000000-0000-4000-8000-000000000001".into());
    let unknown = printer("pr_3", "Old laser", None, "Den Pi", true);
    assert!(native.reaches(&same), "uuids compare case-insensitively");
    assert!(!native.reaches(&other) && !native.reaches(&unknown), "no uuid means no match");
}

#[test]
fn only_what_shapes_the_ppd_regenerates_it() {
    let base = printer("pr_07", "Laser", None, "Den Pi", true);
    let fingerprint = |p| Queue::for_printer(&p, 1).ppd;
    let mut busy = base.clone();
    busy.state = PrinterState::Printing;
    busy.online = false;
    busy.supplies = vec![Supply { name: "Black".into(), kind: SupplyKind::Toner, color: None, level: 41 }];
    assert_eq!(fingerprint(busy), fingerprint(base.clone()), "levels, state and presence never touch the PPD");
    let mut trays = base.clone();
    trays.capabilities.sources = vec!["tray-1".into(), "auto".into()];
    let mut quality = base.clone();
    quality.capabilities.qualities = vec![Quality::Normal];
    let mut model = base.clone();
    model.make_model = Some("Other model".into());
    for changed in [trays, quality, model] {
        assert_ne!(fingerprint(changed), fingerprint(base.clone()));
    }
}

#[test]
fn a_changed_ppd_shape_refreshes_and_old_records_refresh_once() {
    let have = queue("a", "A");
    let mut want = have.clone();
    want.ppd = "0123456789abcdef".into();
    assert_eq!(plan(std::slice::from_ref(&have), std::slice::from_ref(&want)), [Op::Refresh(want.clone())]);
    let old: Queue = serde_json::from_value(serde_json::json!({
        "printerId": "a", "name": "pb_a", "uri": have.uri, "description": "A", "location": have.location
    }))
    .unwrap();
    assert_eq!(old.ppd, "", "records saved before 0.1.3 have no fingerprint");
    assert_eq!(plan(&[old], std::slice::from_ref(&have)), [Op::Refresh(have.clone())]);
}

#[test]
fn added_and_refreshed_queues_are_marked_airprint_and_renames_are_not() {
    let cups = FakeCups::default();
    let mut managed = Vec::new();
    let a = queue("a", "A");
    assert_eq!(apply(&cups, &mut managed, vec![Op::Add(a.clone())]), None);
    let renamed = queue("a", "A2");
    assert_eq!(apply(&cups, &mut managed, vec![Op::Update(renamed.clone())]), None);
    assert_eq!(apply(&cups, &mut managed, vec![Op::Refresh(renamed)]), None);
    assert_eq!(*cups.marked.lock().unwrap(), ["pb_a", "pb_a"]);
}

#[test]
fn the_airprint_keyword_goes_after_the_ppd_header_once() {
    let generated = b"*PPD-Adobe: \"4.3\"\n*FormatVersion: \"4.3\"\n*cupsVersion: 2.3\n";
    let marked = airprint_ppd(generated).unwrap();
    assert_eq!(marked, b"*PPD-Adobe: \"4.3\"\n*APAirPrint: True\n*FormatVersion: \"4.3\"\n*cupsVersion: 2.3\n");
    assert_eq!(airprint_ppd(&marked), None, "already marked");
    assert_eq!(airprint_ppd(b"<html>Forbidden</html>\n"), None, "not a PPD");
}
