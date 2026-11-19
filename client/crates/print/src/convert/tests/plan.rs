//! The conversion matrix: route kind x printer formats x job options -> plan, options sent, repeats.

use crate::convert::Media;
use crate::convert::plan::{Plan, Target, plan, printer_options};
use crate::convert::raster::Encoding;
use crate::ipp::PrinterAttrs;
use crate::model::{Capabilities, ColorMode, DocFormat, JobOptions, Quality};

const PDF: &str = "application/pdf";
const PWG: &str = "image/pwg-raster";
const URF: &str = "image/urf";
const PCL: &str = "application/vnd.hp-PCL";
const PS: &str = "application/postscript";
const JPEG: &str = "image/jpeg";

#[derive(Debug, PartialEq)]
enum Want {
    Original(DocFormat),
    TextPdf,
    /// Encoding, dpi, color, bilevel, copies drawn in.
    Raster(Encoding, u32, bool, bool, u32),
    Error(&'static str),
}

fn caps(formats: &[&str], color: bool, copies_max: u32) -> Capabilities {
    Capabilities { formats: formats.iter().map(|f| f.to_string()).collect(), color, copies_max, ..Capabilities::default() }
}

fn attrs(formats: &[&str], color: bool, copies_max: u32) -> PrinterAttrs {
    PrinterAttrs { capabilities: caps(formats, color, copies_max), ..PrinterAttrs::default() }
}

fn ipp(formats: &[&str], color: bool, copies_max: u32) -> Target {
    Target::ipp(&attrs(formats, color, copies_max), false)
}

fn ipp_with(a: PrinterAttrs) -> Target {
    Target::ipp(&a, false)
}

fn raw(formats: &[&str], color: bool) -> Target {
    Target::raw(&caps(formats, color, 1))
}

fn o() -> JobOptions {
    JobOptions::default()
}

fn copies(n: u32) -> JobOptions {
    JobOptions { copies: Some(n), ..o() }
}

fn pages(ranges: &str) -> JobOptions {
    JobOptions { page_ranges: Some(ranges.into()), ..o() }
}

fn summary(p: &Plan) -> Want {
    match p {
        Plan::Original(f) => Want::Original(*f),
        Plan::TextPdf => Want::TextPdf,
        Plan::Raster { encoding, spec, .. } => Want::Raster(*encoding, spec.dpi, spec.color, spec.bilevel, spec.copies),
        Plan::Gdi(_) => panic!("GDI plans only exist on Windows"),
    }
}

/// (name, target, input, options, expected plan, expected (copies, page-ranges) sent and repeats)
type Case = (&'static str, Target, DocFormat, JobOptions, Want, (Option<u32>, Option<&'static str>, u32));

fn cases() -> Vec<Case> {
    use DocFormat::*;
    use Encoding::{Pcl, Pwg, Urf};
    let ranged = ipp_with(PrinterAttrs { page_ranges_supported: true, ..attrs(&[PDF, PWG], false, 99) });
    let urf_color = ipp_with(PrinterAttrs { urf_supported: vec!["W8".into(), "SRGB24".into(), "RS300-600".into()], ..attrs(&[URF], true, 99) });
    let pwg_ranged = ipp_with(PrinterAttrs { page_ranges_supported: true, ..attrs(&[PWG], false, 99) });
    let black1 = ipp_with(PrinterAttrs { pwg_types: vec!["black_1".into()], pwg_resolutions: vec![600], ..attrs(&[PWG], false, 99) });
    let srgb_only = ipp_with(PrinterAttrs { pwg_types: vec!["srgb_8".into()], ..attrs(&[PWG], false, 99) });
    let cups = Target::ipp(&attrs(&[], false, 9999), true);
    let high = JobOptions { quality: Some(Quality::High), ..o() };
    let mono_page = JobOptions { color_mode: Some(ColorMode::Monochrome), ..pages("1") };
    let text_copies = JobOptions { copies: Some(2), ..pages("2") };
    vec![
        ("ipp pdf passes through", ipp(&[PDF, PWG], false, 99), Pdf, o(), Want::Original(Pdf), (None, None, 1)),
        ("ipp copies within max stay printer-side", ipp(&[PDF, PWG], false, 99), Pdf, copies(3), Want::Original(Pdf), (Some(3), None, 1)),
        ("ipp copies over max are drawn in", ipp(&[PDF, PWG], false, 1), Pdf, copies(3), Want::Raster(Pwg, 300, false, false, 3), (None, None, 1)),
        ("ipp ranges without support render locally", ipp(&[PDF, PWG], false, 99), Pdf, pages("1-2"), Want::Raster(Pwg, 300, false, false, 1), (None, None, 1)),
        ("ipp ranges with support pass through", ranged, Pdf, pages("1-2"), Want::Original(Pdf), (None, Some("1-2"), 1)),
        ("ipp text becomes pdf, pages chosen locally", ipp(&[PDF], false, 99), Text, text_copies, Want::TextPdf, (Some(2), None, 1)),
        ("ipp text to raster is mono", ipp(&[PWG], true, 99), Text, o(), Want::Raster(Pwg, 300, false, false, 1), (None, None, 1)),
        ("ipp jpeg to color urf", urf_color.clone(), Jpeg, o(), Want::Raster(Urf, 300, true, false, 1), (None, None, 1)),
        ("ipp high quality picks 600 dpi", urf_color, Jpeg, high.clone(), Want::Raster(Urf, 600, true, false, 1), (None, None, 1)),
        ("ipp pwg input with ranges is re-encoded", pwg_ranged, PwgRaster, pages("2"), Want::Raster(Pwg, 300, false, false, 1), (None, None, 1)),
        ("pwg black_1 printers get 1-bit", black1, Pdf, o(), Want::Raster(Pwg, 600, false, true, 1), (None, None, 1)),
        ("pwg srgb-only printers get color", srgb_only, Pdf, o(), Want::Raster(Pwg, 300, true, false, 1), (None, None, 1)),
        ("cups queues take text as is", cups, Text, o(), Want::Original(Text), (None, None, 1)),
        ("raw pdf with pjl repeats per copy", raw(&[PDF, PCL], false), Pdf, copies(2), Want::Original(Pdf), (None, None, 2)),
        ("raw pdf without pjl can't repeat", raw(&[PDF], false), Pdf, copies(2), Want::Error("extra copies"), (None, None, 0)),
        ("raw copies drawn into pwg", raw(&[PDF, PWG], false), Pdf, copies(2), Want::Raster(Pwg, 300, false, false, 2), (None, None, 1)),
        ("raw png to mono pcl is 1-bit", raw(&[PCL], false), Png, o(), Want::Raster(Pcl, 300, false, true, 1), (None, None, 1)),
        ("raw mono pcl goes to 600 dpi", raw(&[PCL], false), Png, high.clone(), Want::Raster(Pcl, 600, false, true, 1), (None, None, 1)),
        ("raw color pcl stops at 300 dpi", raw(&[PCL], true), Png, high, Want::Raster(Pcl, 300, true, false, 1), (None, None, 1)),
        ("raw color prefers postscript", raw(&[PS, PCL], true), Pdf, pages("1"), Want::Raster(Encoding::PostScript, 300, true, false, 1), (None, None, 1)),
        ("raw mono prefers pcl", raw(&[PS, PCL], true), Pdf, mono_page, Want::Raster(Pcl, 300, false, true, 1), (None, None, 1)),
        ("raw text becomes pdf", raw(&[PDF, PCL], false), Text, o(), Want::TextPdf, (None, None, 1)),
        ("raw jpeg ignores page ranges", raw(&[JPEG], false), Jpeg, pages("1"), Want::Original(Jpeg), (None, None, 1)),
        ("raw printer with no formats", raw(&[], false), Pdf, o(), Want::Error("doesn't accept any format"), (None, None, 0)),
        ("postscript needs a postscript printer", ipp(&[PDF], false, 99), PostScript, o(), Want::Error("can't print PostScript"), (None, None, 0)),
        ("bad page range", ipp(&[PDF], false, 99), Pdf, pages("x"), Want::Error("isn't valid"), (None, None, 0)),
    ]
}

/// PDF and text only reach raster through the renderer, which `--no-default-features` leaves out.
fn needs_renderer(input: DocFormat, want: &Want) -> bool {
    let rendered = matches!(want, Want::Raster(..) | Want::Error("extra copies" | "doesn't accept any format"));
    matches!(input, DocFormat::Pdf | DocFormat::Text) && rendered
}

#[test]
fn conversion_matrix() {
    for (name, target, input, options, want, sent) in cases() {
        let want = if !cfg!(feature = "raster") && needs_renderer(input, &want) { Want::Error("this build") } else { want };
        let result = plan(input, &target, &options);
        if let Want::Error(text) = want {
            let err = result.expect_err(name).to_string();
            assert!(err.contains(text), "{name}: {err}");
            continue;
        }
        let got = result.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(summary(&got), want, "{name}");
        let (sent_options, repeat) = printer_options(&got, &target, &options);
        assert_eq!((sent_options.copies, sent_options.page_ranges.as_deref(), repeat), sent, "{name}: options sent");
    }
}

#[test]
fn raster_media_follows_request_then_printer() {
    let printer = ipp_with(PrinterAttrs {
        capabilities: Capabilities { media_default: Some("na_legal_8.5x14in".into()), ..caps(&[PWG], false, 9) },
        ..PrinterAttrs::default()
    });
    let spec = |options: JobOptions| match plan(DocFormat::Png, &printer, &options).expect("plan") {
        Plan::Raster { spec, .. } => spec,
        other => panic!("expected raster, got {other:?}"),
    };
    assert_eq!(spec(o()).media.height, 1008.0);
    assert_eq!(spec(JobOptions { media: Some("iso_a4_210x297mm".into()), ..o() }).media, Media::a4());
}

#[test]
fn raw_targets_never_send_text_and_know_pjl() {
    let t = raw(&["text/plain", PDF, "application/vnd.hp-PCLXL"], false);
    assert_eq!(t.accepts, [DocFormat::Pdf]);
    assert!(t.pjl, "PCL XL printers speak PJL");
    assert!(!raw(&[PDF, URF], false).pjl);
    assert_eq!(t.copies_max, 1);
}
