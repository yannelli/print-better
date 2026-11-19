//! Windows spooler: queue enumeration and status (winspool), RAW passthrough, GDI drawing.

pub(crate) mod gdi;
pub(crate) mod spool;

use super::percent_encode;
use crate::error::{Error, Result};
use crate::model::{Capabilities, PrinterReport, PrinterState, PrinterStatus, Route, RouteKind};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Graphics::Gdi::DEVMODEW;
use windows_sys::Win32::Graphics::Printing::*;
use windows_sys::Win32::Storage::Xps::{DC_COLORDEVICE, DC_COPIES, DC_DUPLEX, DeviceCapabilitiesW};

/// Queues that open a save dialog or go nowhere; a background service must never print to them.
const VIRTUAL_PORTS: &[&str] = &["PORTPROMPT:", "XPSPort:", "nul:", "SHRFAX:", "FILE:"];

/// (DEVMODE paper code, PWG media name)
pub(crate) const PAPERS: &[(i16, &str)] = &[
    (1, "na_letter_8.5x11in"),
    (5, "na_legal_8.5x14in"),
    (7, "na_executive_7.25x10.5in"),
    (3, "na_ledger_11x17in"),
    (8, "iso_a3_297x420mm"),
    (9, "iso_a4_210x297mm"),
    (11, "iso_a5_148x210mm"),
    (13, "jis_b5_182x257mm"),
];

pub(crate) fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Copies a NUL-terminated UTF-16 string owned by Windows.
pub(crate) fn from_wide(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    // SAFETY: Windows hands out NUL-terminated strings that live as long as their buffer.
    unsafe {
        let len = (0..).take_while(|&i| *ptr.add(i) != 0).count();
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }
}

/// An open printer handle, closed on drop.
pub(crate) struct Printer(pub PRINTER_HANDLE);

impl Printer {
    pub fn open(name: &str) -> Result<Printer> {
        let wname = wide(name);
        let mut handle = PRINTER_HANDLE::default();
        // SAFETY: valid NUL-terminated name and out pointer; null defaults are allowed.
        let ok = unsafe { OpenPrinterW(wname.as_ptr(), &mut handle, null()) };
        if ok == 0 || handle.Value.is_null() {
            return Err(Error::Unreachable(format!("Windows can't open the printer \"{name}\".")));
        }
        Ok(Printer(handle))
    }
}

impl Drop for Printer {
    fn drop(&mut self) {
        // SAFETY: the handle came from OpenPrinterW and is closed once.
        unsafe { ClosePrinter(self.0) };
    }
}

/// Calls a winspool "query size, then fill" API into an 8-byte aligned buffer.
pub(crate) fn two_call(mut fill: impl FnMut(*mut u8, u32, &mut u32) -> i32) -> Option<Vec<u64>> {
    let mut needed = 0u32;
    fill(null_mut(), 0, &mut needed);
    if needed == 0 {
        return None;
    }
    let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
    let size = (buf.len() * 8) as u32;
    (fill(buf.as_mut_ptr().cast(), size, &mut needed) != 0).then_some(buf)
}

#[derive(Default)]
pub(crate) struct Info {
    pub driver: String,
    pub port: String,
    pub location: String,
    pub status: u32,
    pub attributes: u32,
    pub paper: Option<i16>,
}

pub(crate) fn info(printer: &Printer) -> Option<Info> {
    // SAFETY: GetPrinterW writes at most `size` bytes into the buffer it is given.
    let buf = two_call(|ptr, size, needed| unsafe { GetPrinterW(printer.0, 2, ptr, size, needed) })?;
    // SAFETY: on success the buffer starts with a PRINTER_INFO_2W whose pointers point inside it.
    let p = unsafe { &*(buf.as_ptr() as *const PRINTER_INFO_2W) };
    let devmode: *const DEVMODEW = p.pDevMode;
    // SAFETY: pDevMode is null or points to a DEVMODEW inside the buffer; dmPaperSize is a plain field.
    let paper = (!devmode.is_null()).then(|| unsafe { (*devmode).Anonymous1.Anonymous1.dmPaperSize });
    Some(Info {
        driver: from_wide(p.pDriverName),
        port: from_wide(p.pPortName),
        location: from_wide(p.pLocation),
        status: p.Status,
        attributes: p.Attributes,
        paper,
    })
}

fn device_cap(name: &str, port: &str, cap: u16) -> i32 {
    let (wname, wport) = (wide(name), wide(port));
    // SAFETY: valid strings; a null output buffer asks for the value itself.
    unsafe { DeviceCapabilitiesW(wname.as_ptr(), wport.as_ptr(), cap, null_mut(), null()) }
}

pub(crate) fn status_from(info: &Info) -> PrinterStatus {
    let s = info.status;
    let mut reasons = Vec::new();
    for (bit, reason) in [
        (PRINTER_STATUS_PAPER_JAM, "media-jam"),
        (PRINTER_STATUS_PAPER_OUT, "media-empty"),
        (PRINTER_STATUS_DOOR_OPEN, "door-open"),
        (PRINTER_STATUS_NO_TONER, "toner-empty"),
        (PRINTER_STATUS_OUTPUT_BIN_FULL, "output-area-full"),
        (PRINTER_STATUS_PAUSED, "paused"),
        (PRINTER_STATUS_OUT_OF_MEMORY, "spool-area-full"),
        (PRINTER_STATUS_OFFLINE | PRINTER_STATUS_NOT_AVAILABLE | PRINTER_STATUS_SERVER_OFFLINE, "offline"),
        (PRINTER_STATUS_TONER_LOW, "toner-low"),
        (PRINTER_STATUS_ERROR | PRINTER_STATUS_USER_INTERVENTION | PRINTER_STATUS_PAPER_PROBLEM, "other"),
    ] {
        if s & bit != 0 {
            reasons.push(reason.to_string());
        }
    }
    let offline = PRINTER_STATUS_OFFLINE | PRINTER_STATUS_NOT_AVAILABLE | PRINTER_STATUS_SERVER_OFFLINE;
    let work_offline = info.attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE != 0;
    let stopped = PRINTER_STATUS_PAUSED
        | PRINTER_STATUS_PAPER_JAM
        | PRINTER_STATUS_PAPER_OUT
        | PRINTER_STATUS_DOOR_OPEN
        | PRINTER_STATUS_NO_TONER
        | PRINTER_STATUS_OUTPUT_BIN_FULL
        | PRINTER_STATUS_ERROR
        | PRINTER_STATUS_USER_INTERVENTION
        | PRINTER_STATUS_PAPER_PROBLEM;
    let busy = PRINTER_STATUS_PRINTING | PRINTER_STATUS_PROCESSING | PRINTER_STATUS_BUSY | PRINTER_STATUS_IO_ACTIVE;
    let state = if s & offline != 0 || work_offline {
        PrinterState::Offline
    } else if s & stopped != 0 {
        PrinterState::Stopped
    } else if s & busy != 0 {
        PrinterState::Printing
    } else {
        PrinterState::Idle
    };
    let message = work_offline.then(|| "The printer is set to \"Use Printer Offline\" in Windows.".to_string());
    PrinterStatus { state, reasons, message, supplies: Vec::new() }
}

/// Current state of one queue. Blocking.
pub(crate) fn status(name: &str) -> Result<PrinterStatus> {
    let printer = Printer::open(name)?;
    info(&printer).map(|i| status_from(&i)).ok_or_else(|| Error::Unreachable(format!("Windows has no status for \"{name}\".")))
}

fn report(name: String) -> Option<PrinterReport> {
    let info = Printer::open(&name).ok().and_then(|p| info(&p)).unwrap_or_default();
    if VIRTUAL_PORTS.iter().any(|v| info.port.eq_ignore_ascii_case(v)) {
        return None;
    }
    let media_default = info.paper.and_then(|code| PAPERS.iter().find(|(c, _)| *c == code)).map(|(_, n)| n.to_string());
    let capabilities = Capabilities {
        color: device_cap(&name, &info.port, DC_COLORDEVICE) == 1,
        duplex: device_cap(&name, &info.port, DC_DUPLEX) == 1,
        copies_max: device_cap(&name, &info.port, DC_COPIES).max(1) as u32,
        media_default,
        ..Capabilities::default()
    };
    let non_empty = |s: &str| (!s.trim().is_empty()).then(|| s.trim().to_string());
    Some(PrinterReport {
        key: format!("os:{name}"),
        make_model: non_empty(&info.driver),
        uuid: None,
        location: non_empty(&info.location),
        local: true,
        routes: vec![Route { kind: RouteKind::Os, uri: format!("os://{}", percent_encode(&name)) }],
        capabilities,
        status: status_from(&info),
        name,
    })
}

/// Windows spooler queues (EnumPrintersW) as `os://` routes. Blocking; discovery calls
/// it from `spawn_blocking`.
pub fn enumerate() -> Vec<PrinterReport> {
    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let mut count = 0u32;
    // SAFETY: level 4 with a null name lists local and connected queues into our buffer.
    let Some(buf) = two_call(|ptr, size, needed| unsafe { EnumPrintersW(flags, null(), 4, ptr, size, needed, &mut count) })
    else {
        return Vec::new();
    };
    let max = buf.len() * 8 / std::mem::size_of::<PRINTER_INFO_4W>();
    // SAFETY: the buffer holds `count` PRINTER_INFO_4W records, bounded by its size.
    let infos = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_4W, (count as usize).min(max)) };
    infos.iter().map(|i| from_wide(i.pPrinterName)).filter(|n| !n.is_empty()).filter_map(report).collect()
}
