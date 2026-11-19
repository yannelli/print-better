//! Cross-reference data: classic tables, xref streams, hybrid files and /Prev chains, plus the
//! stream decoding they need (Flate with an optional PNG predictor).

use super::lexer::{Lexer, Obj, Parsed, Stop};
use super::{Doc, Entry, Source};

const TAIL: usize = 1024;
const MAX_SECTIONS: usize = 32;
const MAX_OBJECTS: u64 = 1 << 22;

type Table = (Vec<(u32, u64)>, Obj);

impl Doc {
    /// Reads each section from the newest back through /Prev; newer entries win.
    pub(super) fn load_xref(&mut self) -> Option<()> {
        let mut next = Some(self.startxref()?);
        let mut seen = Vec::new();
        while let Some(at) = next.filter(|at| !seen.contains(at) && seen.len() < MAX_SECTIONS) {
            seen.push(at);
            let trailer = self.section(at)?;
            if let Some(hybrid) = offset(trailer.get(b"XRefStm")) {
                self.section(hybrid)?;
            }
            if let (None, Some(Obj::Ref(root))) = (self.root, trailer.get(b"Root")) {
                self.root = Some(*root);
            }
            self.encrypted |= trailer.get(b"Encrypt").is_some();
            next = offset(trailer.get(b"Prev"));
        }
        self.root.map(drop)
    }

    fn startxref(&mut self) -> Option<u64> {
        let mut tail = self.src.read(self.src.len.saturating_sub(TAIL as u64), TAIL)?;
        tail.push(b'\n');
        let at = tail.windows(9).rposition(|w| w == b"startxref")?;
        Lexer::new(&tail, at + 9).uint().ok()
    }

    /// Adds the section at `at` to the table and returns its trailer.
    fn section(&mut self, at: u64) -> Option<Obj> {
        if let Some((entries, trailer)) = self.src.parse_at(at, table)? {
            for (num, at) in entries {
                self.xref.entry(num).or_insert(Entry::At(at));
            }
            return Some(trailer);
        }
        self.xref_stream(at)
    }

    fn xref_stream(&mut self, at: u64) -> Option<Obj> {
        let (dict, start) = self.object_at(at, None)?;
        if !dict.is_type(b"XRef") {
            return None;
        }
        let data = self.stream(&dict, start?, 0)?;
        let widths = dict.get(b"W")?.items()?.iter().map(|w| usize::try_from(w.int()?).ok().filter(|&w| w <= 8));
        let [kind, field, last] = widths.collect::<Option<Vec<_>>>()?[..] else { return None };
        let row = kind + field + last;
        if row == 0 {
            return None;
        }
        let ranges: Vec<i64> = match dict.get(b"Index") {
            Some(index) => index.items()?.iter().map(Obj::int).collect::<Option<_>>()?,
            None => vec![0, dict.get(b"Size")?.int()?],
        };
        let mut rows = data.chunks_exact(row);
        for pair in ranges.chunks_exact(2) {
            let (first, count) = (u32::try_from(pair[0]).ok()?, u32::try_from(pair[1]).ok()?);
            for (num, r) in (first..first.saturating_add(count)).zip(rows.by_ref()) {
                let entry = match if kind == 0 { 1 } else { be(&r[..kind]) } {
                    1 => Entry::At(be(&r[kind..kind + field])),
                    2 => Entry::Packed(u32::try_from(be(&r[kind..kind + field])).ok()?),
                    _ => continue,
                };
                self.xref.entry(num).or_insert(entry);
            }
        }
        Some(dict)
    }
}

fn offset(obj: Option<&Obj>) -> Option<u64> {
    u64::try_from(obj?.int()?).ok()
}

/// A classic table and its trailer, or None when the section at the start isn't one.
fn table(buf: &[u8]) -> Parsed<Option<Table>> {
    let mut lx = Lexer::new(buf, 0);
    lx.skip_space();
    if !buf[lx.pos..].starts_with(b"xref") {
        return Ok(None);
    }
    lx.pos += 4;
    let mut entries = Vec::new();
    loop {
        lx.skip_space();
        if buf[lx.pos..].starts_with(b"trailer") {
            lx.pos += 7;
            let trailer = lx.object(0)?;
            return if matches!(trailer, Obj::Dict(_)) { Ok(Some((entries, trailer))) } else { Err(Stop::Bad) };
        }
        let (first, count) = (lx.uint()?, lx.uint()?);
        if first.saturating_add(count) > MAX_OBJECTS {
            return Err(Stop::Bad);
        }
        for num in first..first + count {
            let (at, _generation) = (lx.uint()?, lx.uint()?);
            lx.skip_space();
            match buf.get(lx.pos).ok_or(Stop::Short)? {
                b'n' if at > 0 => entries.push((num as u32, at)),
                b'n' | b'f' => {}
                _ => return Err(Stop::Bad),
            }
            lx.pos += 1;
        }
    }
}

/// Undoes a stream's filter: none, or Flate with an optional PNG predictor.
pub(super) fn decode(src: &mut Source, dict: &Obj, raw: Vec<u8>) -> Option<Vec<u8>> {
    let filters = match dict.get(b"Filter") {
        None => &[][..],
        Some(Obj::Array(items)) => items,
        Some(one) => std::slice::from_ref(one),
    };
    let parms = match dict.get(b"DecodeParms") {
        Some(Obj::Array(items)) => items.first(),
        other => other,
    };
    match filters {
        [] => Some(raw),
        [flate] if flate.name() == Some(b"FlateDecode") => unpredict(src.inflate(&raw)?, parms),
        _ => None,
    }
}

/// Reverses PNG prediction (Predictor 10 to 15), which xref streams use row by row.
fn unpredict(data: Vec<u8>, parms: Option<&Obj>) -> Option<Vec<u8>> {
    let param = |key: &[u8], default: i64| parms.and_then(|p| p.get(key)).and_then(Obj::int).unwrap_or(default);
    match param(b"Predictor", 1) {
        1 => return Some(data),
        10..=15 => {}
        _ => return None,
    }
    let bits = param(b"Colors", 1).checked_mul(param(b"BitsPerComponent", 8))?;
    let row_bits = bits.checked_mul(param(b"Columns", 1))?;
    let bpp = usize::try_from(bits.checked_add(7)? / 8).ok()?.max(1);
    let row = usize::try_from(row_bits.checked_add(7)? / 8).ok().filter(|&r| r > 0 && r <= 1 << 20)?;
    let mut out = Vec::with_capacity(data.len());
    let mut prev = vec![0u8; row];
    for line in data.chunks_exact(row + 1) {
        let mut cur = line[1..].to_vec();
        for i in 0..row {
            let (left, up_left) = if i >= bpp { (cur[i - bpp], prev[i - bpp]) } else { (0, 0) };
            let up = prev[i];
            cur[i] = cur[i].wrapping_add(match line[0] {
                0 => 0,
                1 => left,
                2 => up,
                3 => ((u16::from(left) + u16::from(up)) / 2) as u8,
                4 => paeth(left, up, up_left),
                _ => return None,
            });
        }
        out.extend_from_slice(&cur);
        prev = cur;
    }
    Some(out)
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = i16::from(a) + i16::from(b) - i16::from(c);
    let (pa, pb, pc) = ((p - i16::from(a)).abs(), (p - i16::from(b)).abs(), (p - i16::from(c)).abs());
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

fn be(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0, |n, &b| (n << 8) | u64::from(b))
}
