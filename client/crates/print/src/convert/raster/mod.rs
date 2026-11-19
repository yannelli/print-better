//! Raster encoders (PWG Raster, Apple URF, PCL 5, PostScript) fed one page at a time, row by row.

pub(crate) mod compress;
mod pcl;
mod ps;
mod pwg;
mod urf;

use super::media::Media;
use super::spool::Out;
use crate::error::Result;
use crate::model::{DocFormat, Quality, Sides};
use std::fs::File;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Encoding {
    Pwg,
    Urf,
    Pcl,
    PostScript,
}

impl Encoding {
    pub fn format(self) -> DocFormat {
        match self {
            Encoding::Pwg => DocFormat::PwgRaster,
            Encoding::Urf => DocFormat::Urf,
            Encoding::Pcl => DocFormat::Pcl,
            Encoding::PostScript => DocFormat::PostScript,
        }
    }

    pub fn of(format: DocFormat) -> Option<Encoding> {
        [Encoding::Pwg, Encoding::Urf, Encoding::Pcl, Encoding::PostScript].into_iter().find(|e| e.format() == format)
    }

    pub fn extension(self) -> &'static str {
        match self {
            Encoding::Pwg => "pwg",
            Encoding::Urf => "urf",
            Encoding::Pcl => "pcl",
            Encoding::PostScript => "ps",
        }
    }
}

/// Geometry of one page. Rows are 8-bit gray (0 = black), or 8-bit RGB when `color`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PageSetup {
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    pub color: bool,
}

impl PageSetup {
    pub fn row_bytes(&self) -> usize {
        self.width as usize * if self.color { 3 } else { 1 }
    }

    pub fn points(&self) -> (f64, f64) {
        let pt = |px: u32| f64::from(px) * 72.0 / f64::from(self.dpi);
        (pt(self.width), pt(self.height))
    }
}

pub(crate) trait RasterSink {
    fn begin_page(&mut self, page: &PageSetup) -> Result<()>;
    /// One or more whole rows, top to bottom.
    fn write_rows(&mut self, rows: &[u8]) -> Result<()>;
    fn end_page(&mut self) -> Result<()>;
}

/// Job-wide values the encoders put in their headers.
#[derive(Clone, Debug)]
pub(crate) struct Settings {
    pub media: Media,
    pub sides: Sides,
    pub quality: Option<Quality>,
    /// 1-bit output (PCL mono, PWG black_1); otherwise 8 bits per channel.
    pub bilevel: bool,
}

impl Settings {
    pub fn duplex(&self) -> (bool, bool) {
        match self.sides {
            Sides::OneSided => (false, false),
            Sides::TwoSidedLongEdge => (true, false),
            Sides::TwoSidedShortEdge => (true, true),
        }
    }

    pub fn quality_code(&self) -> u32 {
        match self.quality {
            Some(Quality::Draft) => 3,
            Some(Quality::High) => 5,
            _ => 4,
        }
    }

    /// The media name when the page matches it, so headers never claim the wrong size.
    pub fn media_name_for(&self, page: &PageSetup) -> &str {
        let (w, h) = page.points();
        let close = (w - self.media.width).abs() < 3.0 && (h - self.media.height).abs() < 3.0;
        if close { &self.media.name } else { "" }
    }
}

trait Encoder: RasterSink {
    fn out(&mut self) -> &mut Out;
    fn finish(self: Box<Self>, total_pages: u32) -> Result<()>;
}

/// Writes a complete stream: `render` draws each page once; extra copies repeat the page bytes.
pub(crate) fn encode(
    encoding: Encoding,
    settings: Settings,
    copies: u32,
    file: File,
    path: &Path,
    render: impl FnOnce(&mut dyn RasterSink) -> Result<u32>,
) -> Result<u32> {
    let out = Out::new(file, path);
    let mut encoder: Box<dyn Encoder> = match encoding {
        Encoding::Pwg => Box::new(pwg::Pwg::new(out, settings)?),
        Encoding::Urf => Box::new(urf::Urf::new(out, settings)?),
        Encoding::Pcl => Box::new(pcl::Pcl::new(out, settings)?),
        Encoding::PostScript => Box::new(ps::Ps::new(out, settings)?),
    };
    let start = encoder.out().pos();
    let pages = render(&mut *encoder)?;
    let end = encoder.out().pos();
    let copies = copies.max(1);
    encoder.out().repeat(start, end, copies - 1)?;
    let total = pages.saturating_mul(copies);
    encoder.finish(total)?;
    Ok(total)
}

/// Keeps identical consecutive lines together, the way PWG Raster and URF compress them.
pub(super) struct LinePacker {
    prev: Vec<u8>,
    repeats: usize,
    packed: Vec<u8>,
}

impl LinePacker {
    pub fn new() -> LinePacker {
        LinePacker { prev: Vec::new(), repeats: 0, packed: Vec::new() }
    }

    pub fn push(&mut self, line: &[u8], unit: usize, out: &mut Out) -> Result<()> {
        if self.repeats > 0 && self.repeats < 256 && self.prev == line {
            self.repeats += 1;
            return Ok(());
        }
        self.flush(unit, out)?;
        self.prev.clear();
        self.prev.extend_from_slice(line);
        self.repeats = 1;
        Ok(())
    }

    pub fn flush(&mut self, unit: usize, out: &mut Out) -> Result<()> {
        if self.repeats == 0 {
            return Ok(());
        }
        self.packed.clear();
        self.packed.push((self.repeats - 1) as u8);
        compress::pack_pixels(&self.prev, unit, &mut self.packed);
        self.repeats = 0;
        out.write(&self.packed)
    }
}

/// Splits `rows` into lines of `len` bytes.
pub(super) fn lines(rows: &[u8], len: usize) -> impl Iterator<Item = &[u8]> {
    rows.chunks_exact(len.max(1))
}
