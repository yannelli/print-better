//! What a finished job should have printed, so a printer that stops early without saying why
//! is noticed.

use crate::ipp::{IppJobState, PrinterAttrs, job::parse_ranges};
use crate::model::{JobOptions, Sides};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Expected {
    /// Printed sides: selected pages times copies.
    pub impressions: u32,
    /// Sheets of paper: selected pages, halved and rounded up when two-sided, times copies.
    pub sheets: u32,
}

impl Expected {
    /// From the pages sent and the options the printer still applies; None if nothing would print.
    pub fn new(pages: u32, options: &JobOptions, two_sided: bool) -> Option<Expected> {
        let selected = match options.page_ranges.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
            None => pages,
            Some(ranges) => parse_ranges(ranges)?.iter().map(|&(first, last)| within(first, last, pages)).sum(),
        };
        let copies = options.copies.unwrap_or(1).max(1);
        let sheets = if two_sided { selected.div_ceil(2) } else { selected };
        (selected > 0).then_some(Expected { impressions: selected.checked_mul(copies)?, sheets: sheets.checked_mul(copies)? })
    }

    /// Whether the counts in `job` show every expected page or sheet printed.
    pub fn covered_by(&self, job: &IppJobState) -> bool {
        job.impressions.is_some_and(|n| n >= self.impressions) || job.sheets.is_some_and(|n| n >= self.sheets)
    }

    /// "The printer stopped after 4 of 11 pages." when a completed job reports less than expected.
    /// A count of 0 is taken as a printer that doesn't count, not one that printed nothing.
    pub fn shortfall(&self, job: &IppJobState) -> Option<String> {
        let (done, wanted, unit) = match (job.impressions.filter(|&n| n > 0), job.sheets.filter(|&n| n > 0)) {
            (Some(done), _) => (done, self.impressions, "pages"),
            (None, Some(done)) if self.sheets != self.impressions => (done, self.sheets, "sheets"),
            (None, Some(done)) => (done, self.sheets, "pages"),
            (None, None) => return None,
        };
        (done < wanted).then(|| format!("The printer stopped after {done} of {wanted} {unit}."))
    }
}

/// Pages first..=last that exist in a `pages`-page document.
fn within(first: i32, last: i32, pages: u32) -> u32 {
    let first = u32::try_from(first).unwrap_or(0).max(1);
    let last = u32::try_from(last).unwrap_or(0).min(pages);
    (last + 1).saturating_sub(first)
}

/// Whether the printer prints on both sides: as the job asks when it can, else its own default.
pub(crate) fn two_sided(job: Option<Sides>, printer: &PrinterAttrs) -> bool {
    let sides = match job {
        Some(Sides::OneSided) => Some(Sides::OneSided),
        Some(two) if printer.capabilities.duplex => Some(two),
        _ => printer.sides_default,
    };
    matches!(sides, Some(Sides::TwoSidedLongEdge | Sides::TwoSidedShortEdge))
}
