//! Counts a PDF's pages from its cross-reference data and page tree, reading only what it needs.
//! Every limit is small; anything unexpected gives None rather than a guess.

mod lexer;
mod scan;
mod xref;

use lexer::{Lexer, Obj, Parsed, Stop};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{Duration, Instant};

const FIRST_WINDOW: usize = 4 << 10;
const MAX_WINDOW: usize = 8 << 20;
const MAX_REFS: u32 = 8;
const MAX_PAGES: u32 = 100_000;

#[derive(Clone, Debug)]
pub(crate) struct Limits {
    pub reads: u32,
    pub read_bytes: u64,
    pub inflated: usize,
    pub time: Duration,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { reads: 64, read_bytes: 32 << 20, inflated: 8 << 20, time: Duration::from_secs(2) }
    }
}

/// Pages in the PDF at `path`, or None when they can't be counted with confidence.
pub(crate) fn count(path: &Path) -> Option<u32> {
    count_with(path, &Limits::default())
}

pub(crate) fn count_with(path: &Path, limits: &Limits) -> Option<u32> {
    let file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let src = Source { file, len, reads: 0, read: 0, inflated: 0, deadline: Instant::now() + limits.time, limits: limits.clone() };
    let mut doc = Doc { src, xref: HashMap::new(), root: None, encrypted: false, packed: HashMap::new() };
    let counted = doc.load_xref().and_then(|()| doc.pages());
    counted.or_else(|| scan::page_tree_root(&mut doc.src)).and_then(valid)
}

fn valid(count: i64) -> Option<u32> {
    u32::try_from(count).ok().filter(|n| (1..=MAX_PAGES).contains(n))
}

/// The file, read in ranges against a budget of reads, bytes, inflated bytes and time.
pub(super) struct Source {
    file: File,
    len: u64,
    reads: u32,
    read: u64,
    inflated: usize,
    deadline: Instant,
    limits: Limits,
}

impl Source {
    fn out_of_time(&self) -> bool {
        Instant::now() >= self.deadline
    }

    fn read(&mut self, at: u64, want: usize) -> Option<Vec<u8>> {
        let len = usize::try_from(self.len.checked_sub(at)?).unwrap_or(usize::MAX).min(want);
        self.reads += 1;
        self.read += len as u64;
        if self.out_of_time() || self.reads > self.limits.reads || self.read > self.limits.read_bytes {
            return None;
        }
        let mut buf = vec![0; len];
        self.file.seek(SeekFrom::Start(at)).ok()?;
        self.file.read_exact(&mut buf).ok()?;
        Some(buf)
    }

    /// Runs `parse` on the bytes at `at`, reading more while it runs out before the end of the file.
    fn parse_at<T>(&mut self, at: u64, parse: impl Fn(&[u8]) -> Parsed<T>) -> Option<T> {
        let mut size = FIRST_WINDOW;
        loop {
            let buf = self.read(at, size)?;
            let whole = buf.len() < size;
            match parse(&buf) {
                Ok(found) => return Some(found),
                Err(Stop::Short) if !whole && size < MAX_WINDOW => size *= 4,
                Err(_) => return None,
            }
        }
    }

    fn inflate(&mut self, data: &[u8]) -> Option<Vec<u8>> {
        use miniz_oxide::inflate::{decompress_to_vec_with_limit, decompress_to_vec_zlib_with_limit};
        let room = self.limits.inflated.checked_sub(self.inflated)?;
        let out = match decompress_to_vec_zlib_with_limit(data, room) {
            Ok(out) => out,
            // Some writers get the zlib checksum wrong; the deflate data inside is still good.
            Err(_) => decompress_to_vec_with_limit(data.get(2..)?, room).ok()?,
        };
        self.inflated += out.len();
        (!self.out_of_time()).then_some(out)
    }
}

#[derive(Clone, Copy, Debug)]
enum Entry {
    At(u64),
    /// Inside the object stream with this number.
    Packed(u32),
}

/// A decoded object stream: its bytes, where objects start, and each object's offset from there.
struct Packed {
    data: Vec<u8>,
    first: usize,
    offsets: Vec<(u32, usize)>,
}

struct Doc {
    src: Source,
    xref: HashMap<u32, Entry>,
    root: Option<u32>,
    encrypted: bool,
    packed: HashMap<u32, Packed>,
}

impl Doc {
    fn pages(&mut self) -> Option<i64> {
        let catalog = self.get(self.root?, 0)?;
        let tree = self.resolve(catalog.get(b"Pages"), 0)?;
        if tree.get(b"Type").is_some() && !tree.is_type(b"Pages") {
            return None;
        }
        self.resolve(tree.get(b"Count"), 0)?.int()
    }

    fn resolve(&mut self, obj: Option<&Obj>, depth: u32) -> Option<Obj> {
        match obj? {
            Obj::Ref(num) => self.get(*num, depth + 1),
            other => Some(other.clone()),
        }
    }

    fn get(&mut self, num: u32, depth: u32) -> Option<Obj> {
        if depth > MAX_REFS {
            return None;
        }
        match *self.xref.get(&num)? {
            Entry::At(at) => self.object_at(at, Some(num)).map(|(obj, _)| obj),
            Entry::Packed(stream) => self.packed_object(num, stream, depth),
        }
    }

    /// The object at `at` (checked to be `num` when given) and, for a stream, where its data starts.
    fn object_at(&mut self, at: u64, num: Option<u32>) -> Option<(Obj, Option<u64>)> {
        let (found, obj, start) = self.src.parse_at(at, |buf| {
            let mut lx = Lexer::new(buf, 0);
            let found = lx.header()?;
            let obj = lx.object(0)?;
            let start = if matches!(obj, Obj::Dict(_)) { lx.stream_start()? } else { None };
            Ok((found, obj, start))
        })?;
        if num.is_some_and(|n| n != found) {
            return None;
        }
        Some((obj, start.map(|s| at + s as u64)))
    }

    /// A stream's data, decoded.
    fn stream(&mut self, dict: &Obj, start: u64, depth: u32) -> Option<Vec<u8>> {
        let len = usize::try_from(self.resolve(dict.get(b"Length"), depth)?.int()?).ok()?;
        if len > MAX_WINDOW {
            return None;
        }
        let raw = self.src.read(start, len).filter(|raw| raw.len() == len)?;
        xref::decode(&mut self.src, dict, raw)
    }

    fn packed_object(&mut self, num: u32, stream: u32, depth: u32) -> Option<Obj> {
        if !self.packed.contains_key(&stream) {
            let loaded = self.load_packed(stream, depth)?;
            self.packed.insert(stream, loaded);
        }
        let packed = self.packed.get(&stream)?;
        let offset = packed.offsets.iter().find(|(n, _)| *n == num)?.1;
        Lexer::new(&packed.data, packed.first.checked_add(offset)?).object(0).ok()
    }

    fn load_packed(&mut self, stream: u32, depth: u32) -> Option<Packed> {
        let Entry::At(at) = *self.xref.get(&stream)? else { return None };
        // Object streams of encrypted files are encrypted too.
        if self.encrypted {
            return None;
        }
        let (dict, start) = self.object_at(at, Some(stream))?;
        if !dict.is_type(b"ObjStm") {
            return None;
        }
        let mut data = self.stream(&dict, start?, depth)?;
        let count = usize::try_from(dict.get(b"N")?.int()?).ok()?;
        let first = usize::try_from(dict.get(b"First")?.int()?).ok()?;
        let mut lx = Lexer::new(&data, 0);
        let offsets = (0..count.min(data.len()))
            .map(|_| Some((u32::try_from(lx.uint().ok()?).ok()?, usize::try_from(lx.uint().ok()?).ok()?)))
            .collect::<Option<Vec<_>>>()?;
        // A trailing keyword marks where the last object ends, so a bare number there parses whole.
        data.extend_from_slice(b"\nendobj\n");
        Some(Packed { data, first, offsets })
    }
}
