//! Conversion tests and the helpers other modules' tests share.

mod compress;
pub(crate) mod decode;
mod image;
mod pages_media;
mod place;
mod plan;
mod raster;
mod spool;
mod text;

use super::media::Media;
use super::raster::{Encoding, PageSetup, RasterSink, Settings};
use super::source::Job;
use crate::engine::CancelFlag;
use crate::error::Result;
use crate::model::{Orientation, Sides};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

/// A scratch directory removed when the test ends.
pub(crate) struct TestDir(pub PathBuf);

impl TestDir {
    pub fn new(name: &str) -> TestDir {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pb-test-{}-{name}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test dir");
        TestDir(dir)
    }

    pub fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        std::fs::write(&path, bytes).expect("write test file");
        path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Records every page a source draws.
#[derive(Default)]
pub(crate) struct Capture {
    pub pages: Vec<(PageSetup, Vec<u8>)>,
}

impl RasterSink for Capture {
    fn begin_page(&mut self, page: &PageSetup) -> Result<()> {
        self.pages.push((*page, Vec::new()));
        Ok(())
    }

    fn write_rows(&mut self, rows: &[u8]) -> Result<()> {
        self.pages.last_mut().expect("rows after begin_page").1.extend_from_slice(rows);
        Ok(())
    }

    fn end_page(&mut self) -> Result<()> {
        Ok(())
    }
}

pub(crate) fn job(media: Media, dpi: u32, color: bool) -> Job {
    Job {
        media,
        dpi,
        color,
        crisp: false,
        fit: None,
        orientation: Orientation::Auto,
        pages: None,
        cancel: CancelFlag::default(),
    }
}

/// Media of `w` x `h` points.
pub(crate) fn paper(w: f64, h: f64) -> Media {
    Media { name: String::new(), width: w, height: h }
}

/// Deterministic pseudo-random bytes with runs, so compressors see both literals and repeats.
pub(crate) fn noise(len: usize, seed: u32) -> Vec<u8> {
    let mut state = seed.wrapping_mul(2_654_435_761).max(1);
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        let run = if state.is_multiple_of(4) { (state >> 8) as usize % 300 + 2 } else { 1 };
        out.extend(std::iter::repeat_n((state >> 16) as u8, run.min(len - out.len())));
    }
    out
}

pub(crate) fn settings(media: Media) -> Settings {
    Settings { media, sides: Sides::OneSided, quality: None, bilevel: false }
}

/// Encodes `pages` with `encoding` and returns the file's bytes and the reported page total.
pub(crate) fn encode(encoding: Encoding, settings: Settings, copies: u32, pages: &[(PageSetup, Vec<u8>)]) -> (Vec<u8>, u32) {
    let dir = TestDir::new("encode");
    let path = dir.0.join("out");
    let file = std::fs::File::create(&path).expect("create output");
    let total = crate::convert::raster::encode(encoding, settings, copies, file, &path, |sink| {
        for (setup, rows) in pages {
            sink.begin_page(setup)?;
            for band in rows.chunks(setup.row_bytes() * 7) {
                sink.write_rows(band)?;
            }
            sink.end_page()?;
        }
        Ok(pages.len() as u32)
    })
    .expect("encode");
    (std::fs::read(&path).expect("read output"), total)
}
