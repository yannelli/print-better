//! USB printer-class devices: the frozen enumerator and `usb://VVVV:PPPP/SERIAL?if=N` addresses.

use crate::model::PrinterReport;
#[cfg(not(windows))]
use {
    super::{percent_decode, percent_encode},
    crate::error::{Error, Result},
};

#[cfg(not(windows))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UsbAddress {
    pub vendor: u16,
    pub product: u16,
    pub serial: Option<String>,
    pub interface: u8,
}

#[cfg(not(windows))]
impl UsbAddress {
    pub fn parse(uri: &str) -> Result<UsbAddress> {
        let bad = || Error::Unsupported(format!("The USB printer address \"{uri}\" isn't valid."));
        let rest = uri.strip_prefix("usb://").ok_or_else(bad)?;
        let (ids, rest) = rest.split_once('/').unwrap_or((rest, ""));
        let (serial, query) = rest.split_once('?').unwrap_or((rest, ""));
        let (vendor, product) = ids.split_once(':').ok_or_else(bad)?;
        let hex = |s: &str| u16::from_str_radix(s, 16).map_err(|_| bad());
        let interface = query
            .split('&')
            .find_map(|kv| kv.strip_prefix("if="))
            .map_or(Ok(0), |n| n.parse::<u8>().map_err(|_| bad()))?;
        let serial = percent_decode(serial);
        let serial = (!serial.is_empty() && serial != "-").then_some(serial);
        Ok(UsbAddress { vendor: hex(vendor)?, product: hex(product)?, serial, interface })
    }

    pub fn uri(&self) -> String {
        let serial = self.serial.as_deref().map_or_else(|| "-".to_string(), percent_encode);
        format!("usb://{:04X}:{:04X}/{serial}?if={}", self.vendor, self.product, self.interface)
    }

    /// Inventory key, stable across reconnects: `usb:<vid>:<pid>:<serial>`.
    pub fn key(&self) -> String {
        format!("usb:{:04x}:{:04x}:{}", self.vendor, self.product, self.serial.as_deref().unwrap_or("-"))
    }
}

/// USB printer-class devices attached to this machine, with `usb://` routes and
/// capabilities inferred from the IEEE 1284 Device ID. Called by discovery.
pub async fn enumerate() -> Vec<PrinterReport> {
    #[cfg(not(windows))]
    {
        super::usb_io::enumerate().await
    }
    // Windows binds printers to usbprint.sys; they are reached through the spooler instead.
    #[cfg(windows)]
    {
        Vec::new()
    }
}
