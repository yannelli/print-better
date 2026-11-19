//! Spooler jobs: RAW passthrough of data that is already the printer's language, plus job
//! state and cancel for following any spooled job to the end.

use super::{Printer, from_wide, two_call, wide};
use crate::backends::Payload;
use crate::engine::CancelFlag;
use crate::error::{Error, Result};
use std::io::Read;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Graphics::Printing::*;

/// Sends the payload as one RAW spooler job; returns the job id. Blocking.
pub(crate) fn send_raw(name: &str, payload: &Payload, doc_name: &str, cancel: &CancelFlag) -> Result<u32> {
    let printer = Printer::open(name)?;
    let mut doc = wide(doc_name);
    let mut datatype = wide("RAW");
    let info = DOC_INFO_1W { pDocName: doc.as_mut_ptr(), pOutputFile: null_mut(), pDatatype: datatype.as_mut_ptr() };
    // SAFETY: the handle is open and DOC_INFO_1W points at live NUL-terminated strings.
    let job = unsafe { StartDocPrinterW(printer.0, 1, &info) };
    if job == 0 {
        return Err(Error::Unsupported("This printer's Windows driver doesn't accept raw print data.".into()));
    }
    let result = write_all(&printer, payload, cancel);
    // SAFETY: matching EndPage/EndDoc or AbortPrinter for the document started above.
    unsafe {
        match &result {
            Ok(()) => {
                EndPagePrinter(printer.0);
                EndDocPrinter(printer.0);
            }
            Err(_) => {
                AbortPrinter(printer.0);
            }
        }
    }
    result.map(|()| job)
}

fn write_all(printer: &Printer, payload: &Payload, cancel: &CancelFlag) -> Result<()> {
    // SAFETY: a document is open on this handle.
    if unsafe { StartPagePrinter(printer.0) } == 0 {
        return Err(Error::Rejected("Windows refused to start the page.".into()));
    }
    let mut buf = vec![0u8; 64 * 1024];
    for _ in 0..payload.repeat.max(1) {
        write(printer, &payload.prefix, cancel)?;
        let mut file = std::fs::File::open(&payload.path)?;
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            write(printer, &buf[..n], cancel)?;
        }
        write(printer, &payload.suffix, cancel)?;
    }
    Ok(())
}

fn write(printer: &Printer, mut data: &[u8], cancel: &CancelFlag) -> Result<()> {
    while !data.is_empty() {
        if cancel.is_canceled() {
            return Err(Error::Canceled);
        }
        let mut written = 0u32;
        let len = data.len().min(u32::MAX as usize) as u32;
        // SAFETY: `data` is valid for `len` bytes and `written` is a valid out pointer.
        let ok = unsafe { WritePrinter(printer.0, data.as_ptr().cast(), len, &mut written) };
        if ok == 0 || written == 0 {
            return Err(Error::Rejected("Windows stopped accepting print data partway through.".into()));
        }
        data = &data[(written as usize).min(data.len())..];
    }
    Ok(())
}

pub(crate) struct JobState {
    /// The spooler no longer knows the job: it printed and was removed.
    pub gone: bool,
    pub status: u32,
    pub pages_printed: u32,
    pub message: Option<String>,
}

pub(crate) fn job_state(name: &str, job: u32) -> Result<JobState> {
    let printer = Printer::open(name)?;
    // SAFETY: GetJobW writes at most `size` bytes into the buffer it is given.
    let Some(buf) = two_call(|ptr, size, needed| unsafe { GetJobW(printer.0, job, 1, ptr, size, needed) }) else {
        return Ok(JobState { gone: true, status: 0, pages_printed: 0, message: None });
    };
    // SAFETY: on success the buffer starts with a JOB_INFO_1W whose pointers point inside it.
    let info = unsafe { &*(buf.as_ptr() as *const JOB_INFO_1W) };
    let message = Some(from_wide(info.pStatus)).filter(|m| !m.trim().is_empty());
    Ok(JobState { gone: false, status: info.Status, pages_printed: info.PagesPrinted, message })
}

pub(crate) fn cancel_job(name: &str, job: u32) {
    if let Ok(printer) = Printer::open(name) {
        // SAFETY: level 0 with a null buffer issues the delete command only.
        unsafe { SetJobW(printer.0, job, 0, null(), JOB_CONTROL_DELETE) };
    }
}
