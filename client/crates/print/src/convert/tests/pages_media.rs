use crate::convert::media::{Media, for_locale};
use crate::convert::pages::{PageSet, select};

#[test]
fn page_set_parses_lists_and_open_ranges() {
    let set = PageSet::parse("1-3, 5 ,8-").expect("valid");
    let included: Vec<u32> = (1..=12).filter(|&p| set.contains(p)).collect();
    assert_eq!(included, [1, 2, 3, 5, 8, 9, 10, 11, 12]);
    assert!(set.contains(u32::MAX));
    let head = PageSet::parse("-3").expect("open start");
    assert_eq!((1..=5).filter(|&p| head.contains(p)).collect::<Vec<_>>(), [1, 2, 3]);
    assert!(PageSet::parse("7").expect("single").contains(7));
}

#[test]
fn page_set_rejects_nonsense() {
    for bad in ["", ",", "0", "3-1", "a", "1-b", "1--3", "-0"] {
        assert!(PageSet::parse(bad).is_err(), "{bad:?} should be rejected");
    }
    let too_many: Vec<String> = (1..=201).map(|n| n.to_string()).collect();
    assert!(PageSet::parse(&too_many.join(",")).is_err());
    assert!(PageSet::parse(&too_many[..200].join(",")).is_ok());
}

#[test]
fn select_keeps_document_order_and_needs_a_page() {
    assert_eq!(select(None, 3).expect("all"), [0, 1, 2]);
    let set = PageSet::parse("3,1").expect("valid");
    assert_eq!(select(Some(&set), 5).expect("some"), [0, 2]);
    let late = PageSet::parse("2-").expect("valid");
    assert_eq!(select(Some(&late), 3).expect("tail"), [1, 2]);
    assert!(select(Some(&PageSet::parse("5").expect("valid")), 3).is_err());
}

#[test]
fn media_parses_pwg_names_and_aliases() {
    let letter = Media::parse("na_letter_8.5x11in").expect("letter");
    assert_eq!((letter.width, letter.height), (612.0, 792.0));
    let a4 = Media::parse("iso_a4_210x297mm").expect("a4");
    assert!((a4.width - 595.28).abs() < 0.01 && (a4.height - 841.89).abs() < 0.01);
    for alias in ["A4", "a4", "iso-a4"] {
        assert_eq!(Media::parse(alias).expect(alias).height, a4.height, "{alias}");
    }
    assert_eq!(Media::parse("Letter").expect("alias").width, 612.0);
    assert_eq!(Media::parse("tabloid").expect("alias").name, "na_ledger_11x17in");
    let turned = Media::parse("custom_11x8.5in").expect("landscape name");
    assert_eq!((turned.width, turned.height), (612.0, 792.0), "stored portrait");
}

#[test]
fn media_rejects_unusable_sizes() {
    for bad in ["", "letterish", "custom_0x0in", "custom_0.2x0.2in", "custom_100x100in", "custom_axbmm", "iso_a4_210x297"] {
        assert!(Media::parse(bad).is_none(), "{bad:?}");
    }
}

#[test]
fn media_choose_prefers_request_then_printer() {
    let a4 = Media::parse("iso_a4_210x297mm").expect("a4");
    assert_eq!(Media::choose(Some("iso_a4_210x297mm"), Some("na_letter_8.5x11in")), a4);
    assert_eq!(Media::choose(Some("bogus"), Some("iso_a4_210x297mm")), a4);
    assert_eq!(Media::choose(None, Some("na_legal_8.5x14in")).height, 1008.0);
}

#[test]
fn locale_picks_letter_only_where_it_is_used() {
    for letter in ["en_US.UTF-8", "fr_CA", "es_MX.UTF-8@euro", "en_PH"] {
        assert_eq!(for_locale(letter), Media::letter(), "{letter}");
    }
    for a4 in ["de_DE.UTF-8", "en_GB", "C", "", "POSIX", "ja_JP"] {
        assert_eq!(for_locale(a4), Media::a4(), "{a4}");
    }
}

#[test]
fn media_printer_codes_and_geometry() {
    let letter = Media::letter();
    assert_eq!((letter.pcl_code(), letter.pjl_name()), (Some(2), Some("LETTER")));
    let a4 = Media::a4();
    assert_eq!((a4.pcl_code(), a4.pjl_name()), (Some(26), Some("A4")));
    assert_eq!(Media::parse("a5").and_then(|m| m.pcl_code()), Some(25));
    assert_eq!(Media::parse("custom_100x150mm").and_then(|m| m.pcl_code()), None);
    assert_eq!(letter.pcl_left_inset(), 18.0);
    assert!((a4.pcl_left_inset() - 6.0 * 72.0 / 25.4).abs() < 1e-9);
    assert_eq!(letter.pixels(300), (2550, 3300));
    assert_eq!(a4.pixels(600), (4961, 7016));
}
