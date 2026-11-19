//! Paper sizes from PWG 5101.1 self-describing names ("na_letter_8.5x11in", "iso_a4_210x297mm").

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Media {
    pub name: String,
    /// Portrait width and height in PostScript points (1/72 in).
    pub width: f64,
    pub height: f64,
}

const MM: f64 = 72.0 / 25.4;
const MIN_PT: f64 = 36.0;
const MAX_PT: f64 = 3400.0;

const ALIASES: &[(&str, &str)] = &[
    ("letter", "na_letter_8.5x11in"),
    ("legal", "na_legal_8.5x14in"),
    ("executive", "na_executive_7.25x10.5in"),
    ("ledger", "na_ledger_11x17in"),
    ("tabloid", "na_ledger_11x17in"),
    ("a3", "iso_a3_297x420mm"),
    ("a4", "iso_a4_210x297mm"),
    ("a5", "iso_a5_148x210mm"),
];

/// (width pt, height pt, PCL page size code, PJL PAPER name)
const KNOWN: &[(f64, f64, u32, &str)] = &[
    (612.0, 792.0, 2, "LETTER"),
    (612.0, 1008.0, 3, "LEGAL"),
    (522.0, 756.0, 1, "EXECUTIVE"),
    (792.0, 1224.0, 6, "LEDGER"),
    (595.28, 841.89, 26, "A4"),
    (841.89, 1190.55, 27, "A3"),
    (419.53, 595.28, 25, "A5"),
    (515.91, 728.5, 45, "JISB5"),
];

const LETTER_REGIONS: &[&str] = &["US", "CA", "MX", "PH", "CL", "CO", "VE", "PR"];

impl Media {
    pub fn letter() -> Media {
        Media { name: "na_letter_8.5x11in".into(), width: 612.0, height: 792.0 }
    }

    pub fn a4() -> Media {
        Media { name: "iso_a4_210x297mm".into(), width: 210.0 * MM, height: 297.0 * MM }
    }

    pub fn parse(name: &str) -> Option<Media> {
        let name = name.trim();
        let lower = name.to_ascii_lowercase();
        let bare = lower.trim_start_matches("na-").trim_start_matches("iso-");
        if let Some((_, pwg)) = ALIASES.iter().find(|(alias, _)| *alias == bare) {
            return Media::parse(pwg);
        }
        let dims = lower.rsplit('_').next()?;
        let (num, unit) = match (dims.strip_suffix("in"), dims.strip_suffix("mm")) {
            (Some(n), _) => (n, 72.0),
            (_, Some(n)) => (n, MM),
            _ => return None,
        };
        let (w, h) = num.split_once('x')?;
        let w = w.parse::<f64>().ok()? * unit;
        let h = h.parse::<f64>().ok()? * unit;
        let valid = |v: f64| v.is_finite() && (MIN_PT..=MAX_PT).contains(&v);
        (valid(w) && valid(h)).then(|| Media { name: name.to_string(), width: w.min(h), height: w.max(h) })
    }

    /// Requested size, else the printer's default, else Letter or A4 by locale.
    pub fn choose(requested: Option<&str>, printer_default: Option<&str>) -> Media {
        requested.and_then(Media::parse).or_else(|| printer_default.and_then(Media::parse)).unwrap_or_else(locale_default)
    }

    fn known(&self) -> Option<&'static (f64, f64, u32, &'static str)> {
        KNOWN.iter().find(|(w, h, _, _)| (w - self.width).abs() < 2.0 && (h - self.height).abs() < 2.0)
    }

    pub fn pcl_code(&self) -> Option<u32> {
        self.known().map(|k| k.2)
    }

    pub fn pjl_name(&self) -> Option<&'static str> {
        self.known().map(|k| k.3)
    }

    /// PCL insets its logical page from the paper edge: 1/4 in on inch sizes, 6 mm on metric.
    pub fn pcl_left_inset(&self) -> f64 {
        if self.name.starts_with("iso_") || self.name.starts_with("jis_") { 6.0 * MM } else { 18.0 }
    }

    pub fn pixels(&self, dpi: u32) -> (u32, u32) {
        let px = |pt: f64| (pt * f64::from(dpi) / 72.0).round().max(1.0) as u32;
        (px(self.width), px(self.height))
    }
}

fn locale_default() -> Media {
    let locale = ["LC_ALL", "LC_PAPER", "LANG"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    for_locale(&locale)
}

/// Letter where it is the usual paper ("en_US.UTF-8"), otherwise A4.
pub(crate) fn for_locale(locale: &str) -> Media {
    let region = locale.split(['.', '@']).next().and_then(|l| l.split('_').nth(1));
    if region.is_some_and(|r| LETTER_REGIONS.contains(&r)) { Media::letter() } else { Media::a4() }
}
