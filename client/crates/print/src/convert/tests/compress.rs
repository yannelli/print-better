use super::decode::{ascii85, undelta, unpackbits};
use super::noise;
use crate::convert::raster::compress::{Ascii85, delta_row, dither_row, luma, pack_pixels, packbits};

/// Decodes one PWG/URF line body (no repeat byte) of `pixels` pixels.
fn unpack_pixels(src: &[u8], unit: usize, pixels: usize) -> Vec<u8> {
    let (mut out, mut i) = (Vec::new(), 0);
    while out.len() < pixels * unit {
        let code = usize::from(src[i]);
        i += 1;
        if code < 0x80 {
            (0..=code).for_each(|_| out.extend_from_slice(&src[i..i + unit]));
            i += unit;
        } else {
            let n = (257 - code) * unit;
            out.extend_from_slice(&src[i..i + n]);
            i += n;
        }
    }
    assert_eq!(i, src.len(), "trailing bytes");
    out
}

#[test]
fn pack_pixels_round_trips_and_never_emits_0x80() {
    for (unit, seed) in [(1, 1), (3, 2), (1, 3), (3, 4)] {
        let line = noise(3000 * unit, seed);
        let mut packed = Vec::new();
        pack_pixels(&line, unit, &mut packed);
        assert_eq!(unpack_pixels(&packed, unit, 3000), line, "unit {unit}");
        let mut codes = Vec::new();
        let mut i = 0;
        while i < packed.len() {
            let code = usize::from(packed[i]);
            codes.push(code);
            i += 1 + if code < 0x80 { unit } else { (257 - code) * unit };
        }
        assert!(!codes.contains(&0x80), "0x80 means fill-with-white, so it must never be a count");
    }
}

#[test]
fn pack_pixels_handles_long_runs_and_single_pixels() {
    let mut packed = Vec::new();
    pack_pixels(&[7; 300], 1, &mut packed);
    assert_eq!(packed, [127, 7, 127, 7, 43, 7]);
    packed.clear();
    pack_pixels(&[9], 1, &mut packed);
    assert_eq!(packed, [0, 9]);
}

#[test]
fn packbits_round_trips() {
    for seed in 1..6 {
        let data = noise(5000, seed);
        let mut packed = Vec::new();
        packbits(&data, &mut packed);
        assert_eq!(unpackbits(&packed), data, "seed {seed}");
        assert!(packed.len() <= data.len() + data.len().div_ceil(128), "worst case bound");
    }
    let mut packed = Vec::new();
    packbits(&[], &mut packed);
    assert!(packed.is_empty());
}

#[test]
fn delta_row_round_trips_against_the_seed() {
    let rows = [noise(1200, 1), noise(1200, 1), noise(1200, 2), vec![0xFF; 1200], vec![0; 1200]];
    let mut encoder_seed = vec![0u8; 1200];
    let mut decoder_seed = vec![0u8; 1200];
    for (i, row) in rows.iter().enumerate() {
        let mut out = Vec::new();
        delta_row(row, &mut encoder_seed, &mut out);
        undelta(&out, &mut decoder_seed);
        assert_eq!(&decoder_seed, row, "row {i}");
        assert_eq!(&encoder_seed, row, "encoder seed follows the row");
        if i == 1 {
            assert!(out.is_empty(), "an unchanged row costs nothing");
        }
    }
}

#[test]
fn delta_row_encodes_long_offsets() {
    let seed_row = vec![0u8; 1000];
    let mut row = seed_row.clone();
    for at in [0, 40, 400, 999] {
        row[at] = 1;
    }
    let (mut seed, mut out) = (seed_row.clone(), Vec::new());
    delta_row(&row, &mut seed, &mut out);
    // Offsets 39, 359, and 598 need extension bytes: 31+8, 31+255+73, 31+255+255+57.
    assert_eq!(out, [0, 1, 31, 8, 1, 31, 255, 73, 1, 31, 255, 255, 57, 1]);
    let mut decoded = seed_row;
    undelta(&out, &mut decoded);
    assert_eq!(decoded, row);
}

#[test]
fn ascii85_round_trips_with_z_groups_and_short_tails() {
    for len in [0, 1, 2, 3, 4, 5, 8, 9, 1000] {
        let mut data = noise(len, len as u32 + 7);
        if len >= 8 {
            data[4..8].fill(0);
        }
        let mut a = Ascii85::new();
        a.push(&data);
        a.finish();
        assert!(a.text.ends_with(b"~>\n"));
        assert_eq!(ascii85(&a.text), data, "len {len}");
        if len >= 8 {
            assert!(a.text.contains(&b'z'), "zero group collapses to z");
        }
        for line in a.text.split(|&c| c == b'\n') {
            assert!(line.len() <= 80 && line.first() != Some(&b'%'), "line {:?}", String::from_utf8_lossy(line));
        }
    }
}

#[test]
fn dither_uses_black_and_white_points() {
    let mut bits = Vec::new();
    dither_row(&[0, 40, 56, 0, 40, 56, 30, 10], 0, &mut bits);
    assert_eq!(bits, [0xFF], "dark gray prints solid");
    for y in 0..8 {
        dither_row(&[240, 250, 255, 245, 241, 255, 255, 240], y, &mut bits);
        assert_eq!(bits, [0], "near white prints as paper");
    }
    let mut black = 0;
    for y in 0..8 {
        dither_row(&[148; 64], y, &mut bits);
        black += bits.iter().map(|b| b.count_ones()).sum::<u32>();
    }
    assert!((240..=272).contains(&black), "mid gray covers about half: {black}/512");
}

#[test]
fn luma_weights() {
    assert_eq!(luma(0, 0, 0), 0);
    assert_eq!(luma(255, 255, 255), 255);
    assert!(luma(0, 255, 0) > luma(255, 0, 0) && luma(255, 0, 0) > luma(0, 0, 255));
}
