use crate::convert::place::{Affine, Fitting, Scaling, place};
use crate::model::{Fit, Orientation};

fn how(scaling: Scaling, orientation: Orientation, margin: f64) -> Fitting {
    Fitting { scaling, orientation, margin }
}

fn close(a: (f64, f64), b: (f64, f64)) -> bool {
    (a.0 - b.0).abs() < 1e-6 && (a.1 - b.1).abs() < 1e-6
}

/// Where the content's corners land, as a bounding box (left, top, right, bottom).
fn bounds(m: Affine, content: (f64, f64)) -> (f64, f64, f64, f64) {
    let corners = [(0.0, 0.0), (content.0, 0.0), (0.0, content.1), content].map(|(x, y)| m.apply(x, y));
    let xs = corners.map(|c| c.0);
    let ys = corners.map(|c| c.1);
    let min = |v: [f64; 4]| v.iter().copied().fold(f64::MAX, f64::min);
    let max = |v: [f64; 4]| v.iter().copied().fold(f64::MIN, f64::max);
    (min(xs), min(ys), max(xs), max(ys))
}

#[test]
fn fit_scales_up_and_centers() {
    let m = place((100.0, 50.0), (200.0, 300.0), &how(Scaling::Fit, Orientation::Portrait, 0.0));
    assert!(close(m.apply(0.0, 0.0), (0.0, 100.0)));
    assert!(close(m.apply(100.0, 50.0), (200.0, 200.0)));
}

#[test]
fn fit_keeps_margins() {
    let b = bounds(place((100.0, 100.0), (200.0, 300.0), &how(Scaling::Fit, Orientation::Portrait, 10.0)), (100.0, 100.0));
    assert!((b.0 - 10.0).abs() < 1e-6 && (b.2 - 190.0).abs() < 1e-6, "{b:?}");
}

#[test]
fn fill_covers_the_paper() {
    let b = bounds(place((100.0, 50.0), (200.0, 300.0), &how(Scaling::Fill, Orientation::Portrait, 0.0)), (100.0, 50.0));
    assert!(b.0 <= 0.0 && b.1 <= 0.0 && b.2 >= 200.0 && b.3 >= 300.0, "{b:?}");
    assert!(((b.2 - b.0) / (b.3 - b.1) - 2.0).abs() < 1e-6, "aspect kept");
}

#[test]
fn none_is_actual_size_centered() {
    let b = bounds(place((100.0, 50.0), (200.0, 300.0), &how(Scaling::None, Orientation::Portrait, 0.0)), (100.0, 50.0));
    assert_eq!(b, (50.0, 125.0, 150.0, 175.0));
}

#[test]
fn shrink_only_reduces() {
    let small = how(Scaling::Shrink, Orientation::Portrait, 0.0);
    let b = bounds(place((100.0, 50.0), (200.0, 300.0), &small), (100.0, 50.0));
    assert_eq!((b.2 - b.0, b.3 - b.1), (100.0, 50.0));
    let b = bounds(place((400.0, 100.0), (200.0, 300.0), &small), (400.0, 100.0));
    assert!(((b.2 - b.0) - 200.0).abs() < 1e-6 && ((b.3 - b.1) - 50.0).abs() < 1e-6, "{b:?}");
}

#[test]
fn auto_rotates_landscape_content_onto_portrait_paper() {
    let content = (300.0, 100.0);
    let m = place(content, (100.0, 300.0), &how(Scaling::Fit, Orientation::Auto, 0.0));
    let b = bounds(m, content);
    assert!(((b.2 - b.0) - 100.0).abs() < 1e-6 && ((b.3 - b.1) - 300.0).abs() < 1e-6, "{b:?}");
    // A counter-clockwise quarter turn puts the content's top-left corner at the bottom-left.
    assert!(close(m.apply(0.0, 0.0), (0.0, 300.0)), "{:?}", m.apply(0.0, 0.0));
}

#[test]
fn auto_leaves_matching_and_square_content_alone() {
    let m = place((100.0, 300.0), (100.0, 300.0), &how(Scaling::Fit, Orientation::Auto, 0.0));
    assert!(close(m.apply(0.0, 0.0), (0.0, 0.0)));
    let m = place((100.0, 100.0), (100.0, 300.0), &how(Scaling::Fit, Orientation::Auto, 0.0));
    assert!(close(m.apply(0.0, 0.0), (0.0, 100.0)));
}

#[test]
fn explicit_orientation_wins() {
    let portrait = place((300.0, 100.0), (100.0, 300.0), &how(Scaling::None, Orientation::Portrait, 0.0));
    assert_eq!(bounds(portrait, (300.0, 100.0)), (-100.0, 100.0, 200.0, 200.0));
    let landscape = place((100.0, 300.0), (100.0, 300.0), &how(Scaling::None, Orientation::Landscape, 0.0));
    let b = bounds(landscape, (100.0, 300.0));
    assert_eq!((b.2 - b.0, b.3 - b.1), (300.0, 100.0), "turned even though it fits upright");
}

#[test]
fn affine_composes_and_inverts() {
    let m = Affine::scale(2.0, 3.0).then(Affine::translate(5.0, -1.0));
    assert!(close(m.apply(1.0, 1.0), (7.0, 2.0)));
    let back = m.invert().expect("invertible");
    assert!(close(back.apply(7.0, 2.0), (1.0, 1.0)));
    assert!(Affine::scale(0.0, 1.0).invert().is_none());
}

#[test]
fn scaling_defaults_differ_for_documents_and_images() {
    assert_eq!(Scaling::from(None, true), Scaling::Shrink);
    assert_eq!(Scaling::from(None, false), Scaling::Fit);
    assert_eq!(Scaling::from(Some(Fit::Fill), true), Scaling::Fill);
    assert_eq!(Scaling::from(Some(Fit::None), false), Scaling::None);
    assert_eq!(Scaling::from(Some(Fit::Fit), true), Scaling::Fit);
}
