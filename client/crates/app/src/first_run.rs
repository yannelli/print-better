//! First run: open the pairing page once, so a double-click install leads straight to pairing.

use crate::fsx;
use crate::paths::Paths;

const MARKER: &str = "pairing-page-opened";

/// For a tray session finding the daemon unpaired: opens the page unless this account saw it before.
#[cfg(any(target_os = "macos", windows, all(target_os = "linux", feature = "tray-linux")))]
pub fn open_pairing_page_once() {
    let paths = Paths::resolve();
    if !paths.state.join(MARKER).exists() {
        remember(&paths);
        crate::platform::open_url(&crate::local::page_url());
    }
}

/// An explicit launch opens the page itself; this keeps the tray from opening a second one.
pub fn remember(paths: &Paths) {
    if let Err(e) = fsx::write_atomic(&paths.state.join(MARKER), b"", false) {
        log::warn!("could not remember that the pairing page was shown: {e}");
    }
}
