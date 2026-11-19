//! `log` sink: a rotating file (1 MiB x 3) plus stderr for terminals and journald.

use crate::clock;
use log::{Level, LevelFilter, Log, Metadata, Record};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const MAX_BYTES: u64 = 1024 * 1024;
const KEEP: usize = 3;

struct Logger {
    sink: Option<Mutex<Sink>>,
    stderr: bool,
    pinned: Option<LevelFilter>,
}

struct Sink {
    path: PathBuf,
    file: Option<File>,
    size: u64,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

/// `PRINTBETTER_LOG` (error|warn|info|debug|trace) pins the level over `default` and settings.
pub fn init(file: Option<PathBuf>, stderr: bool, default: LevelFilter) {
    let pinned = std::env::var("PRINTBETTER_LOG").ok().and_then(|v| v.parse().ok());
    let logger = LOGGER.get_or_init(|| Logger { sink: file.map(|path| Mutex::new(Sink::open(path))), stderr, pinned });
    if log::set_logger(logger).is_ok() {
        log::set_max_level(pinned.unwrap_or(default));
    }
}

/// Applies `settings.logLevel` unless `PRINTBETTER_LOG` pinned the level.
pub fn set_debug(debug: bool) {
    if LOGGER.get().is_some_and(|l| l.pinned.is_none()) {
        log::set_max_level(if debug { LevelFilter::Debug } else { LevelFilter::Info });
    }
}

impl Log for Logger {
    fn enabled(&self, meta: &Metadata) -> bool {
        let ours = meta.target().starts_with("printbetter") || meta.target().starts_with("pb_print");
        ours || meta.level() <= Level::Warn || self.pinned == Some(LevelFilter::Trace)
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let target = record.target().strip_prefix("printbetter::").unwrap_or(record.target());
        let line = format!(
            "{} {:<5} {target}: {}\n",
            clock::format_utc(clock::now_ms()),
            record.level(),
            record.args()
        );
        if self.stderr {
            let _ = io::stderr().write_all(line.as_bytes());
        }
        if let Some(sink) = &self.sink {
            sink.lock().unwrap_or_else(|e| e.into_inner()).write(line.as_bytes());
        }
    }

    fn flush(&self) {}
}

impl Sink {
    fn open(path: PathBuf) -> Sink {
        let file = open_append(&path);
        let size = file.as_ref().and_then(|f| f.metadata().ok()).map_or(0, |m| m.len());
        Sink { path, file, size }
    }

    fn write(&mut self, bytes: &[u8]) {
        if self.size + bytes.len() as u64 > MAX_BYTES {
            self.file = None;
            for n in (1..KEEP).rev() {
                let _ = fs::rename(rotated(&self.path, n - 1), rotated(&self.path, n));
            }
            self.size = 0;
        }
        if self.file.is_none() {
            self.file = open_append(&self.path);
        }
        if let Some(file) = &mut self.file
            && file.write_all(bytes).is_ok()
        {
            self.size += bytes.len() as u64;
        }
    }
}

fn open_append(path: &Path) -> Option<File> {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

fn rotated(path: &Path, n: usize) -> PathBuf {
    if n == 0 { path.to_path_buf() } else { path.with_extension(format!("log.{n}")) }
}

/// The last `lines` lines across the current and rotated files, oldest first.
pub fn tail(path: &Path, lines: usize) -> Vec<String> {
    let mut all = Vec::new();
    for n in (0..KEEP).rev() {
        if let Ok(text) = fs::read_to_string(rotated(path, n)) {
            all.extend(text.lines().map(String::from));
        }
    }
    let skip = all.len().saturating_sub(lines);
    all.split_off(skip)
}

/// Prints lines appended to `path` until interrupted, following rotation.
pub fn follow(path: &Path) -> io::Result<()> {
    let mut pos = fs::metadata(path).map_or(0, |m| m.len());
    let mut out = io::stdout();
    loop {
        std::thread::sleep(Duration::from_millis(500));
        let len = fs::metadata(path).map_or(0, |m| m.len());
        if len < pos {
            pos = 0;
        }
        if len > pos {
            let mut file = File::open(path)?;
            file.seek(SeekFrom::Start(pos))?;
            let mut chunk = Vec::new();
            file.take(len - pos).read_to_end(&mut chunk)?;
            out.write_all(&chunk)?;
            out.flush()?;
            pos = len;
        }
    }
}
