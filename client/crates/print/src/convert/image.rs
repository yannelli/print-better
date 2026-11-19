//! JPEG and PNG decoding into 8-bit gray or RGB, with size limits and EXIF orientation.

use super::place::Affine;
use crate::error::{Error, Result};
use crate::model::DocFormat;
use std::io::BufReader;
use std::path::Path;
use zune_jpeg::JpegDecoder;
use zune_jpeg::zune_core::colorspace::ColorSpace;
use zune_jpeg::zune_core::options::DecoderOptions;

const MAX_PIXELS: u64 = 50_000_000;
const MAX_SIDE: u32 = 30_000;
const MAX_FILE: u64 = 200 * 1024 * 1024;

pub(crate) struct Bitmap {
    pub width: u32,
    pub height: u32,
    /// 1 (gray) or 3 (RGB).
    pub channels: usize,
    pub data: Vec<u8>,
    /// Stored pixels to upright pixels, from EXIF orientation.
    pub orient: Affine,
    /// Upright size in pixels.
    pub upright: (f64, f64),
    pub dpi: Option<f64>,
}

fn too_big() -> Error {
    Error::Unsupported("This image is too large to print.".into())
}

fn damaged(kind: &str) -> Error {
    Error::Unsupported(format!("This {kind} image is damaged or can't be read."))
}

fn check_size(width: u32, height: u32) -> Result<()> {
    let ok = width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE;
    if !ok || u64::from(width) * u64::from(height) > MAX_PIXELS { Err(too_big()) } else { Ok(()) }
}

pub(crate) fn decode(path: &Path, format: DocFormat, gray: bool) -> Result<Bitmap> {
    if std::fs::metadata(path)?.len() > MAX_FILE {
        return Err(too_big());
    }
    match format {
        DocFormat::Jpeg => jpeg(&std::fs::read(path)?, gray),
        _ => png(path, gray),
    }
}

fn jpeg(bytes: &[u8], gray: bool) -> Result<Bitmap> {
    let options = DecoderOptions::default()
        .set_max_width(MAX_SIDE as usize)
        .set_max_height(MAX_SIDE as usize)
        .jpeg_set_out_colorspace(if gray { ColorSpace::Luma } else { ColorSpace::RGB });
    let mut decoder = JpegDecoder::new_with_options(std::io::Cursor::new(bytes), options);
    decoder.decode_headers().map_err(|_| damaged("JPEG"))?;
    let info = decoder.info().ok_or_else(|| damaged("JPEG"))?;
    let (width, height) = (u32::from(info.width), u32::from(info.height));
    check_size(width, height)?;
    let dpi = jfif_dpi(bytes);
    let orientation = decoder.exif().and_then(|e| exif_orientation(e)).unwrap_or(1);
    let pixels = decoder.decode().map_err(|_| damaged("JPEG"))?;
    let channels = decoder.output_colorspace().map_or(0, |c| c.num_components());
    let data = to_target(pixels, channels, width, height, gray).ok_or_else(|| damaged("JPEG"))?;
    Ok(oriented(width, height, gray, data, orientation, dpi))
}

fn png(path: &Path, gray: bool) -> Result<Bitmap> {
    let file = BufReader::new(std::fs::File::open(path)?);
    let mut decoder = png::Decoder::new_with_limits(file, png::Limits { bytes: 512 * 1024 * 1024 });
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(|_| damaged("PNG"))?;
    let (width, height) = (reader.info().width, reader.info().height);
    check_size(width, height)?;
    let dpi = reader.info().pixel_dims.and_then(|d| match d.unit {
        png::Unit::Meter => Some(f64::from(d.xppu) * 0.0254),
        png::Unit::Unspecified => None,
    });
    let channels = reader.output_color_type().0.samples();
    let out_channels = if gray { 1 } else { 3 };
    let mut data = Vec::with_capacity(width as usize * height as usize * out_channels);
    if reader.info().interlaced {
        let size = reader.output_buffer_size().ok_or_else(too_big)?;
        let mut buf = vec![0; size];
        reader.next_frame(&mut buf).map_err(|_| damaged("PNG"))?;
        convert_into(&buf, channels, gray, &mut data);
    } else {
        while let Some(row) = reader.next_row().map_err(|_| damaged("PNG"))? {
            convert_into(row.data(), channels, gray, &mut data);
        }
    }
    if data.len() != width as usize * height as usize * out_channels {
        return Err(damaged("PNG"));
    }
    Ok(oriented(width, height, gray, data, 1, dpi.filter(|d| *d >= 10.0)))
}

fn to_target(pixels: Vec<u8>, channels: usize, width: u32, height: u32, gray: bool) -> Option<Vec<u8>> {
    let expected = width as usize * height as usize * channels;
    if channels == 0 || pixels.len() < expected {
        return None;
    }
    if channels == if gray { 1 } else { 3 } {
        return Some(pixels);
    }
    let mut data = Vec::with_capacity(width as usize * height as usize * if gray { 1 } else { 3 });
    convert_into(&pixels[..expected], channels, gray, &mut data);
    Some(data)
}

/// Appends pixels as gray or RGB, compositing any alpha over white paper.
fn convert_into(src: &[u8], channels: usize, gray: bool, out: &mut Vec<u8>) {
    let blend = |v: u8, a: u8| ((u32::from(v) * u32::from(a) + 255 * (255 - u32::from(a))) / 255) as u8;
    for px in src.chunks_exact(channels.max(1)) {
        let (r, g, b) = match *px {
            [v] => (v, v, v),
            [v, a] => (blend(v, a), blend(v, a), blend(v, a)),
            [r, g, b] => (r, g, b),
            [r, g, b, a, ..] => (blend(r, a), blend(g, a), blend(b, a)),
            [] => (255, 255, 255),
        };
        if gray {
            out.push(super::raster::compress::luma(r, g, b));
        } else {
            out.extend_from_slice(&[r, g, b]);
        }
    }
}

fn oriented(width: u32, height: u32, gray: bool, data: Vec<u8>, orientation: u16, dpi: Option<f64>) -> Bitmap {
    let (w, h) = (f64::from(width), f64::from(height));
    let orient = Affine(match orientation {
        2 => [-1.0, 0.0, 0.0, 1.0, w, 0.0],
        3 => [-1.0, 0.0, 0.0, -1.0, w, h],
        4 => [1.0, 0.0, 0.0, -1.0, 0.0, h],
        5 => [0.0, 1.0, 1.0, 0.0, 0.0, 0.0],
        6 => [0.0, 1.0, -1.0, 0.0, h, 0.0],
        7 => [0.0, -1.0, -1.0, 0.0, h, w],
        8 => [0.0, -1.0, 1.0, 0.0, 0.0, w],
        _ => [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
    });
    let upright = if (5..=8).contains(&orientation) { (h, w) } else { (w, h) };
    Bitmap { width, height, channels: if gray { 1 } else { 3 }, data, orient, upright, dpi }
}

/// Pixel density from the JFIF APP0 segment, which zune-jpeg skips.
fn jfif_dpi(bytes: &[u8]) -> Option<f64> {
    let mut at = 2;
    while bytes.get(at) == Some(&0xFF) {
        let marker = *bytes.get(at + 1)?;
        let len = usize::from(u16::from_be_bytes([*bytes.get(at + 2)?, *bytes.get(at + 3)?]));
        let body = bytes.get(at + 4..at + 2 + len)?;
        if marker == 0xE0 && body.len() >= 12 && body.starts_with(b"JFIF\0") {
            let density = f64::from(u16::from_be_bytes([body[8], body[9]]));
            let dpi = match body[7] {
                1 => density,
                2 => density * 2.54,
                _ => return None,
            };
            return (dpi >= 10.0).then_some(dpi);
        }
        if !(0xE0..=0xEF).contains(&marker) {
            return None;
        }
        at += 2 + len;
    }
    None
}

/// Reads tag 0x0112 from IFD0 of a TIFF-structured EXIF block.
fn exif_orientation(tiff: &[u8]) -> Option<u16> {
    let le = match tiff.get(..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let b: [u8; 2] = tiff.get(at..at + 2)?.try_into().ok()?;
        Some(if le { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b: [u8; 4] = tiff.get(at..at + 4)?.try_into().ok()?;
        Some(if le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
    };
    let ifd = u32_at(4)? as usize;
    let count = u16_at(ifd)? as usize;
    (0..count.min(256))
        .map(|i| ifd + 2 + i * 12)
        .find(|&entry| u16_at(entry) == Some(0x0112))
        .and_then(|entry| u16_at(entry + 8))
        .filter(|o| (1..=8).contains(o))
}
