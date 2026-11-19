//! HP PJL job wrapper for raw channels: names the job, switches the printer language, and
//! carries duplex, paper, and color settings that PDF passthrough can't express itself.

use crate::convert::Media;
use crate::model::{ColorMode, DocFormat, JobOptions, Sides};

const UEL: &str = "\x1b%-12345X";

fn clean(name: &str) -> String {
    let name: String = name.chars().filter(|c| c.is_ascii_graphic() || *c == ' ').filter(|c| *c != '"').take(80).collect();
    if name.trim().is_empty() { "Print Better".into() } else { name }
}

/// Prefix and suffix around one copy of a document in `format`, or None when PJL doesn't apply.
pub(crate) fn wrap(format: DocFormat, name: &str, options: &JobOptions) -> Option<(Vec<u8>, Vec<u8>)> {
    let language = match format {
        DocFormat::Pdf => "PDF",
        DocFormat::PostScript => "POSTSCRIPT",
        DocFormat::Pcl => "PCL",
        _ => return None,
    };
    let name = clean(name);
    let mut head = format!("{UEL}@PJL JOB NAME=\"{name}\"\r\n");
    match options.sides {
        Some(Sides::TwoSidedLongEdge) => head.push_str("@PJL SET DUPLEX=ON\r\n@PJL SET BINDING=LONGEDGE\r\n"),
        Some(Sides::TwoSidedShortEdge) => head.push_str("@PJL SET DUPLEX=ON\r\n@PJL SET BINDING=SHORTEDGE\r\n"),
        Some(Sides::OneSided) => head.push_str("@PJL SET DUPLEX=OFF\r\n"),
        None => {}
    }
    if let Some(paper) = options.media.as_deref().and_then(Media::parse).and_then(|m| m.pjl_name()) {
        head.push_str(&format!("@PJL SET PAPER={paper}\r\n"));
    }
    if options.color_mode == Some(ColorMode::Monochrome) {
        head.push_str("@PJL SET RENDERMODE=GRAYSCALE\r\n");
    }
    head.push_str(&format!("@PJL ENTER LANGUAGE={language}\r\n"));
    let tail = format!("{UEL}@PJL EOJ NAME=\"{name}\"\r\n{UEL}");
    Some((head.into_bytes(), tail.into_bytes()))
}
