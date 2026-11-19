//! PWG 5101.1 self-describing media names ("na_letter_8.5x11in") <-> media-col sizes, which
//! IPP expresses in hundredths of a millimeter.

use crate::ipp::value::find;
use crate::ipp::{Attribute, Value};

/// Unprintable border assumed for every size; the backing printer's real margins are unknown.
const MARGIN: i32 = 423;
const TOLERANCE: u32 = 100;

/// (width, height) of a self-describing media name.
pub(crate) fn dimensions(name: &str) -> Option<(i32, i32)> {
    let dims = name.rsplit('_').next()?;
    let (dims, scale) = match dims.strip_suffix("mm") {
        Some(d) => (d, 100.0),
        None => (dims.strip_suffix("in")?, 2540.0),
    };
    let (w, h) = dims.split_once('x')?;
    let (w, h): (f64, f64) = (w.parse().ok()?, h.parse().ok()?);
    let sane = |v: f64| v > 0.0 && v * scale < 1.0e7;
    (sane(w) && sane(h)).then(|| ((w * scale).round() as i32, (h * scale).round() as i32))
}

pub(crate) fn size(x: i32, y: i32) -> Value {
    Value::Collection(vec![Attribute::new("x-dimension", Value::Integer(x)), Attribute::new("y-dimension", Value::Integer(y))])
}

/// media-col for a named size, or None when the name carries no dimensions.
pub(super) fn col(name: &str, source: &str, media_type: &str) -> Option<Value> {
    let (x, y) = dimensions(name)?;
    let margin = |side: &str| Attribute::new(&format!("media-{side}-margin"), Value::Integer(MARGIN));
    Some(Value::Collection(vec![
        Attribute::new("media-size", size(x, y)),
        margin("bottom"),
        margin("left"),
        margin("right"),
        margin("top"),
        Attribute::new("media-source", Value::keyword(source)),
        Attribute::new("media-type", Value::keyword(media_type)),
    ]))
}

pub(super) fn margins() -> Vec<Attribute> {
    ["bottom", "left", "right", "top"]
        .iter()
        .map(|side| Attribute::new(&format!("media-{side}-margin-supported"), Value::Integer(MARGIN)))
        .collect()
}

/// The offered media name matching a requested media-col (by name, else size within 1 mm).
pub(super) fn from_col(col: &Attribute, media: &[String]) -> Option<String> {
    let members = col.values.first()?.as_collection()?;
    if let Some(name) = find(members, "media-size-name").and_then(Attribute::str)
        && media.iter().any(|m| m == name)
    {
        return Some(name.to_string());
    }
    let size = find(members, "media-size")?.values.first()?.as_collection()?;
    let x = find(size, "x-dimension")?.int()?;
    let y = find(size, "y-dimension")?.int()?;
    let close = |(mx, my): (i32, i32)| mx.abs_diff(x) <= TOLERANCE && my.abs_diff(y) <= TOLERANCE;
    media.iter().find(|m| dimensions(m).is_some_and(close)).cloned()
}
