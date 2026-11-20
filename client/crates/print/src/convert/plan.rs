//! Chooses how a document reaches a printer: unchanged, text laid out as PDF, or rendered to raster.

use super::media::Media;
use super::pages::PageSet;
use super::raster::Encoding;
use crate::error::{Error, Result};
use crate::ipp::PrinterAttrs;
use crate::model::{Capabilities, ColorMode, DocFormat, JobOptions, Quality};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Channel {
    /// IPP to a printer or a CUPS queue; job options travel as attributes.
    Ipp,
    /// Raw bytes over AppSocket, LPD, or USB; nothing carries job options.
    Raw,
    /// Windows spooler: RAW passthrough, or GDI drawing through the driver.
    Spooler,
}

#[derive(Clone, Debug)]
pub(crate) struct Target {
    pub channel: Channel,
    /// Formats the printer takes unchanged over this channel.
    pub accepts: Vec<DocFormat>,
    pub copies_max: u32,
    pub color: bool,
    pub media_default: Option<String>,
    pub resolutions: Vec<u32>,
    pub pwg_resolutions: Vec<u32>,
    pub pwg_types: Vec<String>,
    pub urf: Vec<String>,
    /// The printer understands HP PJL, so a raw stream can hold one job per copy.
    pub pjl: bool,
    /// The printer applies the page-ranges attribute; otherwise pages are selected here.
    pub page_ranges: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Spec {
    pub dpi: u32,
    pub color: bool,
    pub bilevel: bool,
    pub media: Media,
    /// Copies drawn into the output itself.
    pub copies: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Plan {
    Original(DocFormat),
    TextPdf,
    Raster { input: DocFormat, encoding: Encoding, spec: Spec },
    Gdi(DocFormat),
}

pub(super) fn formats(list: &[String]) -> Vec<DocFormat> {
    let mut out: Vec<DocFormat> = Vec::new();
    for f in list.iter().map(|m| DocFormat::from_mime(m)).filter(|f| *f != DocFormat::Unknown) {
        if !out.contains(&f) {
            out.push(f);
        }
    }
    out
}

impl Target {
    fn new(channel: Channel, caps: &Capabilities, accepts: Vec<DocFormat>) -> Target {
        Target {
            channel,
            accepts,
            copies_max: caps.copies_max.max(1),
            color: caps.color,
            media_default: caps.media_default.clone(),
            resolutions: caps.resolutions.clone(),
            pwg_resolutions: Vec::new(),
            pwg_types: Vec::new(),
            urf: Vec::new(),
            pjl: false,
            page_ranges: false,
        }
    }

    /// An IPP printer, or a CUPS queue (`cups`), which filters PDF, images, and text itself.
    pub fn ipp(attrs: &PrinterAttrs, cups: bool) -> Target {
        let mut accepts = formats(&attrs.capabilities.formats);
        if cups {
            for f in [DocFormat::Pdf, DocFormat::Jpeg, DocFormat::Png, DocFormat::Text] {
                if !accepts.contains(&f) {
                    accepts.push(f);
                }
            }
        }
        let mut target = Target::new(Channel::Ipp, &attrs.capabilities, accepts);
        target.pwg_resolutions = attrs.pwg_resolutions.clone();
        target.pwg_types = attrs.pwg_types.clone();
        target.urf = attrs.urf_supported.clone();
        target.page_ranges = attrs.page_ranges_supported;
        target
    }

    /// AppSocket, LPD, or USB. Plain text is never sent raw: printers would ignore line endings.
    pub fn raw(caps: &Capabilities) -> Target {
        let accepts = formats(&caps.formats).into_iter().filter(|f| *f != DocFormat::Text).collect();
        Target { copies_max: 1, pjl: speaks_pjl(caps), ..Target::new(Channel::Raw, caps, accepts) }
    }

    #[cfg(windows)]
    pub fn spooler(caps: &Capabilities) -> Target {
        let pdl = [DocFormat::Pdf, DocFormat::PostScript, DocFormat::Pcl, DocFormat::PwgRaster, DocFormat::Urf];
        let accepts = formats(&caps.formats).into_iter().filter(|f| pdl.contains(f)).collect();
        Target { pjl: speaks_pjl(caps), ..Target::new(Channel::Spooler, caps, accepts) }
    }

    /// Whether `copies` copies survive the trip: IPP sends a count, other channels resend the
    /// file, and only PCL, PostScript, and PJL-wrapped PDF can follow themselves in one stream.
    fn carries(&self, format: DocFormat, copies: u32) -> bool {
        match self.channel {
            Channel::Ipp => copies <= self.copies_max,
            Channel::Raw | Channel::Spooler => {
                copies == 1 || matches!(format, DocFormat::Pcl | DocFormat::PostScript) || (format == DocFormat::Pdf && self.pjl)
            }
        }
    }

    fn encoding(&self, color: bool) -> Option<Encoding> {
        let order = match (self.channel, color) {
            (Channel::Raw, true) => [Encoding::PostScript, Encoding::Pcl, Encoding::Pwg, Encoding::Urf],
            (Channel::Raw, false) => [Encoding::Pcl, Encoding::PostScript, Encoding::Pwg, Encoding::Urf],
            _ => [Encoding::Pwg, Encoding::Urf, Encoding::Pcl, Encoding::PostScript],
        };
        order.into_iter().find(|e| self.accepts.contains(&e.format()))
    }

    fn wants_color(&self, o: &JobOptions) -> bool {
        self.color && o.color_mode != Some(ColorMode::Monochrome)
    }
}

/// Whether to state the job's sides in a PJL header around an auto-detected document. HP LaserJets print
/// a PDF with their own duplex default whatever `sides` says; other printers keep IPP `sides` alone.
pub(crate) fn pjl_sides(attrs: &PrinterAttrs, o: &JobOptions) -> bool {
    let laserjet = attrs.make_model.as_deref().is_some_and(|m| m.to_ascii_lowercase().contains("laserjet"));
    o.sides.is_some() && laserjet && attrs.auto_sense && speaks_pjl(&attrs.capabilities)
}

/// Office printers that speak PCL or PostScript also understand PJL.
fn speaks_pjl(caps: &Capabilities) -> bool {
    caps.formats.iter().any(|f| {
        let f = f.to_ascii_lowercase();
        f == "application/postscript" || f.starts_with("application/vnd.hp-pcl")
    })
}

pub(crate) fn label(format: DocFormat) -> &'static str {
    match format {
        DocFormat::Pdf => "PDF",
        DocFormat::Jpeg => "JPEG",
        DocFormat::Png => "PNG",
        DocFormat::Text => "text",
        DocFormat::Urf => "AirPrint raster",
        DocFormat::PwgRaster => "PWG raster",
        DocFormat::Pcl => "PCL",
        DocFormat::PostScript => "PostScript",
        DocFormat::Unknown => "these",
    }
}

pub(crate) fn plan(input: DocFormat, t: &Target, o: &JobOptions) -> Result<Plan> {
    if let Some(ranges) = &o.page_ranges {
        PageSet::parse(ranges)?;
    }
    let copies = o.copies.unwrap_or(1).max(1);
    let ranges = o.page_ranges.is_some();
    let raster_input = matches!(input, DocFormat::Urf | DocFormat::PwgRaster);
    let single_page = matches!(input, DocFormat::Jpeg | DocFormat::Png);
    let unchanged = t.accepts.contains(&input)
        && t.carries(input, copies)
        && (!ranges || single_page || (t.page_ranges && !raster_input));
    if unchanged {
        return Ok(Plan::Original(input));
    }
    if input == DocFormat::Text && t.accepts.contains(&DocFormat::Pdf) && t.carries(DocFormat::Pdf, copies) {
        return Ok(Plan::TextPdf);
    }
    // The printer takes the file but not with these settings, and converting won't help.
    let accepted = t.accepts.contains(&input) || (input == DocFormat::Text && t.accepts.contains(&DocFormat::Pdf));
    let limited = || Error::Unsupported("This printer can't print selected pages or extra copies over this connection.".into());
    let rasterizable = matches!(input, DocFormat::Pdf | DocFormat::Text) || single_page || raster_input;
    if !rasterizable {
        return Err(if accepted { limited() } else { Error::Unsupported(format!("This printer can't print {} files.", label(input))) });
    }
    if matches!(input, DocFormat::Pdf | DocFormat::Text) && !cfg!(feature = "raster") {
        return Err(Error::Unsupported(super::source::NO_RASTER.into()));
    }
    if t.channel == Channel::Spooler {
        return Ok(Plan::Gdi(input));
    }
    // Plain text is all black, so a color raster would only triple its size.
    let color = t.wants_color(o) && input != DocFormat::Text;
    let Some(encoding) = t.encoding(color) else {
        if accepted {
            return Err(limited());
        }
        let kind = if single_page { "images" } else { "this kind of file" };
        return Err(Error::Unsupported(format!("This printer doesn't accept any format Print Better can convert {kind} to.")));
    };
    let baked = if t.channel == Channel::Ipp && copies <= t.copies_max { 1 } else { copies };
    Ok(Plan::Raster { input, encoding, spec: spec(encoding, t, o, color, baked) })
}

fn spec(encoding: Encoding, t: &Target, o: &JobOptions, color: bool, copies: u32) -> Spec {
    let has = |list: &[String], key: &str| list.iter().any(|k| k.eq_ignore_ascii_case(key));
    let (color, bilevel, resolutions) = match encoding {
        Encoding::Pwg => {
            let types = &t.pwg_types;
            let open = types.is_empty();
            let color = (color && (open || has(types, "srgb_8"))) || (!open && !has(types, "sgray_8") && !has(types, "black_1"));
            let bilevel = !color && !open && !has(types, "sgray_8") && has(types, "black_1");
            let list = if t.pwg_resolutions.is_empty() { t.resolutions.clone() } else { t.pwg_resolutions.clone() };
            (color, bilevel, list)
        }
        Encoding::Urf => {
            let open = t.urf.is_empty();
            let color = (color && (open || has(&t.urf, "SRGB24"))) || (!open && !has(&t.urf, "W8"));
            (color, false, urf_resolutions(&t.urf))
        }
        // A 24-bit page at 600 dpi is 100 MB before compression, so color stops at 300 dpi.
        Encoding::Pcl => (color, !color, if color { vec![300] } else { vec![300, 600] }),
        Encoding::PostScript => (color, false, if color { vec![150, 300] } else { vec![150, 300, 600] }),
    };
    let media = Media::choose(o.media.as_deref(), t.media_default.as_deref());
    Spec { dpi: pick_dpi(&resolutions, o.quality), color, bilevel, media, copies }
}

/// "RS300" or "RS300-600" in urf-supported.
fn urf_resolutions(keywords: &[String]) -> Vec<u32> {
    keywords
        .iter()
        .filter_map(|k| k.strip_prefix("RS"))
        .flat_map(|list| list.split('-').filter_map(|v| v.parse().ok()).collect::<Vec<u32>>())
        .collect()
}

/// Draft aims for 150 dpi, high for 600, normal for 300; never above 600 to bound memory.
fn pick_dpi(supported: &[u32], quality: Option<Quality>) -> u32 {
    let goal = match quality {
        Some(Quality::Draft) => 150,
        Some(Quality::High) => 600,
        _ => 300,
    };
    let mut list: Vec<u32> = supported.iter().copied().filter(|d| (72..=1200).contains(d)).collect();
    list.sort_unstable();
    list.iter().rev().find(|&&d| d <= goal).or(list.first()).copied().unwrap_or(goal)
}

/// Options the printer must still apply, and how many times raw channels send the payload.
pub(crate) fn printer_options(plan: &Plan, t: &Target, o: &JobOptions) -> (JobOptions, u32) {
    let copies = o.copies.unwrap_or(1).max(1);
    if t.channel != Channel::Ipp {
        let repeat = if matches!(plan, Plan::Raster { .. }) { 1 } else { copies };
        return (JobOptions::default(), repeat);
    }
    let baked = JobOptions { page_ranges: None, orientation: None, fit: None, ..o.clone() };
    let options = match plan {
        Plan::Original(_) => o.clone(),
        Plan::TextPdf => baked,
        Plan::Raster { spec, .. } => JobOptions { copies: if spec.copies > 1 { None } else { o.copies }, ..baked },
        Plan::Gdi(_) => JobOptions::default(),
    };
    (options, 1)
}
