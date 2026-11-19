//! PostScript Level 2: one full-page 8-bit image per page, RunLength + ASCII85 encoded.

use super::compress::{Ascii85, packbits};
use super::{Encoder, PageSetup, RasterSink, Settings, lines};
use crate::convert::spool::Out;
use crate::error::Result;

/// RunLengthDecode end-of-data marker.
const EOD: u8 = 128;

pub(super) struct Ps {
    out: Out,
    page: Option<PageSetup>,
    number: u32,
    a85: Ascii85,
    rle: Vec<u8>,
}

fn pt(v: f64) -> String {
    let s = format!("{v:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

impl Ps {
    pub fn new(mut out: Out, settings: Settings) -> Result<Ps> {
        let (w, h) = (settings.media.width, settings.media.height);
        let (duplex, tumble) = settings.duplex();
        let mut device = format!("/PageSize [{} {}]", pt(w), pt(h));
        if duplex {
            device.push_str(&format!(" /Duplex true /Tumble {tumble}"));
        }
        let prolog = format!(
            "%!PS-Adobe-3.0\n%%Creator: Print Better\n%%LanguageLevel: 2\n%%Pages: (atend)\n\
             %%BoundingBox: 0 0 {} {}\n%%EndComments\n%%BeginSetup\n<< {device} >> setpagedevice\n%%EndSetup\n",
            w.round(),
            h.round()
        );
        out.write(prolog.as_bytes())?;
        Ok(Ps { out, page: None, number: 0, a85: Ascii85::new(), rle: Vec::new() })
    }

    fn drain(&mut self) -> Result<()> {
        self.out.write(&self.a85.text)?;
        self.a85.text.clear();
        Ok(())
    }
}

impl RasterSink for Ps {
    fn begin_page(&mut self, page: &PageSetup) -> Result<()> {
        self.number += 1;
        let (w, h) = page.points();
        let (space, decode) = if page.color { ("DeviceRGB", "0 1 0 1 0 1") } else { ("DeviceGray", "0 1") };
        // The image call sits in a procedure so it can flush both filters, leaving no stray "~>".
        let head = format!(
            "%%Page: {n} {n}\nsave\n{w} {h} scale\n/{space} setcolorspace\n\
             /PBa currentfile /ASCII85Decode filter def\n/PBr PBa /RunLengthDecode filter def\n\
             {{ << /ImageType 1 /Width {pw} /Height {ph} /BitsPerComponent 8 /Decode [{decode}] \
             /ImageMatrix [{pw} 0 0 -{ph} 0 {ph}] /DataSource PBr >> image PBr flushfile PBa flushfile }} exec\n",
            n = self.number,
            w = pt(w),
            h = pt(h),
            pw = page.width,
            ph = page.height,
        );
        self.out.write(head.as_bytes())?;
        self.page = Some(*page);
        Ok(())
    }

    fn write_rows(&mut self, rows: &[u8]) -> Result<()> {
        let Some(page) = self.page else { return Ok(()) };
        for line in lines(rows, page.row_bytes()) {
            self.rle.clear();
            packbits(line, &mut self.rle);
            self.a85.push(&self.rle);
        }
        self.drain()
    }

    fn end_page(&mut self) -> Result<()> {
        self.page = None;
        self.a85.push(&[EOD]);
        self.a85.finish();
        self.drain()?;
        self.out.write(b"restore showpage\n")
    }
}

impl Encoder for Ps {
    fn out(&mut self) -> &mut Out {
        &mut self.out
    }

    fn finish(mut self: Box<Self>, total_pages: u32) -> Result<()> {
        self.out.write(format!("%%Trailer\n%%Pages: {total_pages}\n%%EOF\n").as_bytes())?;
        self.out.finish()
    }
}
