//! Minimal PDF 1.4 writer: numbered objects, Flate streams, one cross-reference table.

use crate::error::Result;
use std::io::Write;

pub(crate) struct PdfWriter<W: Write> {
    out: W,
    pos: u64,
    /// Byte offset of each object, indexed by object number (0 is the free head).
    offsets: Vec<u64>,
}

impl<W: Write> PdfWriter<W> {
    pub fn new(out: W) -> Result<PdfWriter<W>> {
        let mut writer = PdfWriter { out, pos: 0, offsets: vec![0] };
        writer.put(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")?;
        Ok(writer)
    }

    fn put(&mut self, bytes: &[u8]) -> Result<()> {
        self.out.write_all(bytes)?;
        self.pos += bytes.len() as u64;
        Ok(())
    }

    /// Reserves the next object number.
    pub fn reserve(&mut self) -> usize {
        self.offsets.push(0);
        self.offsets.len() - 1
    }

    pub fn object(&mut self, id: usize, body: &str) -> Result<()> {
        if let Some(slot) = self.offsets.get_mut(id) {
            *slot = self.pos;
        }
        self.put(format!("{id} 0 obj\n{body}\nendobj\n").as_bytes())
    }

    pub fn flate_stream(&mut self, id: usize, data: &[u8]) -> Result<()> {
        let packed = miniz_oxide::deflate::compress_to_vec_zlib(data, 6);
        if let Some(slot) = self.offsets.get_mut(id) {
            *slot = self.pos;
        }
        self.put(format!("{id} 0 obj\n<< /Length {} /Filter /FlateDecode >>\nstream\n", packed.len()).as_bytes())?;
        self.put(&packed)?;
        self.put(b"\nendstream\nendobj\n")
    }

    pub fn finish(mut self, root: usize) -> Result<W> {
        let xref = self.pos;
        let mut table = format!("xref\n0 {}\n0000000000 65535 f \n", self.offsets.len());
        for offset in &self.offsets[1..] {
            table.push_str(&format!("{offset:010} 00000 n \n"));
        }
        table.push_str(&format!(
            "trailer\n<< /Size {} /Root {root} 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            self.offsets.len()
        ));
        self.put(table.as_bytes())?;
        self.out.flush()?;
        Ok(self.out)
    }
}
