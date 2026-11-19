//! Page sources: draw a document's selected pages, row by row, into an encoder or GDI.

mod bitmap;
#[cfg(feature = "raster")]
mod pdf;
mod rasterin;

use super::media::Media;
use super::pages::PageSet;
use super::raster::RasterSink;
use crate::engine::CancelFlag;
use crate::error::{Error, Result};
use crate::model::{DocFormat, Fit, Orientation};
use std::path::Path;

pub(crate) const NO_RASTER: &str =
    "This printer needs PDFs converted to images, and this build of Print Better can't do that.";

/// How pages are drawn: paper, resolution, color, scaling, and which pages.
#[derive(Clone)]
pub(crate) struct Job {
    pub media: Media,
    pub dpi: u32,
    pub color: bool,
    /// The output is 1-bit, so vector art is drawn without anti-aliasing.
    #[cfg_attr(not(feature = "raster"), allow(dead_code))]
    pub crisp: bool,
    pub fit: Option<Fit>,
    pub orientation: Orientation,
    pub pages: Option<PageSet>,
    pub cancel: CancelFlag,
}

impl Job {
    pub fn check_cancel(&self) -> Result<()> {
        if self.cancel.is_canceled() { Err(Error::Canceled) } else { Ok(()) }
    }
}

/// Draws each selected page of a PDF, JPEG, PNG, URF, or PWG Raster file; returns the page count.
pub(crate) fn render(format: DocFormat, path: &Path, job: &Job, sink: &mut dyn RasterSink) -> Result<u32> {
    match format {
        DocFormat::Pdf => render_pdf(path, job, sink),
        DocFormat::Jpeg | DocFormat::Png => {
            let image = super::image::decode(path, format, !job.color)?;
            bitmap::render(&image, job, sink)
        }
        DocFormat::Urf | DocFormat::PwgRaster => rasterin::render(path, job, sink),
        _ => Err(Error::Unsupported(format!("Print Better can't convert {} files.", super::label(format)))),
    }
}

#[cfg(feature = "raster")]
fn render_pdf(path: &Path, job: &Job, sink: &mut dyn RasterSink) -> Result<u32> {
    pdf::render(path, job, sink)
}

#[cfg(not(feature = "raster"))]
fn render_pdf(_path: &Path, _job: &Job, _sink: &mut dyn RasterSink) -> Result<u32> {
    Err(Error::Unsupported(NO_RASTER.into()))
}
