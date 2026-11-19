//! Reference decoders for the encoders' output (PWG, URF, PCL, PostScript). Pure std, so the
//! hardware test can include this file as well.

/// One decoded page: 8-bit gray (channels 1, 0 = black) or RGB (channels 3).
#[derive(Clone, Debug, PartialEq)]
pub struct Page {
    pub width: usize,
    pub height: usize,
    pub channels: usize,
    pub dpi: u32,
    pub data: Vec<u8>,
}

pub fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(b[at..at + 4].try_into().expect("4 bytes"))
}

pub fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    hay.get(from..)?.windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

/// TIFF PackBits / PostScript RunLength: n < 128 copies n+1 bytes, n > 128 repeats one byte 257-n times.
pub fn unpackbits(src: &[u8]) -> Vec<u8> {
    let (mut out, mut i) = (Vec::new(), 0);
    while i < src.len() {
        let n = usize::from(src[i]);
        i += 1;
        match n {
            0..=127 => {
                out.extend_from_slice(&src[i..i + n + 1]);
                i += n + 1;
            }
            128 => break,
            _ => {
                out.extend(std::iter::repeat_n(src[i], 257 - n));
                i += 1;
            }
        }
    }
    out
}

/// PCL delta row (method 3): replaces bytes of `seed` in place.
pub fn undelta(src: &[u8], seed: &mut [u8]) {
    let (mut i, mut pos) = (0, 0);
    while i < src.len() {
        let command = src[i];
        i += 1;
        let count = usize::from(command >> 5) + 1;
        let mut offset = usize::from(command & 31);
        if offset == 31 {
            loop {
                let more = src[i];
                i += 1;
                offset += usize::from(more);
                if more != 255 {
                    break;
                }
            }
        }
        pos += offset;
        seed[pos..pos + count].copy_from_slice(&src[i..i + count]);
        i += count;
        pos += count;
    }
}

/// PWG/URF lines: a repeat byte, then runs of `unit`-byte pixels; 0x80 fills the rest with `white`.
fn raster_lines(src: &[u8], pos: &mut usize, rows: usize, len: usize, unit: usize, white: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(rows * len);
    while out.len() < rows * len {
        let repeat = usize::from(src[*pos]) + 1;
        *pos += 1;
        let mut line = Vec::with_capacity(len);
        while line.len() < len {
            let code = src[*pos];
            *pos += 1;
            match code {
                0x80 => line.resize(len, white),
                0..=0x7F => {
                    let px = &src[*pos..*pos + unit];
                    (0..=usize::from(code)).for_each(|_| line.extend_from_slice(px));
                    *pos += unit;
                }
                _ => {
                    let n = (257 - usize::from(code)) * unit;
                    line.extend_from_slice(&src[*pos..*pos + n]);
                    *pos += n;
                }
            }
        }
        assert_eq!(line.len(), len, "line overran its width");
        (0..repeat).for_each(|_| out.extend_from_slice(&line));
    }
    assert_eq!(out.len(), rows * len, "repeat count ran past the page");
    out
}

/// 1-bit rows (MSB first, 1 = black) as 8-bit gray.
pub fn expand_bits(bits: &[u8], width: usize, row_bytes: usize) -> Vec<u8> {
    bits.chunks(row_bytes).flat_map(|row| (0..width).map(move |x| if row[x / 8] >> (7 - x % 8) & 1 == 1 { 0 } else { 255 })).collect()
}

/// PWG Raster pages with their 1796-byte headers.
pub fn pwg(bytes: &[u8]) -> Vec<(Page, Vec<u8>)> {
    assert_eq!(&bytes[..4], b"RaS2", "PWG sync word");
    let (mut pos, mut pages) = (4, Vec::new());
    while pos < bytes.len() {
        let header = bytes[pos..pos + 1796].to_vec();
        pos += 1796;
        let (width, height) = (be32(&header, 372) as usize, be32(&header, 376) as usize);
        let (bpp, line, space) = (be32(&header, 388), be32(&header, 392) as usize, be32(&header, 400));
        let unit = (bpp as usize / 8).max(1);
        let white = if space == 3 { 0 } else { 0xFF };
        let raw = raster_lines(bytes, &mut pos, height, line, unit, white);
        let (channels, data) = match (bpp, space) {
            (1, _) => (1, expand_bits(&raw, width, line)),
            (8, 3) => (1, raw.iter().map(|v| 255 - v).collect()),
            (24, _) => (3, raw),
            _ => (1, raw),
        };
        pages.push((Page { width, height, channels, dpi: be32(&header, 276), data }, header));
    }
    pages
}

/// URF page count from the file header, and pages with their 32-byte headers.
pub fn urf(bytes: &[u8]) -> (u32, Vec<(Page, Vec<u8>)>) {
    assert_eq!(&bytes[..8], b"UNIRAST\0", "URF magic");
    let (count, mut pos, mut pages) = (be32(bytes, 8), 12, Vec::new());
    while pos < bytes.len() {
        let header = bytes[pos..pos + 32].to_vec();
        pos += 32;
        let unit = usize::from(header[0]) / 8;
        let (width, height) = (be32(&header, 12) as usize, be32(&header, 16) as usize);
        let data = raster_lines(bytes, &mut pos, height, width * unit, unit, 0xFF);
        pages.push((Page { width, height, channels: unit, dpi: be32(&header, 20), data }, header));
    }
    (count, pages)
}

#[derive(Default)]
struct PclState {
    width: usize,
    height: usize,
    dpi: u32,
    method: u32,
    color: bool,
    seed: Vec<u8>,
    rows: Vec<Vec<u8>>,
}

impl PclState {
    fn page(&mut self) -> Page {
        let rows = std::mem::take(&mut self.rows);
        let height = rows.len();
        let data = if self.color {
            rows.concat()
        } else {
            let row_bytes = self.width.div_ceil(8);
            let bits: Vec<u8> = rows.iter().flat_map(|r| (0..row_bytes).map(|i| r.get(i).copied().unwrap_or(0))).collect();
            expand_bits(&bits, self.width, row_bytes)
        };
        Page { width: self.width, height, channels: if self.color { 3 } else { 1 }, dpi: self.dpi, data }
    }
}

/// PCL 5 raster pages; any PJL wrapper is skipped and decoding stops at the closing UEL.
pub fn pcl(bytes: &[u8]) -> Vec<Page> {
    let mut pos = find(bytes, b"ENTER LANGUAGE=PCL\r\n", 0).map_or(0, |p| p + 20);
    let (mut s, mut pages) = (PclState::default(), Vec::new());
    while pos < bytes.len() {
        match bytes[pos] {
            0x0C => {
                pages.push(s.page());
                pos += 1;
            }
            0x1B if bytes[pos + 1] == b'E' => pos += 2,
            0x1B if bytes[pos + 1] == b'%' => break,
            0x1B => {
                let group = bytes[pos + 2];
                pos += 3;
                loop {
                    let start = pos;
                    while bytes[pos].is_ascii_digit() || bytes[pos] == b'-' || bytes[pos] == b'.' {
                        pos += 1;
                    }
                    let value: i64 = std::str::from_utf8(&bytes[start..pos]).expect("ascii").parse().unwrap_or(0);
                    let term = bytes[pos];
                    pos += 1;
                    let n = value.max(0) as usize;
                    match (group, term.to_ascii_uppercase()) {
                        (b'r', b'S') => s.width = n,
                        (b'r', b'T') => s.height = n,
                        (b't', b'R') => s.dpi = n as u32,
                        (b'b', b'M') => s.method = n as u32,
                        (b'r', b'A') => s.seed = vec![0; s.width * 3],
                        (b'v', b'W') => {
                            s.color = true;
                            pos += n;
                        }
                        (b'b', b'W') => {
                            let data = &bytes[pos..pos + n];
                            pos += n;
                            let row = match s.method {
                                2 => unpackbits(data),
                                3 => {
                                    undelta(data, &mut s.seed);
                                    s.seed.clone()
                                }
                                _ => data.to_vec(),
                            };
                            s.rows.push(row);
                        }
                        _ => {}
                    }
                    if term.is_ascii_uppercase() {
                        break;
                    }
                }
            }
            _ => pos += 1,
        }
    }
    assert!(pages.iter().all(|p| p.height == s.height || s.height == 0), "rows match ESC*r#T");
    pages
}

/// ASCII85 with `z` groups, whitespace, and the `~>` end marker.
pub fn ascii85(text: &[u8]) -> Vec<u8> {
    let (mut out, mut group) = (Vec::new(), Vec::new());
    for &c in text.iter().take_while(|&&c| c != b'~').filter(|c| !c.is_ascii_whitespace()) {
        if c == b'z' && group.is_empty() {
            out.extend_from_slice(&[0; 4]);
            continue;
        }
        group.push(u64::from(c - b'!'));
        if group.len() == 5 {
            out.extend_from_slice(&value85(&group).to_be_bytes());
            group.clear();
        }
    }
    if !group.is_empty() {
        let n = group.len();
        group.resize(5, 84);
        out.extend_from_slice(&value85(&group).to_be_bytes()[..n - 1]);
    }
    out
}

fn value85(digits: &[u64]) -> u32 {
    digits.iter().fold(0u64, |v, d| v * 85 + d) as u32
}

/// Image pages of the PostScript the encoder writes.
pub fn ps(bytes: &[u8]) -> Vec<Page> {
    let number = |key: &[u8], from: usize| -> usize {
        let at = find(bytes, key, from).expect("image key") + key.len();
        let end = at + bytes[at..].iter().position(|c| !c.is_ascii_digit()).expect("digits");
        std::str::from_utf8(&bytes[at..end]).expect("ascii").parse().expect("number")
    };
    let (mut pages, mut pos) = (Vec::new(), 0);
    while let Some(page) = find(bytes, b"%%Page: ", pos) {
        let (width, height) = (number(b"/Width ", page), number(b"/Height ", page));
        let channels = if find(bytes, b"/Decode [0 1 0 1 0 1]", page).is_some_and(|d| d < find(bytes, b"exec\n", page).unwrap_or(0)) { 3 } else { 1 };
        let start = find(bytes, b"} exec\n", page).expect("image procedure") + 7;
        let end = find(bytes, b"~>", start).expect("ASCII85 end");
        let data = unpackbits(&ascii85(&bytes[start..end + 2]));
        assert_eq!(data.len(), width * height * channels, "image data size");
        pages.push(Page { width, height, channels, dpi: 0, data });
        pos = end;
    }
    pages
}
