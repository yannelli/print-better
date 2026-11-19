//! The tray icon, drawn in code so the exe needs no resource compiler.

use windows_sys::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject};
use windows_sys::Win32::UI::WindowsAndMessaging::{CreateIconIndirect, HICON, ICONINFO};

const SIZE: i32 = 32;
const INK: u32 = 0xFF33_373D;
const PAPER: u32 = 0xFFFF_FFFF;
const LIGHT: u32 = 0xFF22_C55E;

/// A 32x32 printer glyph: paper going in, the body, paper coming out, a green light.
pub fn create() -> HICON {
    let pixels: Vec<u32> = (0..SIZE * SIZE).map(|i| pixel(i % SIZE, i / SIZE).unwrap_or(0)).collect();
    // 1 bpp AND mask, rows padded to 16 bits: all zero, the alpha channel decides.
    let mask = vec![0u8; (SIZE * SIZE / 8) as usize];
    // SAFETY: both buffers match the declared sizes and outlive the calls; bitmaps are
    // copied into the icon and then released.
    unsafe {
        let color = CreateBitmap(SIZE, SIZE, 1, 32, pixels.as_ptr().cast());
        let and_mask = CreateBitmap(SIZE, SIZE, 1, 1, mask.as_ptr().cast());
        let info = ICONINFO { fIcon: 1, xHotspot: 0, yHotspot: 0, hbmMask: and_mask, hbmColor: color };
        let icon = CreateIconIndirect(&info);
        DeleteObject(color);
        DeleteObject(and_mask);
        icon
    }
}

fn pixel(x: i32, y: i32) -> Option<u32> {
    let inside = |x0: i32, y0: i32, x1: i32, y1: i32| (x0..=x1).contains(&x) && (y0..=y1).contains(&y);
    let sheet = |x0: i32, y0: i32, x1: i32, y1: i32| {
        let edge = x == x0 || x == x1 || y == y0 || y == y1;
        inside(x0, y0, x1, y1).then_some(if edge { INK } else { PAPER })
    };
    if inside(23, 13, 25, 15) {
        return Some(LIGHT);
    }
    sheet(9, 19, 22, 29).or_else(|| inside(3, 9, 28, 21).then_some(INK)).or_else(|| sheet(9, 2, 22, 9))
}
