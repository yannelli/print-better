//! Places a decoded image on the paper and streams it out row by row (bilinear sampling).

use super::Job;
use crate::convert::image::Bitmap;
use crate::convert::pages;
use crate::convert::place::{Affine, Fitting, Scaling, place};
use crate::convert::raster::compress::luma;
use crate::convert::raster::{PageSetup, RasterSink};
use crate::error::Result;

const BAND_ROWS: u32 = 64;
const IMAGE_MARGIN: f64 = 18.0;

pub(crate) fn render(img: &Bitmap, job: &Job, sink: &mut dyn RasterSink) -> Result<u32> {
    pages::select(job.pages.as_ref(), 1)?;
    let (width, height) = job.media.pixels(job.dpi);
    let scaling = Scaling::from(job.fit, false);
    let margin = if scaling == Scaling::Fit { IMAGE_MARGIN } else { 0.0 };
    let fitting = Fitting { scaling, orientation: job.orientation, margin };
    let px_to_pt = 72.0 / img.dpi.unwrap_or(72.0);
    let content = (img.upright.0 * px_to_pt, img.upright.1 * px_to_pt);
    let device = f64::from(job.dpi) / 72.0;
    let mut forward = img
        .orient
        .then(Affine::scale(px_to_pt, px_to_pt))
        .then(place(content, (job.media.width, job.media.height), &fitting))
        .then(Affine::scale(device, device));
    // Whole-pixel offsets keep images that match the printer's resolution sharp.
    forward.0[4] = forward.0[4].round();
    forward.0[5] = forward.0[5].round();
    let Some(inverse) = forward.invert() else { return Ok(0) };

    let setup = PageSetup { width, height, dpi: job.dpi, color: job.color };
    sink.begin_page(&setup)?;
    let mut band = Vec::with_capacity(setup.row_bytes() * BAND_ROWS as usize);
    for y in 0..height {
        if y % BAND_ROWS == 0 {
            job.check_cancel()?;
        }
        row(img, &inverse, y, width, job.color, &mut band);
        if band.len() >= setup.row_bytes() * BAND_ROWS as usize {
            sink.write_rows(&band)?;
            band.clear();
        }
    }
    if !band.is_empty() {
        sink.write_rows(&band)?;
    }
    sink.end_page()?;
    Ok(1)
}

fn row(img: &Bitmap, inverse: &Affine, y: u32, width: u32, color: bool, out: &mut Vec<u8>) {
    let (u0, v0) = inverse.apply(0.5, f64::from(y) + 0.5);
    let [du, dv, ..] = inverse.0;
    for x in 0..width {
        let (u, v) = (u0 + du * f64::from(x), v0 + dv * f64::from(x));
        let (r, g, b) = sample(img, u, v);
        if color {
            out.extend_from_slice(&[r, g, b]);
        } else {
            out.push(if img.channels == 1 { r } else { luma(r, g, b) });
        }
    }
}

/// Bilinear sample at stored-pixel coordinate (u, v); white outside the image.
fn sample(img: &Bitmap, u: f64, v: f64) -> (u8, u8, u8) {
    let (w, h) = (f64::from(img.width), f64::from(img.height));
    if !(0.0..w).contains(&u) || !(0.0..h).contains(&v) {
        return (255, 255, 255);
    }
    let (fx, fy) = ((u - 0.5).max(0.0), (v - 0.5).max(0.0));
    let (x0, y0) = (fx as usize, fy as usize);
    let (x1, y1) = ((x0 + 1).min(img.width as usize - 1), (y0 + 1).min(img.height as usize - 1));
    let (tx, ty) = (fx - x0 as f64, fy - y0 as f64);
    let at = |x: usize, y: usize, c: usize| -> f64 {
        let i = (y * img.width as usize + x) * img.channels + c.min(img.channels - 1);
        f64::from(img.data.get(i).copied().unwrap_or(255))
    };
    let channel = |c: usize| -> u8 {
        let top = at(x0, y0, c) * (1.0 - tx) + at(x1, y0, c) * tx;
        let bottom = at(x0, y1, c) * (1.0 - tx) + at(x1, y1, c) * tx;
        (top * (1.0 - ty) + bottom * ty).round().clamp(0.0, 255.0) as u8
    };
    (channel(0), channel(1), channel(2))
}
