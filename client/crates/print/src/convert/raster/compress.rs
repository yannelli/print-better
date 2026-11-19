//! Run-length schemes used by the raster encoders, plus pixel helpers they share.

/// PWG Raster / URF line body: runs over whole pixels of `bpp` bytes (PWG 5102.4).
/// `n-1` + pixel repeats it n times (1..=128); `257-n` + n pixels are literals (2..=128).
pub(crate) fn pack_pixels(line: &[u8], bpp: usize, out: &mut Vec<u8>) {
    let count = line.len() / bpp;
    let px = |i: usize| &line[i * bpp..(i + 1) * bpp];
    let mut i = 0;
    while i < count {
        let mut run = 1;
        while i + run < count && run < 128 && px(i + run) == px(i) {
            run += 1;
        }
        if run > 1 {
            out.push((run - 1) as u8);
            out.extend_from_slice(px(i));
            i += run;
            continue;
        }
        let mut len = 1;
        while i + len < count && len < 128 && !(i + len + 1 < count && px(i + len) == px(i + len + 1)) {
            len += 1;
        }
        if len == 1 {
            out.push(0);
        } else {
            out.push((257 - len) as u8);
        }
        out.extend_from_slice(&line[i * bpp..(i + len) * bpp]);
        i += len;
    }
}

/// TIFF PackBits over bytes: `n-1` + n literals (n <= 128), `257-n` + byte repeats it n times.
/// Used by PCL compression method 2 and PostScript RunLengthDecode.
pub(crate) fn packbits(data: &[u8], out: &mut Vec<u8>) {
    let mut i = 0;
    while i < data.len() {
        let mut run = 1;
        while i + run < data.len() && run < 128 && data[i + run] == data[i] {
            run += 1;
        }
        if run > 1 {
            out.push((257 - run) as u8);
            out.push(data[i]);
            i += run;
            continue;
        }
        let mut len = 1;
        while i + len < data.len() && len < 128 && !(i + len + 1 < data.len() && data[i + len] == data[i + len + 1]) {
            len += 1;
        }
        out.push((len - 1) as u8);
        out.extend_from_slice(&data[i..i + len]);
        i += len;
    }
}

/// PCL delta row (compression method 3): the bytes of `row` that differ from `seed`, in runs
/// of up to 8 with relative offsets. `seed` becomes `row`; an empty result repeats the seed.
pub(crate) fn delta_row(row: &[u8], seed: &mut [u8], out: &mut Vec<u8>) {
    let mut i = 0;
    let mut after_last = 0;
    while i < row.len() {
        if row[i] == seed[i] {
            i += 1;
            continue;
        }
        let start = i;
        while i < row.len() && i - start < 8 && row[i] != seed[i] {
            seed[i] = row[i];
            i += 1;
        }
        let command = ((i - start - 1) as u8) << 5;
        let mut offset = start - after_last;
        out.push(command | offset.min(31) as u8);
        if offset >= 31 {
            offset -= 31;
            while offset >= 255 {
                out.push(255);
                offset -= 255;
            }
            out.push(offset as u8);
        }
        out.extend_from_slice(&row[start..i]);
        after_last = i;
    }
}

/// Streaming ASCII85 encoder (PLRM 3.13.3) with line breaks; `finish` writes the `~>` marker.
pub(crate) struct Ascii85 {
    group: [u8; 4],
    filled: usize,
    column: usize,
    pub text: Vec<u8>,
}

impl Ascii85 {
    pub fn new() -> Ascii85 {
        Ascii85 { group: [0; 4], filled: 0, column: 0, text: Vec::new() }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.group[self.filled] = b;
            self.filled += 1;
            if self.filled == 4 {
                self.emit_group(4);
            }
        }
    }

    pub fn finish(&mut self) {
        if self.filled > 0 {
            let n = self.filled;
            self.group[n..].fill(0);
            self.emit_group(n);
        }
        self.text.extend_from_slice(b"~>\n");
        self.column = 0;
    }

    fn emit_group(&mut self, len: usize) {
        let value = u32::from_be_bytes(self.group);
        self.filled = 0;
        if len == 4 && value == 0 {
            self.put(b'z');
            return;
        }
        let mut digits = [0u8; 5];
        let mut v = value;
        for d in digits.iter_mut().rev() {
            *d = (v % 85) as u8 + b'!';
            v /= 85;
        }
        for &d in &digits[..len + 1] {
            self.put(d);
        }
    }

    fn put(&mut self, c: u8) {
        // DSC readers treat lines starting with '%' as comments, so never start a line with one.
        if self.column == 0 && c == b'%' {
            self.text.push(b' ');
        }
        self.text.push(c);
        self.column += 1;
        if self.column == 75 {
            self.text.push(b'\n');
            self.column = 0;
        }
    }
}

const BAYER: [[u8; 8]; 8] = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
];

/// Gray levels at or below this print solid black, so dark-gray text isn't stippled.
const BLACK_POINT: u32 = 56;
/// Gray levels at or above this print as paper, so near-white backgrounds don't speckle.
const WHITE_POINT: u32 = 240;

/// Ordered-dithers 8-bit gray (0 = black) into 1-bit, MSB first, 1 = black.
pub(crate) fn dither_row(gray: &[u8], y: u32, out: &mut Vec<u8>) {
    out.clear();
    out.resize(gray.len().div_ceil(8), 0);
    let row = &BAYER[(y % 8) as usize];
    for (x, &g) in gray.iter().enumerate() {
        let level = u32::from(g).clamp(BLACK_POINT, WHITE_POINT) - BLACK_POINT;
        let g = level * 255 / (WHITE_POINT - BLACK_POINT);
        let threshold = (u32::from(row[x % 8]) * 2 + 1) * 255 / 128;
        if g < threshold {
            out[x / 8] |= 0x80 >> (x % 8);
        }
    }
}

pub(crate) fn luma(r: u8, g: u8, b: u8) -> u8 {
    ((u32::from(r) * 77 + u32::from(g) * 150 + u32::from(b) * 29) >> 8) as u8
}
