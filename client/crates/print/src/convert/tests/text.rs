//! Plain text laid out as PDF, checked in the content streams and, with the renderer, as pixels.

use super::{Capture, TestDir};
use crate::convert::Media;
use crate::convert::pages::PageSet;
use crate::convert::text::to_pdf;

fn layout(text: &[u8], select: Option<&str>) -> (u32, Vec<u8>, TestDir) {
    let dir = TestDir::new("text");
    let src = dir.file("in.txt", text);
    let out = dir.0.join("out.pdf");
    let set = select.map(|s| PageSet::parse(s).expect("range"));
    let pages = to_pdf(&src, std::fs::File::create(&out).expect("create"), &Media::letter(), false, set.as_ref()).expect("layout");
    (pages, std::fs::read(&out).expect("read pdf"), dir)
}

/// Every content stream, inflated, in file order.
fn streams(pdf: &[u8]) -> Vec<String> {
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(start) = super::decode::find(pdf, b"stream\n", at) {
        let end = super::decode::find(pdf, b"\nendstream", start).expect("endstream");
        let raw = miniz_oxide::inflate::decompress_to_vec_zlib(&pdf[start + 7..end]).expect("zlib");
        found.push(String::from_utf8_lossy(&raw).into_owned());
        at = end + b"\nendstream".len();
    }
    found
}

fn shown(stream: &str) -> Vec<&str> {
    stream.lines().filter_map(|l| l.strip_prefix('(')?.strip_suffix(") Tj T*")).collect()
}

#[test]
fn pages_break_every_sixty_lines_on_letter() {
    let text: String = (1..=130).map(|n| format!("line {n}\n")).collect();
    let (pages, pdf, _dir) = layout(text.as_bytes(), None);
    assert_eq!(pages, 3);
    let s = streams(&pdf);
    assert_eq!(s.iter().map(|s| shown(s).len()).collect::<Vec<_>>(), [60, 60, 10]);
    assert_eq!(shown(&s[1])[0], "line 61");
    assert!(String::from_utf8_lossy(&pdf).contains("/Count 3"));
}

#[test]
fn long_lines_wrap_at_spaces_or_at_ninety_columns() {
    let text = format!("{}\n{}", "x".repeat(200), "word ".repeat(30));
    let (_, pdf, _dir) = layout(text.as_bytes(), None);
    let s = streams(&pdf);
    let lines = shown(&s[0]);
    assert_eq!(lines[..3].iter().map(|l| l.len()).collect::<Vec<_>>(), [90, 90, 20]);
    assert!(lines[3..].iter().all(|l| l.len() <= 90 && !l.starts_with(' ')), "{lines:?}");
    assert_eq!(lines[3..].join(" ").split_whitespace().count(), 30);
}

#[test]
fn form_feeds_and_tabs() {
    let (pages, pdf, _dir) = layout(b"one\x0ctwo\n\x0cthree\n\tx\ty", None);
    assert_eq!(pages, 3);
    let s = streams(&pdf);
    assert_eq!((shown(&s[0]), shown(&s[1])), (vec!["one"], vec!["two"]));
    assert_eq!(shown(&s[2]), ["three", "        x       y"]);
}

#[test]
fn win_ansi_escapes_and_encodings() {
    let (_, pdf, _dir) = layout("caf\u{e9} \u{20ac}5 \u{201c}q\u{201d} (a\\b) \u{4e2d}".as_bytes(), None);
    assert_eq!(shown(&streams(&pdf)[0]), [r"caf\351 \2005 \223q\224 \(a\\b\) ?"]);
    let (_, pdf, _dir) = layout(b"\xff\xfeh\0i\0", None);
    assert_eq!(shown(&streams(&pdf)[0]), ["hi"], "UTF-16 with a byte order mark");
    let (_, pdf, _dir) = layout(b"caf\xe9 \x80", None);
    assert_eq!(shown(&streams(&pdf)[0]), [r"caf\351 \200"], "Windows-1252 when not UTF-8");
}

#[test]
fn page_selection_and_empty_input() {
    let text: String = (1..=130).map(|n| format!("{n}\n")).collect();
    let (pages, pdf, _dir) = layout(text.as_bytes(), Some("3"));
    assert_eq!(pages, 1);
    assert_eq!(shown(&streams(&pdf)[0])[0], "121");
    let (pages, _, _dir) = layout(b"", None);
    assert_eq!(pages, 1, "an empty file still prints one blank page");
    let dir = TestDir::new("text-none");
    let src = dir.file("in.txt", b"short");
    let set = PageSet::parse("2").expect("range");
    let file = std::fs::File::create(dir.0.join("o.pdf")).expect("create");
    assert!(to_pdf(&src, file, &Media::letter(), false, Some(&set)).is_err());
}

#[cfg(feature = "raster")]
fn render(pdf: &std::path::Path) -> Capture {
    let mut capture = Capture::default();
    let job = super::job(Media::letter(), 36, false);
    crate::convert::source::render(crate::model::DocFormat::Pdf, pdf, &job, &mut capture).expect("render");
    capture
}

#[cfg(feature = "raster")]
#[test]
fn laid_out_text_renders_back_through_hayro() {
    let text: String = (1..=70).map(|n| format!("{n} The quick brown fox \u{e9}\n")).collect();
    let (pages, pdf, dir) = layout(text.as_bytes(), None);
    let path = dir.file("r.pdf", &pdf);
    let capture = render(&path);
    assert_eq!((pages, capture.pages.len()), (2, 2));
    for (setup, rows) in &capture.pages {
        assert_eq!((setup.width, setup.height), (306, 396));
        let ink = rows.iter().filter(|&&v| v < 160).count();
        assert!(ink > 200, "text is visible: {ink} dark pixels");
        let top_margin = &rows[..setup.width as usize * 17];
        assert!(top_margin.iter().all(|&v| v > 230), "nothing inside the half-inch margin");
    }
}

#[cfg(not(feature = "raster"))]
#[test]
fn pdf_rendering_is_unsupported_without_the_renderer() {
    let (_, pdf, dir) = layout(b"x", None);
    let path = dir.file("r.pdf", &pdf);
    let mut capture = Capture::default();
    let job = super::job(Media::letter(), 36, false);
    assert!(crate::convert::source::render(crate::model::DocFormat::Pdf, &path, &job, &mut capture).is_err());
}
