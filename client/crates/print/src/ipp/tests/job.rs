use super::fixture;
use crate::ipp::JobStateKind;
use crate::ipp::job::{options, parse_ranges, retry_template, state, template};
use crate::ipp::tags::group;
use crate::ipp::{Attribute, Group, Message, Value};
use crate::model::{ColorMode, Fit, JobOptions, Orientation, Quality, Sides};

/// The HP LaserJet M404's -supported attributes, as captured from the printer.
fn hp() -> Group {
    let (msg, _) = Message::decode(&fixture("hp-m404-gpa.bin")).unwrap();
    msg.group(group::PRINTER).cloned().unwrap()
}

fn printer(attrs: Vec<Attribute>) -> Group {
    Group { tag: group::PRINTER, attrs }
}

fn all_options() -> JobOptions {
    JobOptions {
        copies: Some(3),
        media: Some("iso_a4_210x297mm".into()),
        sides: Some(Sides::OneSided),
        color_mode: Some(ColorMode::Monochrome),
        orientation: Some(Orientation::Landscape),
        page_ranges: Some("5,1-3".into()),
        fit: Some(Fit::Fill),
        quality: Some(Quality::High),
        source: None,
        media_type: None,
    }
}

fn names(attrs: Option<Vec<Attribute>>) -> Option<Vec<String>> {
    attrs.map(|a| a.into_iter().map(|a| a.name).collect())
}

/// media-col with an optional media-size, a tray and a paper type.
fn col(size: Option<(i32, i32)>, source: &str, media_type: &str) -> Value {
    let size = size.map(|(x, y)| [("x-dimension", x), ("y-dimension", y)].map(|(n, v)| Attribute::new(n, Value::Integer(v))));
    let mut members: Vec<Attribute> = size.map(|s| Attribute::new("media-size", Value::Collection(s.to_vec()))).into_iter().collect();
    members.push(Attribute::new("media-source", Value::keyword(source)));
    members.push(Attribute::new("media-type", Value::keyword(media_type)));
    Value::Collection(members)
}

fn strings(v: &[&str]) -> Option<Vec<String>> {
    Some(v.iter().map(|s| s.to_string()).collect())
}

#[test]
fn every_option_maps_to_its_job_template_attribute() {
    let expected = vec![
        Attribute::new("copies", Value::Integer(3)),
        Attribute::new("media", Value::keyword("iso_a4_210x297mm")),
        Attribute::new("sides", Value::keyword("one-sided")),
        Attribute::new("print-color-mode", Value::keyword("monochrome")),
        Attribute::new("orientation-requested", Value::Enum(4)),
        Attribute::new("print-quality", Value::Enum(5)),
        Attribute::new("print-scaling", Value::keyword("fill")),
        Attribute::many("page-ranges", vec![Value::Range(1, 3), Value::Range(5, 5)]),
    ];
    assert_eq!(template(&all_options(), &hp()), Ok(expected));
}

#[test]
fn cosmetic_options_the_printer_does_not_list_are_left_out() {
    let opts = JobOptions {
        copies: Some(1),
        media: Some("na_ledger_11x17in".into()),
        sides: Some(Sides::TwoSidedLongEdge),
        color_mode: Some(ColorMode::Color),
        orientation: Some(Orientation::Auto),
        quality: Some(Quality::Draft),
        ..JobOptions::default()
    };
    assert_eq!(template(&opts, &hp()), Ok(vec![Attribute::new("print-quality", Value::Enum(3))]));
    assert_eq!(template(&JobOptions::default(), &hp()), Ok(Vec::new()));
}

#[test]
fn trays_and_paper_types_travel_in_media_col_with_the_size() {
    let laser = printer(vec![
        Attribute::many("media-supported", vec![Value::keyword("na_letter_8.5x11in")]),
        Attribute::many("media-source-supported", vec![Value::keyword("auto"), Value::keyword("tray-2")]),
        Attribute::many("media-type-supported", vec![Value::keyword("stationery"), Value::keyword("labels")]),
    ]);
    let letter = JobOptions { media: Some("na_letter_8.5x11in".into()), ..JobOptions::default() };
    let tray = JobOptions { source: Some("tray-2".into()), media_type: Some("labels".into()), ..letter.clone() };
    assert_eq!(template(&tray, &laser), Ok(vec![Attribute::new("media-col", col(Some((21590, 27940)), "tray-2", "labels"))]));
    assert_eq!(options(&template(&tray, &laser).unwrap()), JobOptions { media: None, ..tray });
    let plain = Ok(vec![Attribute::new("media", Value::keyword("na_letter_8.5x11in"))]);
    let unlisted = JobOptions { source: Some("tray-9".into()), media_type: Some("glossy".into()), ..letter.clone() };
    assert_eq!(template(&unlisted, &laser), plain, "trays and types the printer lacks are left out");
    let tray_only = JobOptions { source: Some("tray-2".into()), ..JobOptions::default() };
    let only = Value::Collection(vec![Attribute::new("media-source", Value::keyword("tray-2"))]);
    assert_eq!(template(&tray_only, &laser), Ok(vec![Attribute::new("media-col", only)]));
}

#[test]
fn copies_beyond_the_maximum_fail_instead_of_being_clamped() {
    let copies = |n| JobOptions { copies: Some(n), ..JobOptions::default() };
    assert_eq!(template(&copies(99), &hp()), Ok(vec![Attribute::new("copies", Value::Integer(99))]));
    assert_eq!(template(&copies(100), &hp()), Err("make 100 copies".to_string()));
    assert_eq!(template(&copies(2), &printer(Vec::new())), Err("make 2 copies".to_string()));
    assert_eq!(template(&copies(1), &printer(Vec::new())), Ok(Vec::new()));
}

#[test]
fn page_ranges_fail_when_the_printer_cannot_apply_them() {
    let ranges = |r: &str| JobOptions { page_ranges: Some(r.into()), ..JobOptions::default() };
    let refuses = printer(vec![Attribute::new("page-ranges-supported", Value::Boolean(false))]);
    assert_eq!(template(&ranges("1-2"), &refuses), Err("print only pages 1-2".to_string()));
    assert_eq!(template(&ranges("1-2"), &printer(Vec::new())), Err("print only pages 1-2".to_string()));
    assert_eq!(template(&ranges("3-1"), &hp()), Err("print only pages 3-1".to_string()));
    assert_eq!(template(&ranges("  "), &refuses), Ok(Vec::new()));
    let all = Attribute::many("page-ranges", vec![Value::Range(1, i32::MAX)]);
    assert_eq!(template(&ranges("-"), &hp()), Ok(vec![all]));
}

type RangeCase = (&'static str, Option<Vec<(i32, i32)>>);

#[test]
fn page_ranges_normalize_to_sorted_merged_ranges() {
    let max = i32::MAX;
    let cases: [RangeCase; 13] = [
        ("1-3,5,8-", Some(vec![(1, 3), (5, 5), (8, max)])),
        ("5,1-3", Some(vec![(1, 3), (5, 5)])),
        ("-3", Some(vec![(1, 3)])),
        ("1-5,3-7,9", Some(vec![(1, 7), (9, 9)])),
        ("1-3,4-6", Some(vec![(1, 6)])),
        ("-", Some(vec![(1, max)])),
        (" 2 , 2 ", Some(vec![(2, 2)])),
        ("1-3000000000", Some(vec![(1, max)])),
        ("3-1", None),
        ("0", None),
        ("a", None),
        ("", None),
        ("1-2-3", None),
    ];
    for (input, want) in cases {
        assert_eq!(parse_ranges(input), want, "{input:?}");
    }
}

#[test]
fn resends_drop_only_refused_options_and_never_copies_or_ranges() {
    let t: Vec<Attribute> = ["copies", "media", "sides", "page-ranges"].iter().map(|n| Attribute::new(n, Value::Integer(1))).collect();
    assert_eq!(names(retry_template(&t, &["media"])), strings(&["copies", "sides", "page-ranges"]));
    assert_eq!(names(retry_template(&t, &[])), strings(&["copies", "page-ranges"]), "printer named nothing");
    assert_eq!(names(retry_template(&t, &["job-name"])), strings(&["copies", "page-ranges"]), "named none of ours");
    assert_eq!(names(retry_template(&t, &["media", "page-ranges"])), None);
    assert_eq!(names(retry_template(&t, &["copies"])), None);
    assert_eq!(names(retry_template(&t[..1], &[])), None, "nothing left to drop");
    assert_eq!(names(retry_template(&[], &["media"])), None);
}

#[test]
fn received_job_attributes_become_options() {
    let attrs = vec![
        Attribute::new("copies", Value::Integer(2)),
        Attribute::new("media", Value::keyword("iso_a4_210x297mm")),
        Attribute::new("sides", Value::keyword("two-sided-short-edge")),
        Attribute::new("print-color-mode", Value::keyword("process-monochrome")),
        Attribute::new("orientation-requested", Value::Enum(6)),
        Attribute::many("page-ranges", vec![Value::Range(1, 3), Value::Range(7, 7), Value::Range(9, i32::MAX)]),
        Attribute::new("print-scaling", Value::keyword("auto-fit")),
        Attribute::new("print-quality", Value::Enum(3)),
        Attribute::new("media-col", col(None, "tray-2", "labels")),
    ];
    let expected = JobOptions {
        copies: Some(2),
        media: Some("iso_a4_210x297mm".into()),
        sides: Some(Sides::TwoSidedShortEdge),
        color_mode: Some(ColorMode::Monochrome),
        orientation: Some(Orientation::Landscape),
        page_ranges: Some("1-3,7,9-".into()),
        fit: Some(Fit::Fit),
        quality: Some(Quality::Draft),
        source: Some("tray-2".into()),
        media_type: Some("labels".into()),
    };
    assert_eq!(options(&attrs), expected);
    let automatic = [Attribute::new("media-col", col(None, "auto", " "))];
    assert_eq!(options(&automatic), JobOptions::default(), "the automatic tray and a blank type are no choice");
    let junk = [Attribute::new("copies", Value::Integer(0)), Attribute::new("sides", Value::keyword("both"))];
    assert_eq!(options(&junk), JobOptions::default());
}

#[test]
fn template_and_options_agree() {
    let attrs = template(&all_options(), &hp()).unwrap();
    assert_eq!(options(&attrs), JobOptions { page_ranges: Some("1-3,5".into()), ..all_options() });
}

#[test]
fn job_state_reads_state_reasons_message_and_pages() {
    use JobStateKind::*;
    let job = |attrs: Vec<Attribute>| Group { tag: group::JOB, attrs };
    let kinds = [(3, Pending), (4, Held), (5, Processing), (6, Stopped), (7, Canceled), (8, Aborted), (9, Completed)];
    for (n, kind) in kinds {
        assert_eq!(state(&job(vec![Attribute::new("job-state", Value::Enum(n))])).map(|s| s.state), Some(kind));
    }
    assert!(state(&job(vec![Attribute::new("job-state", Value::Enum(10))])).is_none());
    assert!(state(&job(Vec::new())).is_none());

    let s = state(&job(vec![
        Attribute::new("job-state", Value::Enum(5)),
        Attribute::many("job-state-reasons", vec![Value::keyword("none"), Value::keyword("job-printing")]),
        Attribute::new("job-state-message", Value::text("  ")),
        Attribute::new("job-printer-state-message", Value::text("Warming up")),
        Attribute::new("job-pages-completed", Value::Integer(-1)),
        Attribute::new("job-impressions-completed", Value::Integer(4)),
        Attribute::new("job-media-sheets-completed", Value::Integer(2)),
    ]))
    .unwrap();
    assert_eq!((&s.reasons[..], s.message.as_deref()), (&["job-printing".to_string()][..], Some("Warming up")));
    assert_eq!((s.impressions, s.sheets, s.pages()), (Some(4), Some(2), Some(4)));
    let sheets_only = vec![Attribute::new("job-state", Value::Enum(9)), Attribute::new("job-media-sheets-completed", Value::Integer(3))];
    let s = state(&job(sheets_only)).unwrap();
    assert_eq!((s.impressions, s.sheets, s.pages()), (None, Some(3), Some(3)));
}
