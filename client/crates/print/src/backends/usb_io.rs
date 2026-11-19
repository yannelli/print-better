//! nusb access to printer-class interfaces: listing, IEEE 1284 Device ID, bulk writes, port status.

use super::usb::UsbAddress;
use super::{Events, Payload, Progress};
use crate::device_id::DeviceId;
use crate::engine::{CancelFlag, PrintEvent};
use crate::error::{Error, Result};
use crate::model::{Capabilities, PrinterReport, PrinterState, PrinterStatus, Route, RouteKind};
use nusb::descriptors::TransferType;
use nusb::transfer::{Buffer, Bulk, ControlIn, ControlType, Direction, Out, Recipient};
use nusb::{DeviceInfo, Endpoint, ErrorKind, Interface, MaybeFuture};
use std::time::Duration;
use tokio::io::AsyncReadExt;

const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);
const STALL_NOTICE: Duration = Duration::from_secs(20);
const CHUNK: usize = 16 * 1024;
const IN_FLIGHT: usize = 4;
const PAPER_EMPTY: u8 = 0x20;
const NO_PERMISSION: &str = "Print Better doesn't have permission to use this USB printer yet.";

fn is_printer(class: u8, subclass: u8, protocol: u8) -> bool {
    class == 7 && subclass == 1 && matches!(protocol, 1 | 2)
}

/// The printer-class interface to use, preferring bidirectional (protocol 2).
fn printer_interface(info: &DeviceInfo) -> Option<u8> {
    info.interfaces()
        .filter(|i| is_printer(i.class(), i.subclass(), i.protocol()))
        .max_by_key(|i| i.protocol())
        .map(|i| i.interface_number())
}

fn alt_setting(device: &nusb::Device, interface: u8) -> u8 {
    let config = device.active_configuration().ok();
    config
        .and_then(|c| {
            c.interface_alt_settings()
                .find(|a| a.interface_number() == interface && is_printer(a.class(), a.subclass(), a.protocol()))
                .map(|a| a.alternate_setting())
        })
        .unwrap_or(0)
}

/// GET_DEVICE_ID: wIndex is (interface << 8) | alt. The 2-byte length is big-endian, but some
/// printers send it little-endian; fall back to the buffer length when neither fits.
fn device_id(device: &nusb::Device, interface: u8) -> Option<String> {
    let index = (u16::from(interface) << 8) | u16::from(alt_setting(device, interface));
    let request = ControlIn { control_type: ControlType::Class, recipient: Recipient::Interface, request: 0, value: 0, index, length: 1024 };
    let data = device.control_in(request, CONTROL_TIMEOUT).wait().ok()?;
    let fits = |n: usize| (14..=data.len()).contains(&n);
    let header = data.get(..2)?;
    let (be, le) = (usize::from(u16::from_be_bytes([header[0], header[1]])), usize::from(u16::from_le_bytes([header[0], header[1]])));
    let len = if fits(be) { be } else if fits(le) { le } else { data.len() };
    Some(String::from_utf8_lossy(&data[2..len]).trim_end_matches('\0').to_string())
}

fn port_request(interface: u8) -> ControlIn {
    ControlIn { control_type: ControlType::Class, recipient: Recipient::Interface, request: 1, value: 0, index: u16::from(interface), length: 1 }
}

pub(crate) fn status_from_port(byte: u8) -> PrinterStatus {
    if byte & PAPER_EMPTY != 0 {
        return PrinterStatus { state: PrinterState::Stopped, reasons: vec!["media-empty".into()], ..PrinterStatus::default() };
    }
    PrinterStatus { state: PrinterState::Idle, ..PrinterStatus::default() }
}

pub(crate) async fn enumerate() -> Vec<PrinterReport> {
    crate::convert::blocking(|| Ok(scan())).await.unwrap_or_default()
}

fn scan() -> Vec<PrinterReport> {
    let Ok(devices) = nusb::list_devices().wait() else { return Vec::new() };
    devices.filter_map(|info| printer_interface(&info).map(|n| report(&info, n))).collect()
}

fn report(info: &DeviceInfo, interface: u8) -> PrinterReport {
    let serial = info.serial_number().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let address = UsbAddress { vendor: info.vendor_id(), product: info.product_id(), serial, interface };
    let (id, status) = match info.open().wait() {
        Ok(device) => {
            let id = device_id(&device, interface).map(|raw| DeviceId::parse(&raw)).unwrap_or_default();
            let port = device.control_in(port_request(interface), CONTROL_TIMEOUT).wait().ok();
            (id, port.and_then(|p| p.first().copied()).map(status_from_port).unwrap_or_default())
        }
        Err(e) if e.kind() == ErrorKind::PermissionDenied => {
            (DeviceId::default(), PrinterStatus { message: Some(NO_PERMISSION.into()), ..PrinterStatus::default() })
        }
        Err(_) => (DeviceId::default(), PrinterStatus::default()),
    };
    let product = match (info.manufacturer_string(), info.product_string()) {
        (Some(m), Some(p)) if !p.to_ascii_lowercase().starts_with(&m.to_ascii_lowercase()) => Some(format!("{m} {p}")),
        (_, Some(p)) => Some(p.to_string()),
        (m, None) => m.map(str::to_string),
    };
    let make_model = id.make_model().or(product);
    PrinterReport {
        key: address.key(),
        name: make_model.clone().unwrap_or_else(|| "USB printer".into()),
        make_model,
        uuid: None,
        location: None,
        local: true,
        routes: vec![Route { kind: RouteKind::Usb, uri: address.uri() }],
        capabilities: Capabilities { formats: id.formats(), ..Capabilities::default() },
        status,
    }
}

fn unreachable_for(e: &nusb::Error) -> Error {
    Error::Unreachable(match e.kind() {
        ErrorKind::Busy => "The USB printer is in use by another program.".into(),
        ErrorKind::PermissionDenied => NO_PERMISSION.into(),
        _ => "Can't open the USB printer. Check the cable and that it's turned on.".into(),
    })
}

struct Claimed {
    device: nusb::Device,
    interface: Interface,
    endpoint: u8,
}

fn find(address: &UsbAddress) -> Result<DeviceInfo> {
    let missing = || Error::Unreachable("The USB printer isn't connected. Check the cable and that it's turned on.".into());
    nusb::list_devices()
        .wait()
        .map_err(|_| missing())?
        .find(|d| {
            d.vendor_id() == address.vendor
                && d.product_id() == address.product
                && address.serial.as_deref().is_none_or(|s| d.serial_number().map(str::trim) == Some(s))
        })
        .ok_or_else(missing)
}

fn open(address: &UsbAddress) -> Result<Claimed> {
    let device = find(address)?.open().wait().map_err(|e| unreachable_for(&e))?;
    let interface = device.detach_and_claim_interface(address.interface).wait().map_err(|e| unreachable_for(&e))?;
    let alt = alt_setting(&device, address.interface);
    if interface.get_alt_setting() != alt {
        interface.set_alt_setting(alt).wait().map_err(|e| unreachable_for(&e))?;
    }
    let endpoint = interface
        .descriptor()
        .and_then(|d| d.endpoints().find(|e| e.direction() == Direction::Out && e.transfer_type() == TransferType::Bulk).map(|e| e.address()))
        .ok_or_else(|| Error::Unsupported("This USB device has no way to receive print data.".into()))?;
    Ok(Claimed { device, interface, endpoint })
}

pub(crate) async fn send(uri: &str, payload: &Payload, cancel: &CancelFlag, on_event: Events<'_>) -> Result<()> {
    let address = UsbAddress::parse(uri)?;
    let number = address.interface;
    let Claimed { device, interface, endpoint } = crate::convert::blocking(move || open(&address)).await?;
    let result = match interface.endpoint::<Bulk, Out>(endpoint) {
        Ok(mut ep) => {
            on_event(PrintEvent::Printing { pages_done: None });
            let mut progress = Progress::new(on_event, cancel);
            transfer(&mut ep, &interface, payload, &mut progress).await
        }
        Err(e) => Err(unreachable_for(&e)),
    };
    drop(interface);
    // Give the device back to the kernel printer driver (usblp) that the claim detached.
    if cfg!(target_os = "linux") {
        let _ = device.attach_kernel_driver(number);
    }
    result
}

async fn transfer(ep: &mut Endpoint<Bulk, Out>, interface: &Interface, payload: &Payload, p: &mut Progress<'_>) -> Result<()> {
    for _ in 0..payload.repeat.max(1) {
        submit(ep, interface, &payload.prefix, p).await?;
        let mut file = tokio::fs::File::open(&payload.path).await?;
        loop {
            let mut chunk = vec![0u8; CHUNK];
            let n = file.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            chunk.truncate(n);
            submit(ep, interface, &chunk, p).await?;
        }
        submit(ep, interface, &payload.suffix, p).await?;
    }
    while ep.pending() > 0 {
        complete_one(ep, interface, p).await?;
    }
    Ok(())
}

async fn submit(ep: &mut Endpoint<Bulk, Out>, interface: &Interface, data: &[u8], p: &mut Progress<'_>) -> Result<()> {
    if data.is_empty() {
        return Ok(());
    }
    while ep.pending() >= IN_FLIGHT {
        complete_one(ep, interface, p).await?;
    }
    ep.submit(Buffer::from(data.to_vec()));
    Ok(())
}

async fn complete_one(ep: &mut Endpoint<Bulk, Out>, interface: &Interface, p: &mut Progress<'_>) -> Result<()> {
    loop {
        tokio::select! {
            done = ep.next_complete() => {
                return match done.status {
                    Ok(()) => {
                        p.moved(done.actual_len);
                        Ok(())
                    }
                    Err(_) => Err(p.failed()),
                };
            }
            _ = p.cancel.canceled() => {
                ep.cancel_all();
                return Err(Error::Canceled);
            }
            _ = tokio::time::sleep(STALL_NOTICE) => {
                let port = interface.control_in(port_request(interface.interface_number()), CONTROL_TIMEOUT).await.ok();
                let paper_out = port.and_then(|b| b.first().copied()).is_some_and(|b| b & PAPER_EMPTY != 0);
                p.stalled(if paper_out { "The printer is out of paper.".into() } else { super::STALLED.into() });
            }
        }
    }
}

/// Current state from GET_PORT_STATUS; unknown while another driver or job holds the interface.
pub(crate) async fn status(uri: &str) -> Result<PrinterStatus> {
    let address = UsbAddress::parse(uri)?;
    crate::convert::blocking(move || {
        let device = find(&address)?.open().wait().map_err(|e| unreachable_for(&e))?;
        let port = device.control_in(port_request(address.interface), CONTROL_TIMEOUT).wait().ok();
        Ok(port.and_then(|p| p.first().copied()).map(status_from_port).unwrap_or_default())
    })
    .await
}
