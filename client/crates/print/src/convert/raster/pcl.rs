//! PCL 5 raster: 1-bit mono with TIFF PackBits, or 24-bit RGB (PCL 5c direct-by-pixel) with
//! delta rows, the pairing Ghostscript's Color LaserJet driver uses.

use super::compress::{delta_row, dither_row, packbits};
use super::{Encoder, PageSetup, RasterSink, Settings, lines};
use crate::convert::spool::Out;
use crate::error::Result;

const ESC: u8 = 0x1b;
/// Configure Image Data: device RGB, direct by pixel, 8 bits per primary.
const CID_RGB: &[u8] = b"\x1b*v6W\x00\x03\x00\x08\x08\x08";

pub(super) struct Pcl {
    out: Out,
    settings: Settings,
    page: Option<PageSetup>,
    /// Pixels skipped on the left, because PCL places raster on the logical page, not the paper edge.
    inset: usize,
    width: usize,
    row: u32,
    bits: Vec<u8>,
    packed: Vec<u8>,
    seed: Vec<u8>,
}

impl Pcl {
    pub fn new(mut out: Out, settings: Settings) -> Result<Pcl> {
        let mut setup = vec![ESC, b'E'];
        if let Some(code) = settings.media.pcl_code() {
            setup.extend_from_slice(format!("\x1b&l{code}A").as_bytes());
        }
        let sides = match settings.duplex() {
            (false, _) => 0,
            (true, false) => 1,
            (true, true) => 2,
        };
        setup.extend_from_slice(format!("\x1b&l0O\x1b&l{sides}S\x1b&l0E\x1b&l0L").as_bytes());
        out.write(&setup)?;
        let (bits, packed, seed) = (Vec::new(), Vec::new(), Vec::new());
        Ok(Pcl { out, settings, page: None, inset: 0, width: 0, row: 0, bits, packed, seed })
    }

    fn mono_row(&mut self, line: &[u8]) -> Result<()> {
        dither_row(&line[self.inset..self.inset + self.width], self.row, &mut self.bits);
        let used = self.bits.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
        if used == 0 {
            return self.out.write(b"\x1b*b0W");
        }
        self.packed.clear();
        packbits(&self.bits[..used], &mut self.packed);
        self.out.write(format!("\x1b*b{}W", self.packed.len()).as_bytes())?;
        self.out.write(&self.packed)
    }

    fn color_row(&mut self, line: &[u8]) -> Result<()> {
        self.packed.clear();
        delta_row(&line[self.inset * 3..(self.inset + self.width) * 3], &mut self.seed, &mut self.packed);
        self.out.write(format!("\x1b*b{}W", self.packed.len()).as_bytes())?;
        self.out.write(&self.packed)
    }
}

impl RasterSink for Pcl {
    fn begin_page(&mut self, page: &PageSetup) -> Result<()> {
        let inset = (self.settings.media.pcl_left_inset() * f64::from(page.dpi) / 72.0).round() as usize;
        self.inset = if (page.width as usize) > inset * 3 { inset } else { 0 };
        self.width = page.width as usize - self.inset * 2;
        let mut cmd = format!(
            "\x1b*p0x0Y\x1b*r0F\x1b*t{}R\x1b*r{}S\x1b*r{}T",
            page.dpi, self.width, page.height
        )
        .into_bytes();
        if page.color {
            cmd.extend_from_slice(CID_RGB);
        }
        cmd.extend_from_slice(if page.color { b"\x1b*r1A\x1b*b3M" } else { b"\x1b*r1A\x1b*b2M" });
        self.out.write(&cmd)?;
        // Start Raster Graphics zeroes the printer's seed row.
        self.seed.clear();
        self.seed.resize(self.width * 3, 0);
        self.page = Some(*page);
        self.row = 0;
        Ok(())
    }

    fn write_rows(&mut self, rows: &[u8]) -> Result<()> {
        let Some(page) = self.page else { return Ok(()) };
        for line in lines(rows, page.row_bytes()) {
            if page.color { self.color_row(line)? } else { self.mono_row(line)? }
            self.row += 1;
        }
        Ok(())
    }

    fn end_page(&mut self) -> Result<()> {
        self.page = None;
        self.out.write(b"\x1b*rB\x0c")
    }
}

impl Encoder for Pcl {
    fn out(&mut self) -> &mut Out {
        &mut self.out
    }

    fn finish(mut self: Box<Self>, _total_pages: u32) -> Result<()> {
        self.out.write(&[ESC, b'E'])?;
        self.out.finish()
    }
}
