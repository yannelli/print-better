//! Converts PDF/image/text into what the chosen route accepts: PDF passthrough, PWG Raster,
//! URF, PCL, PostScript, or page bitmaps for GDI. Owned by the print-path implementer.

mod image;
mod media;
mod pages;
mod pdfwrite;
mod place;
mod plan;
pub(crate) mod raster;
pub(crate) mod source;
pub(crate) mod spool;
mod text;
#[cfg(test)]
pub(crate) mod tests;

pub(crate) use media::Media;
pub(crate) use pages::PageSet;
pub(crate) use plan::{Channel, Plan, Target, label, plan};

use crate::engine::CancelFlag;
use crate::error::{Error, Result};
use crate::ipp::PrinterAttrs;
use crate::model::{Capabilities, DocFormat, Document, JobOptions, Orientation, Sides};
use raster::{Encoding, RasterSink};
use spool::TempFile;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Input MIME types the engine can print to a printer with these capabilities, natively or
/// after conversion. LAN sharing advertises exactly this list. Frozen signature.
pub fn printable_formats(caps: &Capabilities) -> Vec<&'static str> {
    let accepts = plan::formats(&caps.formats);
    let known = !accepts.is_empty();
    let takes = |f: DocFormat| !known || accepts.contains(&f);
    let raster_out = !known || accepts.iter().any(|f| Encoding::of(*f).is_some());
    let renders_pdf = cfg!(feature = "raster") && raster_out;
    [
        (DocFormat::Pdf, takes(DocFormat::Pdf) || renders_pdf),
        (DocFormat::Urf, takes(DocFormat::Urf) || raster_out),
        (DocFormat::PwgRaster, takes(DocFormat::PwgRaster) || raster_out),
        (DocFormat::Jpeg, takes(DocFormat::Jpeg) || raster_out),
        (DocFormat::Png, takes(DocFormat::Png) || raster_out),
        (DocFormat::Text, takes(DocFormat::Text) || takes(DocFormat::Pdf) || renders_pdf),
        (DocFormat::PostScript, known && takes(DocFormat::PostScript)),
        (DocFormat::Pcl, known && takes(DocFormat::Pcl)),
    ]
    .into_iter()
    .filter(|(_, ok)| *ok)
    .map(|(format, _)| format.mime())
    .collect()
}

/// Converts `doc` to `mime` (PWG Raster, URF, PCL, or PostScript) as the engine would for an IPP
/// printer with `attrs` that took only that format; writes `out` and returns the pages when known.
pub async fn convert_to(
    doc: &Document,
    mime: &str,
    attrs: &PrinterAttrs,
    options: &JobOptions,
    state_dir: &Path,
    out: &Path,
) -> Result<Option<u32>> {
    let format = DocFormat::from_mime(mime);
    if Encoding::of(format).is_none() {
        return Err(Error::Unsupported(format!("Print Better can't produce {mime}.")));
    }
    let target = Target { accepts: vec![format], ..Target::ipp(attrs, false) };
    let plan = plan(detect(doc)?, &target, options)?;
    let prepared = prepare(doc, &plan, &target, options, state_dir, &CancelFlag::default()).await?;
    std::fs::copy(&prepared.path, out)?;
    Ok(prepared.pages)
}

/// The document's real format: its bytes win over the declared type.
pub(crate) fn detect(doc: &Document) -> Result<DocFormat> {
    let mut head = Vec::with_capacity(1024);
    std::fs::File::open(&doc.path)?.take(1024).read_to_end(&mut head)?;
    let sniffed = DocFormat::sniff(&head);
    if sniffed != DocFormat::Unknown {
        return Ok(sniffed);
    }
    if head.windows(5).any(|w| w == b"%PDF-") {
        return Ok(DocFormat::Pdf);
    }
    if doc.format != DocFormat::Unknown {
        return Ok(doc.format);
    }
    let utf16 = head.starts_with(&[0xFF, 0xFE]) || head.starts_with(&[0xFE, 0xFF]);
    if utf16 || !head.contains(&0) {
        return Ok(DocFormat::Text);
    }
    Err(Error::Unsupported("Print Better can't tell what kind of file this is.".into()))
}

/// A file ready to send, with the options the printer must still apply.
#[derive(Debug)]
pub(crate) struct Prepared {
    pub path: PathBuf,
    pub format: DocFormat,
    pub options: JobOptions,
    /// Times a raw channel sends the payload (copies the output doesn't contain).
    pub repeat: u32,
    /// Pages in the payload, counting copies, when known.
    pub pages: Option<u32>,
    _scratch: Option<TempFile>,
}

/// Runs `work` on the blocking pool; a panic inside (for example in the PDF renderer) becomes an error.
pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(e) if e.is_panic() => Err(Error::Unsupported("Print Better couldn't convert this document.".into())),
        Err(_) => Err(Error::Canceled),
    }
}

fn page_set(options: &JobOptions) -> Result<Option<PageSet>> {
    options.page_ranges.as_deref().map(PageSet::parse).transpose()
}

/// How pages are drawn for raster output (also used by the Windows GDI path).
pub(crate) fn job(media: Media, dpi: u32, color: bool, crisp: bool, options: &JobOptions, cancel: &CancelFlag) -> Result<source::Job> {
    Ok(source::Job {
        media,
        dpi,
        color,
        crisp,
        fit: options.fit,
        orientation: options.orientation.unwrap_or(Orientation::Auto),
        pages: page_set(options)?,
        cancel: cancel.clone(),
    })
}

/// Draws any printable input; plain text is laid out as a PDF first.
pub(crate) fn render_document(input: DocFormat, path: &Path, state_dir: &Path, job: &source::Job, sink: &mut dyn RasterSink) -> Result<u32> {
    if input != DocFormat::Text {
        return source::render(input, path, job, sink);
    }
    let (scratch, file) = TempFile::create(state_dir, "pdf")?;
    text::to_pdf(path, file, &job.media, job.orientation == Orientation::Landscape, job.pages.as_ref())?;
    let laid_out = source::Job { orientation: Orientation::Auto, pages: None, ..job.clone() };
    source::render(DocFormat::Pdf, scratch.path(), &laid_out, sink)
}

pub(crate) async fn prepare(
    doc: &Document,
    plan: &Plan,
    target: &Target,
    options: &JobOptions,
    state_dir: &Path,
    cancel: &CancelFlag,
) -> Result<Prepared> {
    let (printer_options, repeat) = plan::printer_options(plan, target, options);
    match plan {
        Plan::Original(format) => Ok(Prepared {
            path: doc.path.clone(),
            format: *format,
            options: printer_options,
            repeat,
            pages: None,
            _scratch: None,
        }),
        Plan::TextPdf => {
            let media = Media::choose(options.media.as_deref(), target.media_default.as_deref());
            let landscape = options.orientation == Some(Orientation::Landscape);
            let select = page_set(options)?;
            let (scratch, file) = TempFile::create(state_dir, "pdf")?;
            let src = doc.path.clone();
            let pages = blocking(move || text::to_pdf(&src, file, &media, landscape, select.as_ref())).await?;
            let path = scratch.path().to_path_buf();
            let pages = Some(pages.saturating_mul(repeat));
            Ok(Prepared { path, format: DocFormat::Pdf, options: printer_options, repeat, pages, _scratch: Some(scratch) })
        }
        Plan::Raster { input, encoding, spec } => {
            let crisp = spec.bilevel || (*encoding == Encoding::Pcl && !spec.color);
            let job = job(spec.media.clone(), spec.dpi, spec.color, crisp, options, cancel)?;
            let settings = raster::Settings {
                media: spec.media.clone(),
                sides: options.sides.unwrap_or(Sides::OneSided),
                quality: options.quality,
                bilevel: spec.bilevel,
            };
            let (scratch, file) = TempFile::create(state_dir, encoding.extension())?;
            let (out, src, dir) = (scratch.path().to_path_buf(), doc.path.clone(), state_dir.to_path_buf());
            let (input, encoding, copies) = (*input, *encoding, spec.copies);
            let pages = blocking(move || {
                raster::encode(encoding, settings, copies, file, &out, |sink| render_document(input, &src, &dir, &job, sink))
            })
            .await?;
            let path = scratch.path().to_path_buf();
            let format = encoding.format();
            Ok(Prepared { path, format, options: printer_options, repeat, pages: Some(pages), _scratch: Some(scratch) })
        }
        Plan::Gdi(_) => Err(Error::Unsupported("Windows drawing jobs are not files.".into())),
    }
}
