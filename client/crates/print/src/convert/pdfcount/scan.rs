//! Last resort when the cross-reference data is unusable: read every object in a small file and
//! find the page tree root, as long as there is exactly one.

use super::Source;
use super::lexer::{Lexer, Obj, is_space};

const SCAN_LIMIT: u64 = 8 << 20;

/// /Count of the only /Type /Pages object without a /Parent, the newest copy of it winning.
pub(super) fn page_tree_root(src: &mut Source) -> Option<i64> {
    if src.len > SCAN_LIMIT {
        return None;
    }
    let buf = src.read(0, usize::try_from(src.len).ok()?)?;
    let mut roots: Vec<(u32, i64)> = Vec::new();
    let mut from = 0;
    while let Some(found) = buf[from..].windows(3).position(|w| w == b"obj") {
        let at = from + found;
        from = at + 3;
        if src.out_of_time() {
            return None;
        }
        let Some(start) = object_start(&buf, at) else { continue };
        let mut lx = Lexer::new(&buf, start);
        let Ok(num) = lx.header() else { continue };
        let Ok(obj) = lx.object(0) else { continue };
        if obj.is_type(b"Pages")
            && obj.get(b"Parent").is_none()
            && let Some(count) = obj.get(b"Count").and_then(Obj::int)
        {
            roots.retain(|(n, _)| *n != num);
            roots.push((num, count));
        }
    }
    match roots[..] {
        [(_, count)] => Some(count),
        _ => None,
    }
}

/// Where "N G obj" begins, given where "obj" is; None when no two numbers precede it.
fn object_start(buf: &[u8], at: usize) -> Option<usize> {
    let mut i = at;
    for _ in 0..2 {
        while i > 0 && is_space(buf[i - 1]) {
            i -= 1;
        }
        let end = i;
        while i > 0 && buf[i - 1].is_ascii_digit() {
            i -= 1;
        }
        if i == end {
            return None;
        }
    }
    Some(i)
}
