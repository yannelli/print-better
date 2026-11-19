//! Plain text laid out as a PDF: Courier 10 pt, word wrap, form feeds, page selection.

use super::media::Media;
use super::pages::PageSet;
use super::pdfwrite::PdfWriter;
use crate::error::{Error, Result};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

const FONT_SIZE: f64 = 10.0;
const LEADING: f64 = 12.0;
const CHAR_WIDTH: f64 = 6.0;
const MARGIN: f64 = 36.0;
const TAB: usize = 8;
const MAX_FILE: u64 = 32 * 1024 * 1024;
const MAX_PAGES: u32 = 5000;

/// Windows-1252 code points for bytes 0x80..=0x9F (0 = unassigned); PDF's WinAnsiEncoding matches.
const CP1252: [u16; 32] = [
    0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017D, 0,
    0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178,
];

fn decode(bytes: &[u8]) -> String {
    let utf16 = |be: bool| {
        let units = bytes[2..].chunks_exact(2).map(|c| if be { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) });
        char::decode_utf16(units).map(|c| c.unwrap_or('?')).collect()
    };
    match bytes {
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        [0xFF, 0xFE, ..] => utf16(false),
        [0xFE, 0xFF, ..] => utf16(true),
        _ => match std::str::from_utf8(bytes) {
            Ok(s) => s.to_string(),
            Err(_) => bytes.iter().map(|&b| cp1252_char(b)).collect(),
        },
    }
}

fn cp1252_char(b: u8) -> char {
    match b {
        0x80..=0x9F => char::from_u32(u32::from(CP1252[usize::from(b - 0x80)])).filter(|c| *c != '\0').unwrap_or('?'),
        _ => char::from(b),
    }
}

/// One character as a WinAnsi byte, escaped for a PDF literal string.
fn encode(c: char, out: &mut Vec<u8>) {
    let byte = match c {
        '(' | ')' | '\\' => {
            out.extend_from_slice(&[b'\\', c as u8]);
            return;
        }
        ' '..='~' => c as u8,
        '\u{A0}'..='\u{FF}' => c as u32 as u8,
        _ if c.is_control() => b' ',
        _ => CP1252.iter().position(|&u| u32::from(u) == c as u32 && u != 0).map_or(b'?', |i| 0x80 + i as u8),
    };
    if byte < 0x80 {
        out.push(byte);
    } else {
        out.extend_from_slice(format!("\\{byte:03o}").as_bytes());
    }
}

struct Layout<'a> {
    pdf: PdfWriter<BufWriter<File>>,
    tree: usize,
    font: usize,
    size: (f64, f64),
    columns: usize,
    rows: usize,
    select: Option<&'a PageSet>,
    lines: Vec<Vec<char>>,
    number: u32,
    kids: Vec<usize>,
}

impl Layout<'_> {
    fn line(&mut self, text: &str) -> Result<()> {
        let mut chars: Vec<char> = Vec::new();
        for c in text.chars().filter(|&c| c != '\r') {
            if c == '\t' {
                chars.extend(std::iter::repeat_n(' ', TAB - chars.len() % TAB));
            } else {
                chars.push(c);
            }
        }
        let mut rest: &[char] = &chars;
        loop {
            if rest.len() <= self.columns {
                return self.push(rest.to_vec());
            }
            let cut = rest[..=self.columns].iter().rposition(|&c| c == ' ').filter(|&p| p > 0);
            let (head, tail) = match cut {
                Some(p) => (&rest[..p], &rest[p + 1..]),
                None => (&rest[..self.columns], &rest[self.columns..]),
            };
            self.push(head.to_vec())?;
            rest = tail;
        }
    }

    fn push(&mut self, line: Vec<char>) -> Result<()> {
        if self.lines.len() == self.rows {
            self.page()?;
        }
        self.lines.push(line);
        Ok(())
    }

    fn page(&mut self) -> Result<()> {
        self.number += 1;
        if self.number > MAX_PAGES {
            return Err(Error::Unsupported("This text file is too long to print.".into()));
        }
        let lines = std::mem::take(&mut self.lines);
        if self.select.is_some_and(|s| !s.contains(self.number)) {
            return Ok(());
        }
        let (w, h) = self.size;
        let mut content = format!("BT\n/F1 {FONT_SIZE} Tf\n{LEADING} TL\n{MARGIN} {:.2} Td\n", h - MARGIN - FONT_SIZE).into_bytes();
        for line in lines {
            content.push(b'(');
            line.into_iter().for_each(|c| encode(c, &mut content));
            content.extend_from_slice(b") Tj T*\n");
        }
        content.extend_from_slice(b"ET\n");
        let (page, stream) = (self.pdf.reserve(), self.pdf.reserve());
        self.pdf.flate_stream(stream, &content)?;
        let body = format!(
            "<< /Type /Page /Parent {} 0 R /MediaBox [0 0 {w:.2} {h:.2}] /Resources << /Font << /F1 {} 0 R >> >> /Contents {stream} 0 R >>",
            self.tree, self.font
        );
        self.pdf.object(page, &body)?;
        self.kids.push(page);
        Ok(())
    }
}

/// Writes `src` as a PDF into `out`; returns the number of pages written.
pub(crate) fn to_pdf(src: &Path, out: File, media: &Media, landscape: bool, select: Option<&PageSet>) -> Result<u32> {
    if std::fs::metadata(src)?.len() > MAX_FILE {
        return Err(Error::Unsupported("This text file is too long to print.".into()));
    }
    let text = decode(&std::fs::read(src)?);
    let text = text.strip_suffix('\n').unwrap_or(&text);
    let size = if landscape { (media.height, media.width) } else { (media.width, media.height) };
    let mut pdf = PdfWriter::new(BufWriter::new(out))?;
    let (catalog, tree, font) = (pdf.reserve(), pdf.reserve(), pdf.reserve());
    pdf.object(font, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>")?;
    let mut layout = Layout {
        pdf,
        tree,
        font,
        size,
        columns: ((size.0 - 2.0 * MARGIN) / CHAR_WIDTH).max(10.0) as usize,
        rows: ((size.1 - 2.0 * MARGIN) / LEADING).max(5.0) as usize,
        select,
        lines: Vec::new(),
        number: 0,
        kids: Vec::new(),
    };
    for line in text.split('\n') {
        let parts: Vec<&str> = line.split('\x0c').collect();
        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                layout.page()?;
            }
            if !part.is_empty() || parts.len() == 1 {
                layout.line(part)?;
            }
        }
    }
    if !layout.lines.is_empty() || layout.number == 0 {
        layout.page()?;
    }
    if layout.kids.is_empty() {
        return Err(Error::Unsupported("None of the selected pages are in this document.".into()));
    }
    let kids: Vec<String> = layout.kids.iter().map(|k| format!("{k} 0 R")).collect();
    let mut pdf = layout.pdf;
    pdf.object(tree, &format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), kids.len()))?;
    pdf.object(catalog, &format!("<< /Type /Catalog /Pages {tree} 0 R >>"))?;
    pdf.finish(catalog)?.flush()?;
    Ok(kids.len() as u32)
}
