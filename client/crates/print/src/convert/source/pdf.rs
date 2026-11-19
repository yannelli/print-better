//! PDF pages drawn by hayro in horizontal bands, so no page needs one huge bitmap.

use super::Job;
use crate::convert::pages;
use crate::convert::place::{Fitting, Scaling, place};
use crate::convert::raster::compress::luma;
use crate::convert::raster::{PageSetup, RasterSink};
use crate::error::{Error, Result};
use hayro::hayro_interpret::{InterpreterSettings, TransformExt};
use hayro::hayro_syntax::{LoadPdfError, Pdf};
use hayro::kurbo::Affine;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::vello_cpu::{Pixmap, RasterizerSettings, RenderContext, Resources, TargetInit};
use hayro::{RenderCache, RenderSettings, render_into};
use std::path::Path;

const MAX_FILE: u64 = 256 * 1024 * 1024;
const MAX_PAGES: usize = 5000;
#[cfg(target_pointer_width = "64")]
const BAND_BYTES: usize = 48 << 20;
#[cfg(not(target_pointer_width = "64"))]
const BAND_BYTES: usize = 16 << 20;

fn load(path: &Path) -> Result<Pdf> {
    if std::fs::metadata(path)?.len() > MAX_FILE {
        return Err(Error::Unsupported("This PDF is too large to convert for this printer.".into()));
    }
    Pdf::new(std::fs::read(path)?).map_err(|e| match e {
        LoadPdfError::Decryption(_) => {
            Error::Unsupported("This PDF is password protected. Remove the password and try again.".into())
        }
        LoadPdfError::Invalid => Error::Unsupported("This PDF is damaged or can't be read.".into()),
    })
}

pub(super) fn render(path: &Path, job: &Job, sink: &mut dyn RasterSink) -> Result<u32> {
    let pdf = load(path)?;
    let all = pdf.pages();
    if all.len() > MAX_PAGES {
        return Err(Error::Unsupported(format!("This PDF has more than {MAX_PAGES} pages, which is too many to convert.")));
    }
    let selected = pages::select(job.pages.as_ref(), all.len())?;
    let (width, height) = job.media.pixels(job.dpi);
    let (Ok(w16), Ok(_)) = (u16::try_from(width), u16::try_from(height)) else {
        return Err(Error::Unsupported("This paper size is too large to print at this quality.".into()));
    };
    let band = (BAND_BYTES / (width as usize * 4)).clamp(16, height as usize) as u32;
    let setup = PageSetup { width, height, dpi: job.dpi, color: job.color };
    let interpreter = InterpreterSettings::default();
    let settings = RenderSettings { aliasing_threshold: job.crisp.then_some(128), ..RenderSettings::default() };
    let fitting = Fitting { scaling: Scaling::from(job.fit, true), orientation: job.orientation, margin: 0.0 };
    let device = Affine::scale(f64::from(job.dpi) / 72.0);
    let mut ctx = RenderContext::new(w16, band as u16);
    let mut pixmap = Pixmap::new(w16, band as u16);
    let mut rows = Vec::with_capacity(setup.row_bytes() * band as usize);

    for &index in &selected {
        job.check_cancel()?;
        let page = &all[index];
        let (pw, ph) = page.render_dimensions();
        let placed = place((f64::from(pw), f64::from(ph)), (job.media.width, job.media.height), &fitting);
        let base = device * Affine::new(placed.0) * page.initial_transform(true).to_kurbo();
        let cache = RenderCache::new();
        sink.begin_page(&setup)?;
        let mut y = 0;
        while y < height {
            job.check_cancel()?;
            ctx.reset();
            let shift = Affine::translate((0.0, -f64::from(y)));
            render_into(page, &cache, &interpreter, &settings, &mut ctx, shift * base);
            ctx.flush();
            let raster = RasterizerSettings { target_init: TargetInit::Clear(WHITE), ..RasterizerSettings::default() };
            ctx.render_with(&mut pixmap, &mut Resources::default(), raster);
            let count = band.min(height - y);
            rows.clear();
            to_rows(pixmap.data_as_u8_slice(), width as usize * count as usize, job.color, &mut rows);
            sink.write_rows(&rows)?;
            y += count;
        }
        sink.end_page()?;
    }
    Ok(selected.len() as u32)
}

/// Premultiplied RGBA drawn over opaque white is plain RGB.
fn to_rows(rgba: &[u8], pixels: usize, color: bool, out: &mut Vec<u8>) {
    for px in rgba.chunks_exact(4).take(pixels) {
        if color {
            out.extend_from_slice(&px[..3]);
        } else {
            out.push(luma(px[0], px[1], px[2]));
        }
    }
}
