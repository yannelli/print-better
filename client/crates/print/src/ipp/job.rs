//! Job Template attributes <-> JobOptions (RFC 8011 5.2, PWG 5100.13), and job-state parsing.

use super::client::{IppJobState, JobStateKind};
use super::printer::{copies_max, page_ranges_supported};
use super::tags::job_state as js;
use super::value::{Attribute, Group, Value, find};
use crate::model::{ColorMode, Fit, JobOptions, Orientation, Quality, Sides};
use crate::share::media;

/// The "-supported" attributes that gate which options a job may carry.
pub const SUPPORTED_ATTRS: &[&str] = &[
    "copies-supported",
    "media-supported",
    "media-source-supported",
    "media-type-supported",
    "sides-supported",
    "print-color-mode-supported",
    "orientation-requested-supported",
    "print-quality-supported",
    "print-scaling-supported",
    "page-ranges-supported",
];

pub const STATE_ATTRS: &[&str] = &[
    "job-state",
    "job-state-reasons",
    "job-state-message",
    "job-printer-state-message",
    "job-impressions-completed",
    "job-pages-completed",
    "job-media-sheets-completed",
];

/// Options that change which pages print, or how many: never silently dropped.
const MUST_KEEP: [&str; 2] = ["copies", "page-ranges"];

/// Job Template attributes for `opts`, keeping only values the printer lists as supported. Copies or
/// page-ranges it can't apply are an error describing them, since dropping either changes the output.
pub fn template(opts: &JobOptions, supported: &Group) -> Result<Vec<Attribute>, String> {
    let mut out = Vec::new();
    let lists = |name: &str, want: &str| supported.get(name).is_some_and(|a| a.strs().any(|s| s == want));
    let lists_int = |name: &str, want: i32| supported.get(name).is_some_and(|a| a.ints().any(|n| n == want));

    if let Some(copies) = opts.copies.filter(|&c| c > 1) {
        let copies = i32::try_from(copies).unwrap_or(i32::MAX);
        if copies_max(supported).is_none_or(|max| max < copies) {
            return Err(format!("make {copies} copies"));
        }
        out.push(Attribute::new("copies", Value::Integer(copies)));
    }
    let media = opts.media.as_deref().filter(|m| lists("media-supported", m));
    let source = opts.source.as_deref().filter(|s| lists("media-source-supported", s));
    let media_type = opts.media_type.as_deref().filter(|t| lists("media-type-supported", t));
    if source.is_some() || media_type.is_some() {
        out.push(media_col(media, source, media_type));
    } else if let Some(media) = media {
        out.push(Attribute::new("media", Value::keyword(media)));
    }
    if let Some(sides) = opts.sides.map(sides_keyword).filter(|s| lists("sides-supported", s)) {
        out.push(Attribute::new("sides", Value::keyword(sides)));
    }
    if let Some(mode) = opts.color_mode.map(color_keyword).filter(|m| lists("print-color-mode-supported", m)) {
        out.push(Attribute::new("print-color-mode", Value::keyword(mode)));
    }
    let orientation = match opts.orientation {
        Some(Orientation::Portrait) => Some(3),
        Some(Orientation::Landscape) => Some(4),
        _ => None,
    };
    if let Some(o) = orientation.filter(|&o| lists_int("orientation-requested-supported", o)) {
        out.push(Attribute::new("orientation-requested", Value::Enum(o)));
    }
    if let Some(q) = opts.quality.map(quality_enum).filter(|&q| lists_int("print-quality-supported", q)) {
        out.push(Attribute::new("print-quality", Value::Enum(q)));
    }
    if let Some(fit) = opts.fit.map(scaling_keyword).filter(|f| lists("print-scaling-supported", f)) {
        out.push(Attribute::new("print-scaling", Value::keyword(fit)));
    }
    if let Some(text) = opts.page_ranges.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        let ranges = parse_ranges(text).filter(|_| page_ranges_supported(supported));
        let ranges = ranges.ok_or_else(|| format!("print only pages {text}"))?;
        out.push(Attribute::many("page-ranges", ranges.into_iter().map(|(lo, hi)| Value::Range(lo, hi)).collect()));
    }
    Ok(out)
}

/// media-col for a tray or paper type. It replaces `media`, so the paper size moves inside it.
fn media_col(media: Option<&str>, source: Option<&str>, media_type: Option<&str>) -> Attribute {
    let mut members = Vec::new();
    if let Some(name) = media {
        members.push(match media::dimensions(name) {
            Some((x, y)) => Attribute::new("media-size", media::size(x, y)),
            None => Attribute::new("media-size-name", Value::keyword(name)),
        });
    }
    members.extend(source.map(|s| Attribute::new("media-source", Value::keyword(s))));
    members.extend(media_type.map(|t| Attribute::new("media-type", Value::keyword(t))));
    Attribute::new("media-col", Value::Collection(members))
}

/// What to resend after the printer refused the named attributes (or named none of ours): None when
/// that would drop copies or page-ranges, or drop nothing.
pub fn retry_template(template: &[Attribute], refused: &[&str]) -> Option<Vec<Attribute>> {
    let named = template.iter().any(|a| refused.contains(&a.name.as_str()));
    let (dropped, kept): (Vec<&Attribute>, Vec<&Attribute>) = template
        .iter()
        .partition(|a| if named { refused.contains(&a.name.as_str()) } else { !MUST_KEEP.contains(&a.name.as_str()) });
    let changes_output = dropped.iter().any(|a| MUST_KEEP.contains(&a.name.as_str()));
    (!dropped.is_empty() && !changes_output).then(|| kept.into_iter().cloned().collect())
}

/// JobOptions from a received job's attributes (LAN share); media-col is resolved by the caller.
pub fn options(attrs: &[Attribute]) -> JobOptions {
    let get = |name: &str| attrs.iter().find(|a| a.name == name);
    let keyword = |name: &str| get(name).and_then(Attribute::str);
    let col = get("media-col").and_then(|c| c.values.first()?.as_collection()).unwrap_or_default();
    let col_keyword = |name: &str| find(col, name).and_then(Attribute::str).map(str::trim).filter(|k| !k.is_empty());
    JobOptions {
        copies: get("copies").and_then(Attribute::int).and_then(|n| u32::try_from(n).ok()).filter(|&n| n >= 1),
        media: keyword("media").map(str::to_string),
        sides: keyword("sides").and_then(sides),
        color_mode: keyword("print-color-mode").and_then(|s| match s {
            "auto" => Some(ColorMode::Auto),
            "color" => Some(ColorMode::Color),
            "monochrome" | "process-monochrome" | "bi-level" | "auto-monochrome" => Some(ColorMode::Monochrome),
            _ => None,
        }),
        orientation: get("orientation-requested").and_then(Attribute::int).and_then(|o| match o {
            3 | 5 => Some(Orientation::Portrait),
            4 | 6 => Some(Orientation::Landscape),
            7 => Some(Orientation::Auto),
            _ => None,
        }),
        page_ranges: get("page-ranges").and_then(format_ranges),
        fit: keyword("print-scaling").and_then(|s| match s {
            "fit" | "auto-fit" | "auto" => Some(Fit::Fit),
            "fill" => Some(Fit::Fill),
            "none" => Some(Fit::None),
            _ => None,
        }),
        quality: get("print-quality").and_then(Attribute::int).and_then(quality),
        // "auto" is what every tray choice falls back to, so it is the same as not choosing.
        source: col_keyword("media-source").filter(|s| *s != "auto").map(str::to_string),
        media_type: col_keyword("media-type").map(str::to_string),
    }
}

/// print-quality enum (3 draft, 4 normal, 5 high).
pub fn quality(n: i32) -> Option<Quality> {
    match n {
        3 => Some(Quality::Draft),
        4 => Some(Quality::Normal),
        5 => Some(Quality::High),
        _ => None,
    }
}

pub fn quality_enum(q: Quality) -> i32 {
    match q {
        Quality::Draft => 3,
        Quality::Normal => 4,
        Quality::High => 5,
    }
}

pub fn state(job: &Group) -> Option<IppJobState> {
    let state = match job.get("job-state")?.int()? {
        js::PENDING => JobStateKind::Pending,
        js::PENDING_HELD => JobStateKind::Held,
        js::PROCESSING => JobStateKind::Processing,
        js::PROCESSING_STOPPED => JobStateKind::Stopped,
        js::CANCELED => JobStateKind::Canceled,
        js::ABORTED => JobStateKind::Aborted,
        js::COMPLETED => JobStateKind::Completed,
        _ => return None,
    };
    let reasons = job.get("job-state-reasons").map(|a| a.strs().filter(|r| *r != "none").map(str::to_string).collect());
    let message = ["job-state-message", "job-printer-state-message"]
        .iter()
        .find_map(|name| job.get(name).and_then(Attribute::str).map(str::trim).filter(|m| !m.is_empty()));
    let count = |name: &str| job.get(name).and_then(Attribute::int).and_then(|n| u32::try_from(n).ok());
    Some(IppJobState {
        state,
        reasons: reasons.unwrap_or_default(),
        message: message.map(str::to_string),
        impressions: count("job-pages-completed").or_else(|| count("job-impressions-completed")),
        sheets: count("job-media-sheets-completed"),
    })
}

pub fn sides(keyword: &str) -> Option<Sides> {
    match keyword {
        "one-sided" => Some(Sides::OneSided),
        "two-sided-long-edge" => Some(Sides::TwoSidedLongEdge),
        "two-sided-short-edge" => Some(Sides::TwoSidedShortEdge),
        _ => None,
    }
}

pub fn sides_keyword(s: Sides) -> &'static str {
    match s {
        Sides::OneSided => "one-sided",
        Sides::TwoSidedLongEdge => "two-sided-long-edge",
        Sides::TwoSidedShortEdge => "two-sided-short-edge",
    }
}

pub fn color_keyword(c: ColorMode) -> &'static str {
    match c {
        ColorMode::Auto => "auto",
        ColorMode::Color => "color",
        ColorMode::Monochrome => "monochrome",
    }
}

fn scaling_keyword(f: Fit) -> &'static str {
    match f {
        Fit::Fit => "fit",
        Fit::Fill => "fill",
        Fit::None => "none",
    }
}

/// "1-3,5,8-" in any order ("-3" starts at page 1) -> the same pages as the sorted, merged 1-based
/// ranges IPP requires; None when malformed. Accepts what convert::PageSet accepts.
pub fn parse_ranges(s: &str) -> Option<Vec<(i32, i32)>> {
    let number = |s: &str, empty: i32| match s.trim() {
        "" => Some(empty),
        n => n.parse::<u32>().ok().map(|n| i32::try_from(n).unwrap_or(i32::MAX)),
    };
    let mut ranges = Vec::new();
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (lo, hi) = match part.split_once('-') {
            Some((lo, hi)) => (number(lo, 1)?, number(hi, i32::MAX)?),
            None => {
                let n = number(part, 0)?;
                (n, n)
            }
        };
        if lo < 1 || hi < lo {
            return None;
        }
        ranges.push((lo, hi));
    }
    ranges.sort_unstable();
    let mut out: Vec<(i32, i32)> = Vec::with_capacity(ranges.len());
    for (lo, hi) in ranges {
        match out.last_mut() {
            Some(last) if lo <= last.1.saturating_add(1) => last.1 = last.1.max(hi),
            _ => out.push((lo, hi)),
        }
    }
    (!out.is_empty()).then_some(out)
}

fn format_ranges(attr: &Attribute) -> Option<String> {
    let parts: Vec<String> = attr
        .values
        .iter()
        .filter_map(|v| match v {
            Value::Range(lo, hi) if hi == lo => Some(lo.to_string()),
            Value::Range(lo, i32::MAX) => Some(format!("{lo}-")),
            Value::Range(lo, hi) => Some(format!("{lo}-{hi}")),
            _ => None,
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join(","))
}
