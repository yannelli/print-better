//! Decodes URF and PWG Raster input (as phones and laptops send over LAN sharing) and
//! resamples it to the job's resolution and color mode.

use super::Job;
use crate::convert::raster::compress::luma;
use crate::convert::raster::{PageSetup, RasterSink};
use crate::error::{Error, Result};
use std::io::{BufReader, ErrorKind, Read};
use std::path::Path;

const MAX_SIDE: u32 = 20_000;
const MAX_OUT_SIDE: u32 = 30_000;
const MAX_PAGES: u32 = 5000;
const BAND_ROWS: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pixel {
    Gray,
    Gray1,
    Black8,
    Black1,
    Rgb,
}

impl Pixel {
    fn line_bytes(self, width: u32) -> usize {
        match self {
            Pixel::Gray | Pixel::Black8 => width as usize,
            Pixel::Gray1 | Pixel::Black1 => width.div_ceil(8) as usize,
            Pixel::Rgb => width as usize * 3,
        }
    }

    fn white(self) -> u8 {
        if matches!(self, Pixel::Black8 | Pixel::Black1) { 0 } else { 0xFF }
    }

    fn rgb(self, line: &[u8], x: usize) -> (u8, u8, u8) {
        let bit = |b: &[u8]| (b.get(x / 8).copied().unwrap_or(0) >> (7 - x % 8)) & 1;
        let v = match self {
            Pixel::Gray => line.get(x).copied().unwrap_or(255),
            Pixel::Black8 => 255 - line.get(x).copied().unwrap_or(0),
            Pixel::Gray1 => bit(line) * 255,
            Pixel::Black1 => (1 - bit(line)) * 255,
            Pixel::Rgb => return line.get(x * 3..x * 3 + 3).map_or((255, 255, 255), |p| (p[0], p[1], p[2])),
        };
        (v, v, v)
    }
}

struct Page {
    width: u32,
    height: u32,
    dpi: u32,
    pixel: Pixel,
}

fn damaged() -> Error {
    Error::Unsupported("This raster file is damaged or uses a color format Print Better can't read.".into())
}

fn u32_at(h: &[u8], at: usize) -> u32 {
    h.get(at..at + 4).and_then(|b| b.try_into().ok()).map_or(0, u32::from_be_bytes)
}

/// Reads exactly `buf.len()` bytes; `Ok(false)` on a clean end of file.
fn read_header(r: &mut impl Read, buf: &mut [u8]) -> Result<bool> {
    match r.read_exact(buf) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == ErrorKind::UnexpectedEof => Ok(false),
        Err(e) => Err(e.into()),
    }
}

fn next_page(r: &mut impl Read, urf: bool) -> Result<Option<Page>> {
    let mut h = vec![0u8; if urf { 32 } else { 1796 }];
    if !read_header(r, &mut h)? {
        return Ok(None);
    }
    let page = if urf {
        let pixel = match h[0] {
            8 => Pixel::Gray,
            24 => Pixel::Rgb,
            _ => return Err(damaged()),
        };
        Page { width: u32_at(&h, 12), height: u32_at(&h, 16), dpi: u32_at(&h, 20), pixel }
    } else {
        let pixel = match (u32_at(&h, 384), u32_at(&h, 388), u32_at(&h, 400)) {
            (8, 8, 18) => Pixel::Gray,
            (1, 1, 18) => Pixel::Gray1,
            (8, 8, 3) => Pixel::Black8,
            (1, 1, 3) => Pixel::Black1,
            (8, 24, 1 | 19 | 20) => Pixel::Rgb,
            _ => return Err(damaged()),
        };
        let page = Page { width: u32_at(&h, 372), height: u32_at(&h, 376), dpi: u32_at(&h, 276), pixel };
        if u32_at(&h, 392) as usize != pixel.line_bytes(page.width) {
            return Err(damaged());
        }
        page
    };
    let valid = (1..=MAX_SIDE).contains(&page.width) && (1..=MAX_SIDE).contains(&page.height);
    if !valid || !(50..=2400).contains(&page.dpi) {
        return Err(damaged());
    }
    Ok(Some(page))
}

/// Line decoder for the shared PWG/URF scheme: a line-repeat byte, then pixel runs.
struct Lines<'a, R: Read> {
    r: &'a mut R,
    pixel: Pixel,
    width: u32,
    line: Vec<u8>,
    repeats: u32,
    remaining: u32,
}

impl<R: Read> Lines<'_, R> {
    fn byte(&mut self) -> Result<u8> {
        let mut b = [0u8];
        self.r.read_exact(&mut b).map_err(|_| damaged())?;
        Ok(b[0])
    }

    fn next(&mut self) -> Result<&[u8]> {
        if self.remaining == 0 {
            return Err(damaged());
        }
        if self.repeats == 0 {
            self.repeats = u32::from(self.byte()?) + 1;
            self.decode()?;
        }
        self.repeats -= 1;
        self.remaining -= 1;
        Ok(&self.line)
    }

    fn decode(&mut self) -> Result<()> {
        let unit = if self.pixel == Pixel::Rgb { 3 } else { 1 };
        let len = self.pixel.line_bytes(self.width);
        self.line.clear();
        while self.line.len() < len {
            let code = self.byte()?;
            if code == 0x80 {
                self.line.resize(len, self.pixel.white());
                break;
            }
            let count = if code < 0x80 { usize::from(code) + 1 } else { 257 - usize::from(code) };
            if self.line.len() + count * unit > len {
                return Err(damaged());
            }
            if code < 0x80 {
                let mut px = [0u8; 3];
                self.r.read_exact(&mut px[..unit]).map_err(|_| damaged())?;
                (0..count).for_each(|_| self.line.extend_from_slice(&px[..unit]));
            } else {
                let start = self.line.len();
                self.line.resize(start + count * unit, 0);
                self.r.read_exact(&mut self.line[start..]).map_err(|_| damaged())?;
            }
        }
        Ok(())
    }

    fn skip_rest(&mut self) -> Result<()> {
        while self.remaining > 0 {
            self.next()?;
        }
        Ok(())
    }
}

pub(super) fn render(path: &Path, job: &Job, sink: &mut dyn RasterSink) -> Result<u32> {
    let mut r = BufReader::new(std::fs::File::open(path)?);
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic).map_err(|_| damaged())?;
    let urf = &magic == b"UNIR";
    if urf {
        let mut rest = [0u8; 8];
        r.read_exact(&mut rest).map_err(|_| damaged())?;
    } else if &magic != b"RaS2" {
        return Err(damaged());
    }
    let (mut index, mut printed) = (0u32, 0u32);
    while let Some(page) = next_page(&mut r, urf)? {
        job.check_cancel()?;
        index += 1;
        if index > MAX_PAGES {
            return Err(Error::Unsupported("This document has too many pages to convert.".into()));
        }
        let mut lines = Lines { r: &mut r, pixel: page.pixel, width: page.width, line: Vec::new(), repeats: 0, remaining: page.height };
        if job.pages.as_ref().is_none_or(|p| p.contains(index)) {
            resample(&mut lines, &page, job, sink)?;
            printed += 1;
        }
        lines.skip_rest()?;
    }
    if printed == 0 {
        return Err(Error::Unsupported("None of the selected pages are in this document.".into()));
    }
    Ok(printed)
}

fn resample<R: Read>(lines: &mut Lines<'_, R>, page: &Page, job: &Job, sink: &mut dyn RasterSink) -> Result<()> {
    let scale = f64::from(job.dpi) / f64::from(page.dpi);
    let size = |v: u32| (f64::from(v) * scale).round().max(1.0) as u32;
    let (width, height) = (size(page.width), size(page.height));
    if width > MAX_OUT_SIDE || height > MAX_OUT_SIDE {
        return Err(damaged());
    }
    let setup = PageSetup { width, height, dpi: job.dpi, color: job.color };
    let cols: Vec<usize> =
        (0..width).map(|x| ((f64::from(x) + 0.5) / scale) as usize).map(|c| c.min(page.width as usize - 1)).collect();
    sink.begin_page(&setup)?;
    let (mut source, mut consumed) = (Vec::new(), 0u32);
    let mut band = Vec::with_capacity(setup.row_bytes() * BAND_ROWS);
    for y in 0..height {
        let wanted = (((f64::from(y) + 0.5) / scale) as u32).min(page.height - 1);
        while consumed <= wanted {
            let line = lines.next()?;
            source.clear();
            source.extend_from_slice(line);
            consumed += 1;
        }
        for &x in &cols {
            let (r, g, b) = page.pixel.rgb(&source, x);
            if job.color { band.extend_from_slice(&[r, g, b]) } else { band.push(luma(r, g, b)) }
        }
        if band.len() >= setup.row_bytes() * BAND_ROWS {
            job.check_cancel()?;
            sink.write_rows(&band)?;
            band.clear();
        }
    }
    if !band.is_empty() {
        sink.write_rows(&band)?;
    }
    sink.end_page()
}
