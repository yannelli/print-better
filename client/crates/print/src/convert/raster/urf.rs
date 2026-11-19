//! Apple URF: "UNIRAST\0" + page count, then per page a 32-byte header and PWG-style lines.

use super::{Encoder, LinePacker, PageSetup, RasterSink, Settings, lines};
use crate::convert::spool::Out;
use crate::error::Result;

const COUNT_OFFSET: u64 = 8;
const STATIONERY: u8 = 1;

pub(super) struct Urf {
    out: Out,
    settings: Settings,
    page: Option<PageSetup>,
    lines: LinePacker,
}

impl Urf {
    pub fn new(mut out: Out, settings: Settings) -> Result<Urf> {
        out.write(b"UNIRAST\0")?;
        out.write(&0u32.to_be_bytes())?;
        Ok(Urf { out, settings, page: None, lines: LinePacker::new() })
    }

    fn unit(page: &PageSetup) -> usize {
        if page.color { 3 } else { 1 }
    }
}

impl RasterSink for Urf {
    fn begin_page(&mut self, page: &PageSetup) -> Result<()> {
        let (duplex, tumble) = self.settings.duplex();
        let mut h = [0u8; 32];
        h[0] = if page.color { 24 } else { 8 };
        h[1] = u8::from(page.color);
        h[2] = match (duplex, tumble) {
            (false, _) => 1,
            (true, true) => 2,
            (true, false) => 3,
        };
        h[3] = self.settings.quality_code() as u8;
        h[4] = STATIONERY;
        h[12..16].copy_from_slice(&page.width.to_be_bytes());
        h[16..20].copy_from_slice(&page.height.to_be_bytes());
        h[20..24].copy_from_slice(&page.dpi.to_be_bytes());
        self.out.write(&h)?;
        self.page = Some(*page);
        Ok(())
    }

    fn write_rows(&mut self, rows: &[u8]) -> Result<()> {
        let Some(page) = self.page else { return Ok(()) };
        for line in lines(rows, page.row_bytes()) {
            self.lines.push(line, Urf::unit(&page), &mut self.out)?;
        }
        Ok(())
    }

    fn end_page(&mut self) -> Result<()> {
        if let Some(page) = self.page.take() {
            self.lines.flush(Urf::unit(&page), &mut self.out)?;
        }
        Ok(())
    }
}

impl Encoder for Urf {
    fn out(&mut self) -> &mut Out {
        &mut self.out
    }

    fn finish(mut self: Box<Self>, total_pages: u32) -> Result<()> {
        self.out.patch(COUNT_OFFSET, &total_pages.to_be_bytes())?;
        self.out.finish()
    }
}
