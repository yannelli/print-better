//! Page selections like "1-3,5,8-" (1-based, inclusive; an open end runs to the last page).

use crate::error::{Error, Result};

const MAX_RANGES: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PageSet(Vec<(u32, u32)>);

impl PageSet {
    pub fn parse(text: &str) -> Result<PageSet> {
        let invalid = || Error::Unsupported(format!("The page range \"{text}\" isn't valid. Use something like 1-3,5."));
        let number = |s: &str, empty: u32| -> Result<u32> {
            let s = s.trim();
            if s.is_empty() { Ok(empty) } else { s.parse().map_err(|_| invalid()) }
        };
        let mut ranges = Vec::new();
        for part in text.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let (first, last) = match part.split_once('-') {
                Some((a, b)) => (number(a, 1)?, number(b, u32::MAX)?),
                None => {
                    let n = number(part, 0)?;
                    (n, n)
                }
            };
            if first == 0 || first > last {
                return Err(invalid());
            }
            ranges.push((first, last));
        }
        if ranges.is_empty() || ranges.len() > MAX_RANGES {
            return Err(invalid());
        }
        Ok(PageSet(ranges))
    }

    pub fn contains(&self, page: u32) -> bool {
        self.0.iter().any(|&(first, last)| (first..=last).contains(&page))
    }
}

/// Zero-based indices of the pages to print from a `count`-page document, in order.
pub(crate) fn select(set: Option<&PageSet>, count: usize) -> Result<Vec<usize>> {
    let pages: Vec<usize> = (0..count).filter(|&i| set.is_none_or(|s| s.contains(i as u32 + 1))).collect();
    if pages.is_empty() {
        return Err(Error::Unsupported("None of the selected pages are in this document.".into()));
    }
    Ok(pages)
}
