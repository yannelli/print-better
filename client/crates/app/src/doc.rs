//! Working out what kind of document a file is.

use pb_print::DocFormat;
use std::io::Read;
use std::path::Path;

/// The declared MIME type when it is one we know, else magic bytes, else "looks like text".
pub fn detect(path: &Path, declared: Option<&str>) -> DocFormat {
    if let Some(known) = declared.map(DocFormat::from_mime).filter(|f| *f != DocFormat::Unknown) {
        return known;
    }
    let mut head = [0u8; 512];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
    let head = &head[..n];
    match DocFormat::sniff(head) {
        DocFormat::Unknown if looks_like_text(head) => DocFormat::Text,
        format => format,
    }
}

fn looks_like_text(head: &[u8]) -> bool {
    // A multi-byte character may be cut off at the end of the sample; that still counts.
    let utf8 = match std::str::from_utf8(head) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none(),
    };
    !head.is_empty() && utf8 && !head.contains(&0)
}

pub fn mime_for_extension(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "pdf" => "application/pdf",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "txt" | "text" | "log" | "md" | "csv" => "text/plain",
        _ => return None,
    })
}
