use super::decode::{self, be32, expand_bits, find};
use super::{encode, noise, settings};
use crate::convert::Media;
use crate::convert::raster::compress::dither_row;
use crate::convert::raster::{Encoding, PageSetup, Settings};
use crate::model::{Quality, Sides};

/// A page with blank lines, repeated lines, and noisy lines, so every line code is exercised.
fn page(width: u32, height: u32, dpi: u32, color: bool) -> (PageSetup, Vec<u8>) {
    let setup = PageSetup { width, height, dpi, color };
    let len = setup.row_bytes();
    let rows = (0..height).flat_map(|y| if y % 5 < 2 { vec![255; len] } else { noise(len, y / 5 + 1) }).collect();
    (setup, rows)
}

fn media(width: f64, height: f64) -> Media {
    Media { name: "custom_test_media".into(), width, height }
}

/// What a 1-bit encoder should produce for 8-bit gray rows, expanded back to gray.
fn dithered(rows: &[u8], width: usize, from: usize, to: usize) -> Vec<u8> {
    let mut bits = Vec::new();
    rows.chunks(width)
        .enumerate()
        .flat_map(|(y, row)| {
            dither_row(&row[from..to], y as u32, &mut bits);
            expand_bits(&bits, to - from, bits.len())
        })
        .collect()
}

#[test]
fn pwg_decodes_back_with_header_fields() {
    for color in [false, true] {
        let p = page(37, 23, 72, color);
        let s = Settings { media: media(37.0, 23.0), sides: Sides::TwoSidedShortEdge, quality: Some(Quality::High), bilevel: false };
        let (bytes, total) = encode(Encoding::Pwg, s, 2, std::slice::from_ref(&p));
        assert_eq!(total, 2);
        let pages = decode::pwg(&bytes);
        assert_eq!(pages.len(), 2, "copies repeat the page");
        for (decoded, h) in &pages {
            assert_eq!((decoded.width, decoded.height, decoded.dpi), (37, 23, 72));
            assert_eq!(decoded.data, p.1, "lossless");
            assert_eq!(&h[..10], b"PwgRaster\0");
            let fields: Vec<u32> = [272, 276, 280, 352, 356, 368, 384, 388, 400, 420, 484].iter().map(|&o| be32(h, o)).collect();
            let (bpp, space, colors) = if color { (24, 19, 3) } else { (8, 18, 1) };
            assert_eq!(fields, [1, 72, 72, 37, 23, 1, 8, bpp, space, colors, 5]);
            assert!(h[1732..].starts_with(b"custom_test_media\0"));
        }
    }
}

#[test]
fn pwg_black_1_is_dithered_and_unnamed_when_size_differs() {
    let p = page(37, 23, 72, false);
    let s = Settings { bilevel: true, ..settings(Media::letter()) };
    let (bytes, _) = encode(Encoding::Pwg, s, 1, std::slice::from_ref(&p));
    let pages = decode::pwg(&bytes);
    let (decoded, h) = &pages[0];
    assert_eq!((be32(h, 384), be32(h, 388), be32(h, 392), be32(h, 400)), (1, 1, 5, 3));
    assert_eq!(decoded.data, dithered(&p.1, 37, 0, 37));
    assert_eq!(h[1732], 0, "a Letter name on a 37x23 pt page would be wrong");
}

#[test]
fn urf_counts_all_copies_and_decodes_back() {
    for color in [false, true] {
        let pages = [page(41, 17, 300, color), page(41, 9, 300, color)];
        let (bytes, total) = encode(Encoding::Urf, settings(media(9.84, 4.08)), 3, &pages);
        assert_eq!(total, 6);
        let (count, decoded) = decode::urf(&bytes);
        assert_eq!((count, decoded.len()), (6, 6), "header count is patched after copies");
        for (i, (d, h)) in decoded.iter().enumerate() {
            let source = &pages[i % 2];
            assert_eq!((d.width, d.height, d.dpi), (41, source.0.height as usize, 300));
            assert_eq!(d.data, source.1, "page {i}");
            assert_eq!(&h[..5], &[if color { 24 } else { 8 }, u8::from(color), 1, 4, 1]);
        }
    }
}

#[test]
fn pcl_mono_is_packbits_inside_the_logical_page() {
    let p = page(100, 40, 72, false);
    let s = Settings { bilevel: true, ..settings(Media::letter()) };
    let (bytes, total) = encode(Encoding::Pcl, s, 2, std::slice::from_ref(&p));
    assert_eq!(total, 2);
    assert!(bytes.starts_with(b"\x1bE\x1b&l2A") && bytes.ends_with(b"\x1bE"), "reset, Letter, reset");
    assert!(find(&bytes, b"\x1b*t72R\x1b*r64S\x1b*r40T\x1b*r1A\x1b*b2M", 0).is_some(), "inset 18 px each side");
    let pages = decode::pcl(&bytes);
    assert_eq!(pages.len(), 2);
    for d in &pages {
        assert_eq!((d.width, d.height, d.channels, d.dpi), (64, 40, 1, 72));
        assert_eq!(d.data, dithered(&p.1, 100, 18, 82));
    }
}

#[test]
fn pcl_color_is_delta_rows_and_lossless() {
    let p = page(100, 40, 72, true);
    let (bytes, _) = encode(Encoding::Pcl, settings(Media::a4()), 2, std::slice::from_ref(&p));
    assert!(find(&bytes, b"\x1b*v6W\x00\x03\x00\x08\x08\x08\x1b*r1A\x1b*b3M", 0).is_some());
    assert!(find(&bytes, b"\x1b&l26A", 0).is_some(), "A4 page size");
    let inset = 17;
    let expected: Vec<u8> = p.1.chunks(300).flat_map(|row| row[inset * 3..(100 - inset) * 3].to_vec()).collect();
    for d in decode::pcl(&bytes) {
        assert_eq!((d.width, d.height, d.channels), (66, 40, 3));
        assert_eq!(d.data, expected, "each page restarts from a zero seed row");
    }
}

#[test]
fn pcl_skips_the_inset_on_tiny_pages() {
    let p = page(40, 4, 72, false);
    let (bytes, _) = encode(Encoding::Pcl, Settings { bilevel: true, ..settings(Media::letter()) }, 1, std::slice::from_ref(&p));
    assert_eq!(decode::pcl(&bytes)[0].width, 40);
}

#[test]
fn postscript_is_dsc_structured_and_decodes_back() {
    for color in [false, true] {
        let pages = [page(23, 11, 150, color), page(23, 7, 150, color)];
        let s = Settings { sides: Sides::TwoSidedLongEdge, ..settings(Media::letter()) };
        let (bytes, total) = encode(Encoding::PostScript, s, 2, &pages);
        assert_eq!(total, 4);
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.starts_with("%!PS-Adobe-3.0\n") && text.contains("%%Pages: (atend)"));
        assert!(text.contains("<< /PageSize [612 792] /Duplex true /Tumble false >> setpagedevice"));
        assert!(text.ends_with("%%Trailer\n%%Pages: 4\n%%EOF\n"));
        assert_eq!(text.matches("restore showpage").count(), 4);
        let decoded = decode::ps(&bytes);
        assert_eq!(decoded.len(), 4);
        for (i, d) in decoded.iter().enumerate() {
            let source = &pages[i % 2];
            assert_eq!((d.width, d.height, d.channels), (23, source.0.height as usize, if color { 3 } else { 1 }));
            assert_eq!(d.data, source.1, "page {i}");
        }
    }
}
