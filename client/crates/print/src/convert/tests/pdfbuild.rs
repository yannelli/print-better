//! Builds small synthetic PDFs for the page counter tests: plain objects, object streams, classic
//! tables and xref streams, written by hand so each cross-reference style is exact.

use miniz_oxide::deflate::compress_to_vec_zlib;
use std::collections::BTreeMap;

pub(crate) struct Pdf {
    pub out: Vec<u8>,
    /// Object number to (offset, or object stream and index).
    pub entries: BTreeMap<u32, Where>,
}

#[derive(Clone, Copy)]
pub(crate) enum Where {
    At(usize),
    Packed(u32, u32),
}

impl Pdf {
    pub fn new(version: &str) -> Pdf {
        let mut out = format!("%PDF-{version}\n").into_bytes();
        out.extend_from_slice(b"%\xE2\xE3\xCF\xD3\n");
        Pdf { out, entries: BTreeMap::new() }
    }

    pub fn obj(&mut self, num: u32, body: &str) -> &mut Pdf {
        self.entries.insert(num, Where::At(self.out.len()));
        self.out.extend_from_slice(format!("{num} 0 obj\n{body}\nendobj\n").as_bytes());
        self
    }

    pub fn stream(&mut self, num: u32, dict: &str, data: &[u8]) -> &mut Pdf {
        self.entries.insert(num, Where::At(self.out.len()));
        self.out.extend_from_slice(format!("{num} 0 obj\n<< {dict} /Length {} >>\nstream\n", data.len()).as_bytes());
        self.out.extend_from_slice(data);
        self.out.extend_from_slice(b"\nendstream\nendobj\n");
        self
    }

    /// An object stream holding `objects`, Flate-compressed.
    pub fn object_stream(&mut self, num: u32, objects: &[(u32, &str)]) -> &mut Pdf {
        let (mut header, mut body) = (String::new(), String::new());
        for (index, (n, text)) in objects.iter().enumerate() {
            header.push_str(&format!("{n} {} ", body.len()));
            body.push_str(text);
            body.push('\n');
            self.entries.insert(*n, Where::Packed(num, index as u32));
        }
        let dict = format!("/Type /ObjStm /N {} /First {} /Filter /FlateDecode", objects.len(), header.len());
        self.stream(num, &dict, &compress_to_vec_zlib(format!("{header}{body}").as_bytes(), 6))
    }

    /// A classic table for `nums` and its trailer; returns where the table starts.
    pub fn table(&mut self, nums: &[u32], trailer: &str) -> usize {
        let at = self.out.len();
        let mut text = String::from("xref\n");
        for num in nums {
            let Some(Where::At(offset)) = self.entries.get(num) else { panic!("object {num} has no offset") };
            text.push_str(&format!("{num} 1\n{offset:010} 00000 n \n"));
        }
        text.push_str(&format!("trailer\n<< {trailer} >>\n"));
        self.out.extend_from_slice(text.as_bytes());
        at
    }

    /// An xref stream object `num` covering every object so far, rows W [1 4 2], optionally
    /// with the PNG Up predictor; returns where it starts.
    pub fn xref_stream(&mut self, num: u32, dict: &str, predicted: bool) -> usize {
        let at = self.out.len();
        self.entries.insert(num, Where::At(at));
        let size = self.entries.keys().max().map_or(1, |n| n + 1);
        let mut rows: Vec<[u8; 7]> = Vec::new();
        for n in 0..size {
            let (kind, field, index) = match self.entries.get(&n) {
                Some(Where::At(offset)) => (1u8, *offset as u32, 0u16),
                Some(Where::Packed(stream, index)) => (2, *stream, *index as u16),
                None => (0, 0, 0),
            };
            let mut row = [kind, 0, 0, 0, 0, 0, 0];
            row[1..5].copy_from_slice(&field.to_be_bytes());
            row[5..].copy_from_slice(&index.to_be_bytes());
            rows.push(row);
        }
        let mut data = Vec::new();
        let mut prev = [0u8; 7];
        for row in &rows {
            if predicted {
                data.push(2);
                data.extend(row.iter().zip(prev).map(|(b, p)| b.wrapping_sub(p)));
                prev = *row;
            } else {
                data.extend_from_slice(row);
            }
        }
        let parms = if predicted { " /DecodeParms << /Columns 7 /Predictor 12 >>" } else { "" };
        let dict = format!("/Type /XRef /Size {size} /W [1 4 2] /Filter /FlateDecode{parms} {dict}");
        self.stream(num, &dict, &compress_to_vec_zlib(&data, 6));
        at
    }

    pub fn startxref(&mut self, at: usize) -> Vec<u8> {
        self.out.extend_from_slice(format!("startxref\n{at}\n%%EOF\n").as_bytes());
        self.out.clone()
    }
}

/// Catalog 1 and page tree 2 with `count` pages (kids are never read).
pub(crate) fn tree(pdf: &mut Pdf, count: u32) -> &mut Pdf {
    pdf.obj(1, "<< /Type /Catalog /Pages 2 0 R >>")
        .obj(2, &format!("<< /Type /Pages /Kids [3 0 R] /Count {count} >>"))
        .obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>")
}

/// A complete file with a classic table.
pub(crate) fn classic(count: u32) -> Vec<u8> {
    let mut pdf = Pdf::new("1.4");
    tree(&mut pdf, count);
    let at = pdf.table(&[1, 2, 3], "/Size 4 /Root 1 0 R");
    pdf.startxref(at)
}
