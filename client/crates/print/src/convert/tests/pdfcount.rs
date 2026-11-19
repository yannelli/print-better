//! The PDF page counter: each cross-reference style, broken files, and its limits.

use super::TestDir;
use super::pdfbuild::{Pdf, classic, tree};
use crate::convert::pdfcount::{Limits, count_with};
use std::time::Duration;

const CATALOG: &str = "<< /Type /Catalog /Pages 2 0 R >>";
const PAGE: &str = "<< /Type /Page /Parent 2 0 R >>";

fn counted_with(bytes: &[u8], limits: &Limits) -> Option<u32> {
    let dir = TestDir::new("pdfcount");
    count_with(&dir.file("doc.pdf", bytes), limits)
}

fn counted(bytes: &[u8]) -> Option<u32> {
    counted_with(bytes, &Limits::default())
}

/// PDF 1.5 with the catalog and page tree inside an object stream, found through an xref stream.
fn packed(count: u32, trailer: &str, predicted: bool) -> Vec<u8> {
    let mut pdf = Pdf::new("1.5");
    pdf.obj(3, PAGE);
    pdf.object_stream(5, &[(1, CATALOG), (2, &format!("<< /Type /Pages /Kids [3 0 R] /Count {count} >>"))]);
    let at = pdf.xref_stream(6, trailer, predicted);
    pdf.startxref(at)
}

/// `pdf` with its startxref pointing nowhere useful.
fn lost_xref(mut pdf: Vec<u8>) -> Vec<u8> {
    let at = pdf.windows(9).rposition(|w| w == b"startxref").unwrap();
    pdf.truncate(at);
    pdf.extend_from_slice(b"startxref\n5\n%%EOF\n");
    pdf
}

#[test]
fn classic_tables() {
    assert_eq!(counted(&classic(3)), Some(3));
}

#[test]
fn xref_streams_and_object_streams() {
    assert_eq!(counted(&packed(11, "/Root 1 0 R", true)), Some(11));
    assert_eq!(counted(&packed(11, "/Root 1 0 R", false)), Some(11));
}

#[test]
fn hybrid_files_read_the_xref_stream_too() {
    let mut pdf = Pdf::new("1.5");
    pdf.obj(3, PAGE);
    pdf.object_stream(5, &[(1, CATALOG), (2, "<< /Type /Pages /Kids [3 0 R] /Count 4 >>")]);
    let stream = pdf.xref_stream(6, "", false);
    let at = pdf.table(&[3, 5], &format!("/Size 7 /Root 1 0 R /XRefStm {stream}"));
    assert_eq!(counted(&pdf.startxref(at)), Some(4));
}

#[test]
fn incremental_updates_count_the_newest_page_tree() {
    let mut pdf = Pdf::new("1.4");
    tree(&mut pdf, 2);
    let first = pdf.table(&[1, 2, 3], "/Size 4 /Root 1 0 R");
    pdf.startxref(first);
    pdf.obj(2, "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>");
    let second = pdf.table(&[2], &format!("/Size 4 /Root 1 0 R /Prev {first}"));
    assert_eq!(counted(&pdf.startxref(second)), Some(3));
}

#[test]
fn linearized_files_go_from_the_first_page_table_to_the_main_one() {
    let section = |catalog: usize, pages: usize, main: usize| {
        format!(
            "xref\n1 2\n{catalog:010} 00000 n \n{pages:010} 00000 n \ntrailer\n<< /Size 8 /Root 1 0 R /Prev {main:010} >>\nstartxref\n0\n%%EOF\n"
        )
    };
    let mut out = b"%PDF-1.6\n7 0 obj\n<< /Linearized 1 /N 6 >>\nendobj\n".to_vec();
    let first = out.len();
    out.extend_from_slice(section(0, 0, 0).as_bytes());
    let catalog = out.len();
    out.extend_from_slice(format!("1 0 obj\n{CATALOG}\nendobj\n").as_bytes());
    let pages = out.len();
    out.extend_from_slice(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 6 >>\nendobj\n");
    let page = out.len();
    out.extend_from_slice(format!("3 0 obj\n{PAGE}\nendobj\n").as_bytes());
    let main = out.len();
    out.extend_from_slice(format!("xref\n3 1\n{page:010} 00000 n \ntrailer\n<< /Size 8 >>\nstartxref\n{first}\n%%EOF\n").as_bytes());
    let patched = section(catalog, pages, main);
    out.splice(first..first + patched.len(), patched.bytes());
    assert_eq!(counted(&out), Some(6));
}

#[test]
fn indirect_counts_and_large_page_trees() {
    let mut pdf = Pdf::new("1.4");
    pdf.obj(1, CATALOG).obj(2, "<< /Type /Pages /Kids [] /Count 9 0 R >>").obj(9, "7");
    let at = pdf.table(&[1, 2, 9], "/Size 10 /Root 1 0 R");
    assert_eq!(counted(&pdf.startxref(at)), Some(7));

    let kids: Vec<String> = (0..2000).map(|n| format!("{} 0 R", n + 10)).collect();
    let mut pdf = Pdf::new("1.4");
    pdf.obj(1, CATALOG).obj(2, &format!("<< /Type /Pages /Kids [{}] /Count 2000 >>", kids.join(" ")));
    let at = pdf.table(&[1, 2], "/Size 3 /Root 1 0 R");
    assert_eq!(counted(&pdf.startxref(at)), Some(2000), "an object bigger than the first read");
}

#[test]
fn a_damaged_cross_reference_falls_back_to_one_page_tree_root() {
    assert_eq!(counted(&lost_xref(classic(5))), Some(5));
    let mut pdf = Pdf::new("1.4");
    tree(&mut pdf, 3).obj(8, "<< /Type /Pages /Kids [] /Count 9 >>");
    let at = pdf.table(&[1, 2, 3, 8], "/Size 9 /Root 1 0 R");
    assert_eq!(counted(&lost_xref(pdf.startxref(at))), None, "two roots: unsure");
}

#[test]
fn broken_files_are_not_counted() {
    for bytes in [&b""[..], b"not a pdf at all", b"%PDF-1.4\nstartxref\n999999\n%%EOF\n", &classic(3)[..60]] {
        assert_eq!(counted(bytes), None, "{:?}", String::from_utf8_lossy(bytes));
    }
    assert_eq!(counted(&classic(0)), None, "an empty page tree");
    let mut pdf = Pdf::new("1.4");
    pdf.obj(1, CATALOG).obj(2, "<< /Type /Pages /Count -2 >>");
    let at = pdf.table(&[1, 2], "/Size 3 /Root 1 0 R");
    assert_eq!(counted(&pdf.startxref(at)), None, "a negative count");
    let nested = format!("<< /Type /Pages /Count 3 /Kids {}{} >>", "[".repeat(10_000), "]".repeat(10_000));
    let mut pdf = Pdf::new("1.4");
    pdf.obj(1, CATALOG).obj(2, &nested);
    let at = pdf.table(&[1, 2], "/Size 3 /Root 1 0 R");
    assert_eq!(counted(&pdf.startxref(at)), None, "nesting too deep to trust");
}

#[test]
fn prev_loops_end_and_encrypted_object_streams_are_skipped() {
    let mut pdf = Pdf::new("1.4");
    tree(&mut pdf, 3);
    let at = pdf.out.len();
    pdf.table(&[1, 2, 3], &format!("/Size 4 /Root 1 0 R /Prev {at}"));
    assert_eq!(counted(&pdf.startxref(at)), Some(3));
    assert_eq!(counted(&packed(11, "/Root 1 0 R /Encrypt 9 0 R", true)), None);
}

#[test]
fn the_work_is_bounded() {
    let mut pdf = Pdf::new("1.4");
    pdf.out.extend_from_slice(format!("%{}\n", "x".repeat(64 << 10)).as_bytes());
    tree(&mut pdf, 3);
    let at = pdf.table(&[1, 2, 3], "/Size 4 /Root 1 0 R");
    let padded = pdf.startxref(at);
    assert_eq!(counted(&padded), Some(3));
    let limited = |limits: Limits| counted_with(&padded, &limits);
    assert_eq!(limited(Limits { read_bytes: 1 << 10, ..Limits::default() }), None, "bytes read");
    assert_eq!(limited(Limits { reads: 2, ..Limits::default() }), None, "reads");
    assert_eq!(limited(Limits { time: Duration::ZERO, ..Limits::default() }), None, "time");
    let inflated = Limits { inflated: 16, ..Limits::default() };
    assert_eq!(counted_with(&packed(11, "/Root 1 0 R", true), &inflated), None, "inflated bytes");
}
