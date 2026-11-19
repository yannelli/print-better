//! PWG Raster (PWG 5102.4): "RaS2", then per page a 1796-byte header and compressed lines.

use super::compress::dither_row;
use super::{Encoder, LinePacker, PageSetup, RasterSink, Settings, lines};
use crate::convert::spool::Out;
use crate::error::Result;

const HEADER_LEN: usize = 1796;
const SGRAY: u32 = 18;
const SRGB: u32 = 19;
const BLACK: u32 = 3;

pub(super) struct Pwg {
    out: Out,
    settings: Settings,
    page: Option<PageSetup>,
    lines: LinePacker,
    unit: usize,
    row: u32,
    bits: Vec<u8>,
}

impl Pwg {
    pub fn new(mut out: Out, settings: Settings) -> Result<Pwg> {
        out.write(b"RaS2")?;
        Ok(Pwg { out, settings, page: None, lines: LinePacker::new(), unit: 1, row: 0, bits: Vec::new() })
    }

    fn header(&self, page: &PageSetup) -> Vec<u8> {
        let bilevel = self.settings.bilevel && !page.color;
        let (bits_color, bits_pixel, space, colors, line) = match (bilevel, page.color) {
            (true, _) => (1, 1, BLACK, 1, page.width.div_ceil(8)),
            (false, true) => (8, 24, SRGB, 3, page.width * 3),
            (false, false) => (8, 8, SGRAY, 1, page.width),
        };
        let (duplex, tumble) = self.settings.duplex();
        let (w_pt, h_pt) = page.points();
        let mut h = vec![0u8; HEADER_LEN];
        put_str(&mut h, 0, "PwgRaster");
        for (offset, value) in [
            (272, u32::from(duplex)),
            (276, page.dpi),
            (280, page.dpi),
            (340, 1),
            (352, w_pt.round() as u32),
            (356, h_pt.round() as u32),
            (368, u32::from(tumble)),
            (372, page.width),
            (376, page.height),
            (384, bits_color),
            (388, bits_pixel),
            (392, line),
            (400, space),
            (420, colors),
            (456, 1),
            (460, 1),
            (472, page.width),
            (476, page.height),
            (480, 0x00FF_FFFF),
            (484, self.settings.quality_code()),
        ] {
            h[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
        }
        put_str(&mut h, 1732, self.settings.media_name_for(page));
        h
    }
}

fn put_str(h: &mut [u8], offset: usize, s: &str) {
    let bytes = &s.as_bytes()[..s.len().min(63)];
    h[offset..offset + bytes.len()].copy_from_slice(bytes);
}

impl RasterSink for Pwg {
    fn begin_page(&mut self, page: &PageSetup) -> Result<()> {
        let header = self.header(page);
        self.out.write(&header)?;
        self.unit = if page.color && !self.settings.bilevel { 3 } else { 1 };
        self.page = Some(*page);
        self.row = 0;
        Ok(())
    }

    fn write_rows(&mut self, rows: &[u8]) -> Result<()> {
        let Some(page) = self.page else { return Ok(()) };
        let bilevel = self.settings.bilevel && !page.color;
        for line in lines(rows, page.row_bytes()) {
            if bilevel {
                dither_row(line, self.row, &mut self.bits);
                self.lines.push(&self.bits, 1, &mut self.out)?;
            } else {
                self.lines.push(line, self.unit, &mut self.out)?;
            }
            self.row += 1;
        }
        Ok(())
    }

    fn end_page(&mut self) -> Result<()> {
        self.lines.flush(self.unit, &mut self.out)?;
        self.page = None;
        Ok(())
    }
}

impl Encoder for Pwg {
    fn out(&mut self) -> &mut Out {
        &mut self.out
    }

    fn finish(self: Box<Self>, _total_pages: u32) -> Result<()> {
        self.out.finish()
    }
}
