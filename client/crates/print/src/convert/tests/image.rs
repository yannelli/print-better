//! Image decoding and placement, from PNG and JPEG files generated in memory.

use super::{Capture, TestDir, job, paper};
use crate::convert::image::decode;
use crate::convert::source;
use crate::model::{DocFormat, Fit, Orientation};
use jpeg_encoder::{ColorType as JpegColor, Encoder as JpegEncoder, PixelDensity};
use png::{BitDepth, ColorType};

pub(crate) fn png_bytes(width: u32, height: u32, color: ColorType, depth: BitDepth, data: &[u8], dpi: Option<f64>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(color);
    encoder.set_depth(depth);
    if let Some(dpi) = dpi {
        let ppm = (dpi / 0.0254).round() as u32;
        encoder.set_pixel_dims(Some(png::PixelDimensions { xppu: ppm, yppu: ppm, unit: png::Unit::Meter }));
    }
    let mut writer = encoder.write_header().expect("png header");
    writer.write_image_data(data).expect("png data");
    writer.finish().expect("png end");
    out
}

fn jpeg_bytes(width: u16, height: u16, color: JpegColor, data: &[u8], exif: Option<Vec<u8>>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = JpegEncoder::new(&mut out, 95);
    encoder.set_density(PixelDensity::dpi(300));
    if let Some(exif) = exif {
        encoder.add_app_segment(1, exif).expect("exif segment");
    }
    encoder.encode(data, width, height, color).expect("jpeg");
    out
}

/// An EXIF APP1 body holding only an orientation tag (big-endian TIFF).
fn exif_orientation(value: u16) -> Vec<u8> {
    let mut e = b"Exif\0\0MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01".to_vec();
    e.extend_from_slice(&value.to_be_bytes());
    e.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
    e
}

#[test]
fn png_alpha_lands_on_white_and_density_is_read() {
    let dir = TestDir::new("png-alpha");
    let pixels = [255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 128, 255, 255, 255, 255];
    let path = dir.file("a.png", &png_bytes(4, 1, ColorType::Rgba, BitDepth::Eight, &pixels, Some(300.0)));
    let rgb = decode(&path, DocFormat::Png, false).expect("decode");
    assert_eq!(rgb.data, [255, 0, 0, 255, 255, 255, 127, 127, 127, 255, 255, 255]);
    assert!((rgb.dpi.expect("pHYs") - 300.0).abs() < 0.1);
    let gray = decode(&path, DocFormat::Png, true).expect("decode gray");
    assert_eq!((gray.channels, gray.data.len()), (1, 4));
    assert_eq!(&gray.data[1..], [255, 127, 255]);
}

#[test]
fn png_16_bit_and_gray_alpha_become_8_bit() {
    let dir = TestDir::new("png-16");
    let path = dir.file("g.png", &png_bytes(2, 1, ColorType::Grayscale, BitDepth::Sixteen, &[0, 0, 0xFF, 0xFF], None));
    let img = decode(&path, DocFormat::Png, true).expect("decode");
    assert_eq!((img.data.as_slice(), img.dpi), (&[0u8, 255][..], None));
    let path = dir.file("ga.png", &png_bytes(2, 1, ColorType::GrayscaleAlpha, BitDepth::Eight, &[0, 255, 0, 0], None));
    assert_eq!(decode(&path, DocFormat::Png, true).expect("decode").data, [0, 255]);
}

#[test]
fn jpeg_decodes_gray_and_rgb_with_density() {
    let dir = TestDir::new("jpeg");
    let path = dir.file("g.jpg", &jpeg_bytes(16, 8, JpegColor::Luma, &[128; 128], None));
    let gray = decode(&path, DocFormat::Jpeg, true).expect("gray");
    assert_eq!((gray.width, gray.height, gray.dpi), (16, 8, Some(300.0)));
    assert!(gray.data.iter().all(|v| v.abs_diff(128) <= 2));
    let rgb: Vec<u8> = (0..256).flat_map(|_| [200, 30, 30]).collect();
    let path = dir.file("c.jpg", &jpeg_bytes(16, 16, JpegColor::Rgb, &rgb, None));
    let color = decode(&path, DocFormat::Jpeg, false).expect("rgb");
    assert!(color.data.chunks(3).all(|p| p[0].abs_diff(200) <= 6 && p[1].abs_diff(30) <= 6 && p[2].abs_diff(30) <= 6));
}

#[test]
fn jpeg_exif_orientation_turns_the_image_upright() {
    let dir = TestDir::new("exif");
    let rgb = vec![90u8; 16 * 8 * 3];
    let path = dir.file("o.jpg", &jpeg_bytes(16, 8, JpegColor::Rgb, &rgb, Some(exif_orientation(6))));
    let img = decode(&path, DocFormat::Jpeg, false).expect("decode");
    assert_eq!(img.upright, (8.0, 16.0), "orientation 6 swaps the sides");
    assert_eq!(img.orient.apply(0.0, 0.0), (8.0, 0.0), "stored top-left ends up top-right");
}

#[test]
fn unreadable_and_oversized_images_are_refused() {
    let dir = TestDir::new("bad-images");
    let junk = dir.file("junk", b"\x89PNG\r\n\x1a\nnot really");
    assert!(decode(&junk, DocFormat::Png, true).is_err_and(|e| e.to_string().contains("damaged")));
    assert!(decode(&junk, DocFormat::Jpeg, true).is_err_and(|e| e.to_string().contains("damaged")));
    let wide = dir.file("wide.png", &png_bytes(30_001, 1, ColorType::Grayscale, BitDepth::Eight, &vec![0; 30_001], None));
    assert!(decode(&wide, DocFormat::Png, true).is_err_and(|e| e.to_string().contains("too large")));
}

/// Draws a black `w` x `h` px PNG at `dpi` onto `media` and returns the dark pixels' box.
fn placed(w: u32, h: u32, dpi: f64, media: (f64, f64), fit: Option<Fit>, orientation: Orientation) -> (u32, u32, u32, u32) {
    let dir = TestDir::new("place");
    let path = dir.file("b.png", &png_bytes(w, h, ColorType::Grayscale, BitDepth::Eight, &vec![0; (w * h) as usize], Some(dpi)));
    let mut j = job(paper(media.0, media.1), 72, false);
    j.fit = fit;
    j.orientation = orientation;
    let mut capture = Capture::default();
    assert_eq!(source::render(DocFormat::Png, &path, &j, &mut capture).expect("render"), 1);
    let (setup, rows) = &capture.pages[0];
    assert_eq!(rows.len(), (setup.width * setup.height) as usize);
    let dark: Vec<(u32, u32)> = rows.iter().enumerate().filter(|(_, v)| **v < 128).map(|(i, _)| (i as u32 % setup.width, i as u32 / setup.width)).collect();
    let xs = dark.iter().map(|d| d.0);
    let ys = dark.iter().map(|d| d.1);
    (xs.clone().min().unwrap_or(0), ys.clone().min().unwrap_or(0), xs.max().unwrap_or(0) + 1, ys.max().unwrap_or(0) + 1)
}

/// Boxes match to within a pixel: edges that fall exactly on a pixel boundary may round either way.
fn assert_box(got: (u32, u32, u32, u32), want: (u32, u32, u32, u32)) {
    let near = |a: u32, b: u32| a.abs_diff(b) <= 1;
    assert!(near(got.0, want.0) && near(got.1, want.1) && near(got.2, want.2) && near(got.3, want.3), "{got:?} vs {want:?}");
}

#[test]
fn images_fit_with_a_margin_by_default() {
    assert_box(placed(20, 10, 72.0, (100.0, 100.0), None, Orientation::Portrait), (18, 34, 82, 66));
}

#[test]
fn images_fill_or_print_actual_size_on_request() {
    assert_box(placed(20, 10, 72.0, (100.0, 100.0), Some(Fit::Fill), Orientation::Portrait), (0, 0, 100, 100));
    assert_box(placed(20, 10, 72.0, (100.0, 100.0), Some(Fit::None), Orientation::Portrait), (40, 45, 60, 55));
    assert_box(placed(20, 10, 144.0, (100.0, 100.0), Some(Fit::None), Orientation::Portrait), (45, 47, 55, 52));
}

#[test]
fn jpeg_density_sets_actual_size() {
    let dir = TestDir::new("jpeg-size");
    let path = dir.file("k.jpg", &jpeg_bytes(150, 75, JpegColor::Luma, &[0; 150 * 75], None));
    let mut j = job(paper(100.0, 100.0), 72, false);
    j.fit = Some(Fit::None);
    j.orientation = Orientation::Portrait;
    let mut capture = Capture::default();
    source::render(DocFormat::Jpeg, &path, &j, &mut capture).expect("render");
    let rows = &capture.pages[0].1;
    let dark_in_row = |y: usize| rows[y * 100..(y + 1) * 100].iter().filter(|&&v| v < 128).count();
    assert!(dark_in_row(50).abs_diff(36) <= 1, "150 px at 300 dpi is 36 pt: {}", dark_in_row(50));
}

#[test]
fn landscape_images_turn_on_portrait_paper() {
    let (x0, y0, x1, y1) = placed(40, 20, 72.0, (100.0, 200.0), Some(Fit::None), Orientation::Auto);
    assert_eq!((x1 - x0, y1 - y0), (20, 40));
}

#[test]
fn one_to_one_images_stay_sharp_when_centered_on_a_half_pixel() {
    let dir = TestDir::new("sharp");
    let mut pixels = vec![255u8; 10 * 3];
    pixels[10..20].fill(0);
    let path = dir.file("line.png", &png_bytes(10, 3, ColorType::Grayscale, BitDepth::Eight, &pixels, Some(72.0)));
    let mut j = job(paper(100.0, 100.0), 72, false);
    j.fit = Some(Fit::None);
    let mut capture = Capture::default();
    source::render(DocFormat::Png, &path, &j, &mut capture).expect("render");
    let rows = &capture.pages[0].1;
    let darkest: Vec<u8> = rows.chunks(100).map(|r| *r.iter().min().expect("row")).filter(|&v| v < 255).collect();
    assert_eq!(darkest, [0], "one solid row, not two half-gray ones");
}
