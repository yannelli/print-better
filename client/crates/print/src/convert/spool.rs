//! Scratch files for converted output under `<state_dir>/convert`, deleted on drop.

use crate::error::Result;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

static COUNTER: AtomicU64 = AtomicU64::new(0);
const STALE: Duration = Duration::from_secs(24 * 3600);

#[derive(Debug)]
pub(crate) struct TempFile {
    path: PathBuf,
}

impl TempFile {
    pub fn create(state_dir: &Path, ext: &str) -> Result<(TempFile, File)> {
        let dir = state_dir.join("convert");
        fs::create_dir_all(&dir)?;
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!("pb-{}-{n}.{ext}", std::process::id()));
        let _ = fs::remove_file(&path);
        let file = File::create_new(&path)?;
        Ok((TempFile { path }, file))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Removes scratch files a crashed process left behind.
pub(crate) fn sweep(state_dir: &Path) {
    let Ok(entries) = fs::read_dir(state_dir.join("convert")) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| now.duration_since(t).unwrap_or_default() > STALE);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Buffered output that tracks its offset so encoders can repeat or patch earlier bytes.
pub(crate) struct Out {
    w: BufWriter<File>,
    path: PathBuf,
    pos: u64,
}

impl Out {
    pub fn new(file: File, path: &Path) -> Out {
        Out { w: BufWriter::with_capacity(256 * 1024, file), path: path.to_path_buf(), pos: 0 }
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.w.write_all(bytes)?;
        self.pos += bytes.len() as u64;
        Ok(())
    }

    pub fn pos(&self) -> u64 {
        self.pos
    }

    /// Appends `times` more copies of the bytes in `start..end`.
    pub fn repeat(&mut self, start: u64, end: u64, times: u32) -> Result<()> {
        if times == 0 || end <= start {
            return Ok(());
        }
        self.w.flush()?;
        let mut reader = File::open(&self.path)?;
        for _ in 0..times {
            reader.seek(SeekFrom::Start(start))?;
            self.pos += std::io::copy(&mut (&mut reader).take(end - start), &mut self.w)?;
        }
        Ok(())
    }

    /// Overwrites already written bytes at `at`, then continues appending.
    pub fn patch(&mut self, at: u64, bytes: &[u8]) -> Result<()> {
        self.w.flush()?;
        let file = self.w.get_mut();
        file.seek(SeekFrom::Start(at))?;
        file.write_all(bytes)?;
        file.seek(SeekFrom::End(0))?;
        Ok(())
    }

    pub fn finish(mut self) -> Result<()> {
        self.w.flush()?;
        Ok(())
    }
}
