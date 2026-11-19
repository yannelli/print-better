//! GDI printing through the installed driver: pages are rendered here, then drawn in
//! strips with StretchDIBits, so any printer Windows can drive prints them.

use super::{PAPERS, Printer, wide};
use crate::convert::raster::{PageSetup, RasterSink};
use crate::convert::{self, Media};
use crate::engine::CancelFlag;
use crate::error::{Error, Result};
use crate::model::{ColorMode, DocFormat, JobOptions, Quality, Sides};
use std::path::Path;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::Graphics::Printing::DocumentPropertiesW;
use windows_sys::Win32::Storage::Xps::{AbortDoc, DOCINFOW, EndDoc, EndPage, StartDocW, StartPage};

const STRIP_ROWS: usize = 256;

pub(crate) struct GdiJob<'a> {
    pub printer: &'a str,
    pub doc_name: &'a str,
    pub input: DocFormat,
    pub path: &'a Path,
    pub state_dir: &'a Path,
    pub options: &'a JobOptions,
    pub color: bool,
    pub copies_max: u32,
    pub cancel: &'a CancelFlag,
}

struct Dc(HDC);

impl Drop for Dc {
    fn drop(&mut self) {
        // SAFETY: the DC came from CreateDCW and is deleted once.
        unsafe { DeleteDC(self.0) };
    }
}

fn failed(what: &str) -> Error {
    Error::Rejected(format!("Windows couldn't {what}."))
}

/// Draws every page; returns the spooler job id and the pages printed. Blocking.
pub(crate) fn print(job: &GdiJob) -> Result<(u32, u32)> {
    let printer = Printer::open(job.printer)?;
    let copies = job.options.copies.unwrap_or(1).max(1);
    let driver_copies = copies > 1 && copies <= job.copies_max;
    let mut devmode = devmode(&printer, job.printer, job.options, driver_copies.then_some(copies))?;
    let name = wide(job.printer);
    // SAFETY: a null driver and port with the queue name and its validated DEVMODE.
    let dc = Dc(unsafe { CreateDCW(null(), name.as_ptr(), null(), devmode.as_mut_ptr().cast()) });
    if dc.0.is_null() {
        return Err(Error::Unreachable("Windows couldn't get the printer ready for drawing.".into()));
    }
    let geo = Geometry::of(dc.0)?;
    let goal = match job.options.quality {
        Some(Quality::Draft) => 150,
        Some(Quality::High) => 600,
        _ => 300,
    };
    let dpi = goal.min(geo.dpi.0).max(72) as u32;
    let media = Media {
        name: String::new(),
        width: f64::from(geo.size.0) * 72.0 / f64::from(geo.dpi.0),
        height: f64::from(geo.size.1) * 72.0 / f64::from(geo.dpi.1),
    };
    let color = job.color && job.options.color_mode != Some(ColorMode::Monochrome);
    let draw = convert::job(media, dpi, color, false, job.options, job.cancel)?;
    let doc = wide(job.doc_name);
    let info = DOCINFOW { cbSize: std::mem::size_of::<DOCINFOW>() as i32, lpszDocName: doc.as_ptr(), ..Default::default() };
    // SAFETY: the DC is valid and DOCINFOW points at a live string.
    let id = unsafe { StartDocW(dc.0, &info) };
    if id <= 0 {
        return Err(failed("start the print job"));
    }
    // SAFETY: plain state changes on a valid DC; HALFTONE needs the brush origin reset.
    unsafe {
        SetStretchBltMode(dc.0, HALFTONE);
        SetBrushOrgEx(dc.0, 0, 0, null_mut());
    }
    let mut strips = Strips { dc: dc.0, geo, page: None, row: 0, bgr: Vec::new() };
    let rounds = if driver_copies { 1 } else { copies };
    let mut pages = 0;
    let drawn = (0..rounds).try_for_each(|_| {
        pages += convert::render_document(job.input, job.path, job.state_dir, &draw, &mut strips)?;
        Ok(())
    });
    // SAFETY: closes or aborts the document started above.
    match drawn {
        Ok(()) if unsafe { EndDoc(dc.0) } > 0 => Ok((id as u32, if driver_copies { pages * copies } else { pages })),
        Ok(()) => Err(failed("finish the print job")),
        Err(e) => {
            unsafe { AbortDoc(dc.0) };
            Err(e)
        }
    }
}

#[derive(Clone, Copy)]
struct Geometry {
    dpi: (i32, i32),
    size: (i32, i32),
    offset: (i32, i32),
}

impl Geometry {
    fn of(dc: HDC) -> Result<Geometry> {
        // SAFETY: GetDeviceCaps only reads from a valid DC.
        let cap = |index: u32| unsafe { GetDeviceCaps(dc, index as i32) };
        let mut geo = Geometry {
            dpi: (cap(LOGPIXELSX), cap(LOGPIXELSY)),
            size: (cap(PHYSICALWIDTH), cap(PHYSICALHEIGHT)),
            offset: (cap(PHYSICALOFFSETX), cap(PHYSICALOFFSETY)),
        };
        if geo.size.0 <= 0 || geo.size.1 <= 0 {
            geo = Geometry { size: (cap(HORZRES), cap(VERTRES)), offset: (0, 0), ..geo };
        }
        if geo.dpi.0 <= 0 || geo.dpi.1 <= 0 || geo.size.0 <= 0 || geo.size.1 <= 0 {
            return Err(failed("read the printer's page size"));
        }
        Ok(geo)
    }
}

/// Receives rendered rows and draws them on the printer DC in strips.
struct Strips {
    dc: HDC,
    geo: Geometry,
    page: Option<PageSetup>,
    row: usize,
    bgr: Vec<u8>,
}

impl RasterSink for Strips {
    fn begin_page(&mut self, page: &PageSetup) -> Result<()> {
        // SAFETY: a document is open on this DC.
        if unsafe { StartPage(self.dc) } <= 0 {
            return Err(failed("start a new page"));
        }
        self.page = Some(*page);
        self.row = 0;
        Ok(())
    }

    fn write_rows(&mut self, rows: &[u8]) -> Result<()> {
        let Some(page) = self.page else { return Ok(()) };
        let (width, row_bytes) = (page.width as usize, page.row_bytes());
        let stride = (width * 3 + 3) & !3;
        let scale_y = f64::from(self.geo.size.1) / f64::from(page.height);
        for strip in rows.chunks(row_bytes * STRIP_ROWS) {
            let count = strip.len() / row_bytes;
            self.bgr.clear();
            self.bgr.resize(stride * count, 0);
            for (line, out) in strip.chunks_exact(row_bytes).zip(self.bgr.chunks_exact_mut(stride)) {
                if page.color {
                    for (o, i) in out.chunks_exact_mut(3).zip(line.chunks_exact(3)) {
                        o.copy_from_slice(&[i[2], i[1], i[0]]);
                    }
                } else {
                    for (o, &g) in out.chunks_exact_mut(3).zip(line) {
                        o.fill(g);
                    }
                }
            }
            let top = (self.row as f64 * scale_y).round() as i32;
            let bottom = ((self.row + count) as f64 * scale_y).round() as i32;
            let header = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(count as i32),
                biPlanes: 1,
                biBitCount: 24,
                biCompression: BI_RGB,
                ..Default::default()
            };
            let info = BITMAPINFO { bmiHeader: header, ..Default::default() };
            let (x, y) = (-self.geo.offset.0, top - self.geo.offset.1);
            // SAFETY: `bgr` holds `count` top-down rows of `stride` bytes described by `info`.
            let lines = unsafe {
                StretchDIBits(self.dc, x, y, self.geo.size.0, bottom - top, 0, 0, width as i32, count as i32, self.bgr.as_ptr().cast(), &info, DIB_RGB_COLORS, SRCCOPY)
            };
            if lines == 0 || lines == -1 {
                return Err(failed("draw the page"));
            }
            self.row += count;
        }
        Ok(())
    }

    fn end_page(&mut self) -> Result<()> {
        self.page = None;
        // SAFETY: closes the page opened in begin_page.
        if unsafe { EndPage(self.dc) } <= 0 {
            return Err(failed("finish the page"));
        }
        Ok(())
    }
}

fn paper_code(media: Option<&str>) -> Option<i16> {
    let want = Media::parse(media?)?;
    PAPERS.iter().find_map(|(code, name)| {
        let m = Media::parse(name)?;
        ((m.width - want.width).abs() < 2.0 && (m.height - want.height).abs() < 2.0).then_some(*code)
    })
}

/// The driver's defaults with our duplex, color, paper, and copies applied, 8-byte aligned.
fn devmode(printer: &Printer, name: &str, options: &JobOptions, copies: Option<u32>) -> Result<Vec<u64>> {
    let wname = wide(name);
    // SAFETY: mode 0 with null buffers asks for the DEVMODE size.
    let size = unsafe { DocumentPropertiesW(null_mut(), printer.0, wname.as_ptr(), null_mut(), null(), 0) };
    if size <= 0 {
        return Err(failed("read the printer's settings"));
    }
    let mut buf = vec![0u64; (size as usize).div_ceil(8)];
    let dm: *mut DEVMODEW = buf.as_mut_ptr().cast();
    // SAFETY: the buffer is at least `size` bytes, as the driver asked.
    if unsafe { DocumentPropertiesW(null_mut(), printer.0, wname.as_ptr(), dm, null(), DM_OUT_BUFFER) } < 0 {
        return Err(failed("read the printer's settings"));
    }
    // SAFETY: `dm` points at the DEVMODEW the driver just filled; these are plain fields.
    unsafe {
        let d = &mut *dm;
        d.dmFields |= DM_ORIENTATION;
        d.Anonymous1.Anonymous1.dmOrientation = DMORIENT_PORTRAIT as i16;
        if let Some(sides) = options.sides {
            d.dmFields |= DM_DUPLEX;
            d.dmDuplex = match sides {
                Sides::OneSided => DMDUP_SIMPLEX,
                Sides::TwoSidedLongEdge => DMDUP_VERTICAL,
                Sides::TwoSidedShortEdge => DMDUP_HORIZONTAL,
            };
        }
        if let Some(mode @ (ColorMode::Color | ColorMode::Monochrome)) = options.color_mode {
            d.dmFields |= DM_COLOR;
            d.dmColor = if mode == ColorMode::Color { DMCOLOR_COLOR } else { DMCOLOR_MONOCHROME };
        }
        if let Some(code) = paper_code(options.media.as_deref()) {
            d.dmFields |= DM_PAPERSIZE;
            d.Anonymous1.Anonymous1.dmPaperSize = code;
        }
        if let Some(n) = copies {
            d.dmFields |= DM_COPIES | DM_COLLATE;
            d.Anonymous1.Anonymous1.dmCopies = n.min(i16::MAX as u32) as i16;
            d.dmCollate = DMCOLLATE_TRUE;
        }
    }
    // SAFETY: input and output are the same validated buffer, which the API allows.
    if unsafe { DocumentPropertiesW(null_mut(), printer.0, wname.as_ptr(), dm, dm, DM_IN_BUFFER | DM_OUT_BUFFER) } < 0 {
        return Err(failed("apply the print settings"));
    }
    Ok(buf)
}
