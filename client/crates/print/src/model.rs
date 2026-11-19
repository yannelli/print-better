//! Serde mirror of server/shared/printing.ts. Field names and enum spellings are wire format.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum RouteKind {
    Ipps,
    Ipp,
    Socket,
    Lpd,
    Usb,
    Os,
}

/// URI forms: `ipp(s)://host:port/path`, `socket://host:9100`, `lpd://host/queue`,
/// `usb://VVVV:PPPP/SERIAL?if=N` (hex ids, `-` when no serial), `os://QUEUE-NAME` (percent-encoded).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Route {
    pub kind: RouteKind,
    pub uri: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum PrinterState {
    Idle,
    Printing,
    Stopped,
    Offline,
    #[default]
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SupplyKind {
    Toner,
    Ink,
    Drum,
    Waste,
    Other,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Supply {
    pub name: String,
    pub kind: SupplyKind,
    pub color: Option<String>,
    /// 0..=100, or -1 when unknown.
    pub level: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct PrinterStatus {
    pub state: PrinterState,
    pub reasons: Vec<String>,
    pub message: Option<String>,
    pub supplies: Vec<Supply>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub formats: Vec<String>,
    pub color: bool,
    pub duplex: bool,
    pub media: Vec<String>,
    pub media_default: Option<String>,
    pub resolutions: Vec<u32>,
    pub copies_max: u32,
    /// Paper trays (IPP media-source keywords); empty when unknown.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<String>,
    /// Paper types (IPP media-type keywords); empty when unknown.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub media_types: Vec<String>,
    /// Empty when unknown, which means any quality may be asked for.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub qualities: Vec<Quality>,
}

impl Default for Capabilities {
    fn default() -> Self {
        Self {
            formats: Vec::new(),
            color: false,
            duplex: false,
            media: Vec::new(),
            media_default: None,
            resolutions: Vec::new(),
            copies_max: 1,
            sources: Vec::new(),
            media_types: Vec::new(),
            qualities: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterReport {
    /// Stable per client: `uuid:…`, `usb:vid:pid:serial`, `os:queue`, `net:host:port`.
    pub key: String,
    pub name: String,
    pub make_model: Option<String>,
    pub uuid: Option<String>,
    pub location: Option<String>,
    pub local: bool,
    /// Ordered by preference; printing fails over down the list.
    pub routes: Vec<Route>,
    pub capabilities: Capabilities,
    pub status: PrinterStatus,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Sides {
    OneSided,
    TwoSidedLongEdge,
    TwoSidedShortEdge,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ColorMode {
    Auto,
    Color,
    Monochrome,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Auto,
    Portrait,
    Landscape,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    Fit,
    Fill,
    None,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Draft,
    Normal,
    High,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct JobOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copies: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sides: Option<Sides>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_mode: Option<ColorMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<Orientation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_ranges: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fit: Option<Fit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<Quality>,
    /// Paper tray, one of `Capabilities::sources`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Paper type, one of `Capabilities::media_types`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

impl JobOptions {
    /// Fields set on `self` win; unset fields fall back to `defaults`.
    pub fn over(&self, defaults: &JobOptions) -> JobOptions {
        JobOptions {
            copies: self.copies.or(defaults.copies),
            media: self.media.clone().or_else(|| defaults.media.clone()),
            sides: self.sides.or(defaults.sides),
            color_mode: self.color_mode.or(defaults.color_mode),
            orientation: self.orientation.or(defaults.orientation),
            page_ranges: self.page_ranges.clone().or_else(|| defaults.page_ranges.clone()),
            fit: self.fit.or(defaults.fit),
            quality: self.quality.or(defaults.quality),
            source: self.source.clone().or_else(|| defaults.source.clone()),
            media_type: self.media_type.clone().or_else(|| defaults.media_type.clone()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocFormat {
    Pdf,
    Jpeg,
    Png,
    Text,
    Urf,
    PwgRaster,
    Pcl,
    PostScript,
    Unknown,
}

impl DocFormat {
    pub fn mime(self) -> &'static str {
        match self {
            DocFormat::Pdf => "application/pdf",
            DocFormat::Jpeg => "image/jpeg",
            DocFormat::Png => "image/png",
            DocFormat::Text => "text/plain",
            DocFormat::Urf => "image/urf",
            DocFormat::PwgRaster => "image/pwg-raster",
            DocFormat::Pcl => "application/vnd.hp-PCL",
            DocFormat::PostScript => "application/postscript",
            DocFormat::Unknown => "application/octet-stream",
        }
    }

    pub fn from_mime(mime: &str) -> DocFormat {
        let base = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        match base.as_str() {
            "application/pdf" => DocFormat::Pdf,
            "image/jpeg" => DocFormat::Jpeg,
            "image/png" => DocFormat::Png,
            "text/plain" => DocFormat::Text,
            "image/urf" => DocFormat::Urf,
            "image/pwg-raster" => DocFormat::PwgRaster,
            "application/vnd.hp-pcl" => DocFormat::Pcl,
            "application/postscript" => DocFormat::PostScript,
            _ => DocFormat::Unknown,
        }
    }

    /// Detects the format from the first bytes of a file.
    pub fn sniff(head: &[u8]) -> DocFormat {
        if head.starts_with(b"%PDF-") {
            DocFormat::Pdf
        } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
            DocFormat::Jpeg
        } else if head.starts_with(b"\x89PNG\r\n\x1a\n") {
            DocFormat::Png
        } else if head.starts_with(b"UNIRAST\0") {
            DocFormat::Urf
        } else if head.starts_with(b"RaS2") {
            DocFormat::PwgRaster
        } else if head.starts_with(b"%!") {
            DocFormat::PostScript
        } else if head.starts_with(b"\x1bE") || head.starts_with(b"\x1b%-12345X") {
            DocFormat::Pcl
        } else {
            DocFormat::Unknown
        }
    }
}

/// A document on local disk, ready to print.
#[derive(Clone, Debug)]
pub struct Document {
    pub path: PathBuf,
    pub format: DocFormat,
    pub name: String,
}
