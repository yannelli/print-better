//! The self-describing hardware test page (a hand-written PDF) and helpers to inspect output.

use std::fmt::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[allow(dead_code)]
#[path = "../../src/convert/tests/decode.rs"]
pub mod decode;

/// Page size: fits on both Letter and A4, so it always prints at actual size.
pub const PAGE_MM: (f64, f64) = (190.0, 260.0);
pub const PAGE_MEDIA: &str = "om_pbtest_190x260mm";
const K: f64 = 72.0 / 25.4;
const LEFT: f64 = 12.0;

struct Ops(String);

impl Ops {
    fn y(top_mm: f64) -> f64 {
        (PAGE_MM.1 - top_mm) * K
    }

    fn text(&mut self, x: f64, baseline: f64, size: f64, bold: bool, s: &str) {
        let s = s.replace('\\', "\\\\").replace('(', "\\(").replace(')', "\\)");
        let font = if bold { "F2" } else { "F1" };
        let _ = writeln!(self.0, "BT /{font} {size} Tf {:.2} {:.2} Td ({s}) Tj ET", x * K, Ops::y(baseline));
    }

    fn rect(&mut self, x: f64, top: f64, w: f64, h: f64, gray: f64) {
        let _ = writeln!(self.0, "{gray:.3} g {:.2} {:.2} {:.2} {:.2} re f", x * K, Ops::y(top + h), w * K, h * K);
    }

    fn line(&mut self, from: (f64, f64), to: (f64, f64), width_pt: f64) {
        let _ = writeln!(self.0, "{width_pt} w 0 G {:.3} {:.3} m {:.3} {:.3} l S", from.0 * K, Ops::y(from.1), to.0 * K, Ops::y(to.1));
    }
}

/// One page: title, date, 16-step gray ramp, 0.5/1/2 pt lines, a 1 cm grid, and a 10 cm ruler.
pub fn test_page(path: &str, date: &str) -> Vec<u8> {
    let mut p = Ops(String::new());
    p.text(LEFT, 18.0, 20.0, true, "Print Better hardware test:");
    p.text(LEFT, 27.0, 16.0, true, path);
    p.text(LEFT, 35.0, 9.0, false, &format!("Printed {date} (UTC). Expect: ruler exactly 10 cm, grid squares exactly 1 cm."));
    p.text(LEFT, 44.0, 9.0, false, "Gray ramp, 0% to 100% black in 16 steps (1-bit printing merges the darkest four):");
    for i in 0..16 {
        p.rect(LEFT + f64::from(i) * 10.0, 46.0, 10.0, 15.0, 1.0 - f64::from(i) / 15.0);
    }
    p.text(LEFT, 65.0, 7.0, false, "0%");
    p.text(LEFT + 152.0, 65.0, 7.0, false, "100%");
    p.text(LEFT, 74.0, 9.0, false, "Line widths:");
    for (i, (width, label)) in [(0.5, "0.5 pt"), (1.0, "1 pt"), (2.0, "2 pt")].into_iter().enumerate() {
        let y = 80.0 + 6.0 * i as f64;
        p.line((LEFT, y), (LEFT + 100.0, y), width);
        p.text(LEFT + 104.0, y + 1.2, 9.0, false, label);
    }
    p.text(LEFT, 102.0, 9.0, false, "1 cm grid, 10 x 8 squares:");
    for i in 0..=10 {
        let x = LEFT + 10.0 * f64::from(i);
        p.line((x, 105.0), (x, 185.0), 0.5);
    }
    for j in 0..=8 {
        let y = 105.0 + 10.0 * f64::from(j);
        p.line((LEFT, y), (LEFT + 100.0, y), 0.5);
    }
    p.text(LEFT, 196.0, 9.0, false, "10 cm ruler (mm ticks):");
    p.line((LEFT, 212.0), (LEFT + 100.0, 212.0), 0.5);
    for mm in 0..=100 {
        let x = LEFT + f64::from(mm);
        let length = if mm % 10 == 0 { 6.0 } else if mm % 5 == 0 { 4.0 } else { 2.5 };
        p.line((x, 212.0), (x, 212.0 - length), 0.3);
        if mm % 10 == 0 {
            p.text(x - 1.0, 204.5, 8.0, false, &(mm / 10).to_string());
        }
    }
    p.text(LEFT, 226.0, 9.0, false, "If the ruler is not exactly 10 cm, the printer or driver is scaling the page.");
    pdf(&p.0)
}

fn pdf(content: &str) -> Vec<u8> {
    let (w, h) = (PAGE_MM.0 * K, PAGE_MM.1 * K);
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w:.2} {h:.2}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>"),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>".to_string(),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    offsets.iter().for_each(|o| out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes()));
    out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
    out
}

/// Today's UTC date as YYYY-MM-DD (days-to-civil conversion).
pub fn today() -> String {
    let days = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() / 86_400) as i64 + 719_468;
    let (era, doe) = (days.div_euclid(146_097), days.rem_euclid(146_097));
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (day, month) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

pub fn write_png(path: &Path, page: &decode::Page) {
    let file = std::io::BufWriter::new(std::fs::File::create(path).expect("create png"));
    let mut encoder = png::Encoder::new(file, page.width as u32, page.height as u32);
    encoder.set_color(if page.channels == 3 { png::ColorType::Rgb } else { png::ColorType::Grayscale });
    let ppm = (f64::from(page.dpi) / 0.0254).round() as u32;
    encoder.set_pixel_dims(Some(png::PixelDimensions { xppu: ppm, yppu: ppm, unit: png::Unit::Meter }));
    let mut writer = encoder.write_header().expect("png header");
    writer.write_image_data(&page.data).expect("png data");
    writer.finish().expect("png end");
}

/// The longest horizontal run of dark pixels, in millimetres: the ruler and grid are 100 mm.
pub fn longest_dark_run_mm(page: &decode::Page) -> f64 {
    let dark = |px: &[u8]| px.iter().map(|&v| u32::from(v)).sum::<u32>() < 128 * px.len() as u32;
    let row_bytes = page.width * page.channels;
    let longest = page
        .data
        .chunks(row_bytes)
        .map(|row| {
            let (mut best, mut run) = (0, 0);
            for px in row.chunks(page.channels) {
                run = if dark(px) { run + 1 } else { 0 };
                best = best.max(run);
            }
            best
        })
        .max()
        .unwrap_or(0);
    longest as f64 / f64::from(page.dpi) * 25.4
}
