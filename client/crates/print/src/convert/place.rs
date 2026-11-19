//! Where page content lands on the paper: orientation, scaling, and centering.

use crate::model::{Fit, Orientation};

/// 2D affine map in kurbo's coefficient order: x' = a·x + c·y + e, y' = b·x + d·y + f.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Affine(pub [f64; 6]);

impl Affine {
    pub const IDENTITY: Affine = Affine([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    pub fn translate(x: f64, y: f64) -> Affine {
        Affine([1.0, 0.0, 0.0, 1.0, x, y])
    }

    pub fn scale(sx: f64, sy: f64) -> Affine {
        Affine([sx, 0.0, 0.0, sy, 0.0, 0.0])
    }

    /// `self` applied first, then `next`.
    pub fn then(self, next: Affine) -> Affine {
        let [a, b, c, d, e, f] = self.0;
        let [na, nb, nc, nd, ne, nf] = next.0;
        Affine([
            na * a + nc * b,
            nb * a + nd * b,
            na * c + nc * d,
            nb * c + nd * d,
            na * e + nc * f + ne,
            nb * e + nd * f + nf,
        ])
    }

    pub fn invert(self) -> Option<Affine> {
        let [a, b, c, d, e, f] = self.0;
        let det = a * d - b * c;
        if det.abs() < 1e-12 {
            return None;
        }
        Some(Affine([d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]))
    }

    pub fn apply(self, x: f64, y: f64) -> (f64, f64) {
        let [a, b, c, d, e, f] = self.0;
        (a * x + c * y + e, b * x + d * y + f)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Scaling {
    Fit,
    Fill,
    /// Actual size.
    None,
    /// Actual size unless that overflows the paper, then fit.
    Shrink,
}

impl Scaling {
    /// The requested fit; without one, documents only shrink to fit and images fit the paper.
    pub fn from(fit: Option<Fit>, document: bool) -> Scaling {
        match fit {
            Some(Fit::Fit) => Scaling::Fit,
            Some(Fit::Fill) => Scaling::Fill,
            Some(Fit::None) => Scaling::None,
            None if document => Scaling::Shrink,
            None => Scaling::Fit,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Fitting {
    pub scaling: Scaling,
    pub orientation: Orientation,
    /// Blank border kept when fitting, in points.
    pub margin: f64,
}

/// Maps content of `content` points (y down) onto paper of `media` points (y down).
pub(crate) fn place(content: (f64, f64), media: (f64, f64), how: &Fitting) -> Affine {
    let (cw, ch) = (content.0.max(1.0), content.1.max(1.0));
    let (mw, mh) = media;
    let landscape_content = cw > ch * 1.01;
    let landscape_media = mw > mh * 1.01;
    let rotate = match how.orientation {
        Orientation::Portrait => false,
        Orientation::Landscape => !landscape_media,
        // Square content or paper gains nothing from a turn.
        Orientation::Auto => landscape_content != landscape_media && (cw - ch).abs() > ch * 0.01 && (mw - mh).abs() > mh * 0.01,
    };
    // A quarter turn counter-clockwise, as IPP defines landscape.
    let turn = if rotate { Affine([0.0, -1.0, 1.0, 0.0, 0.0, cw]) } else { Affine::IDENTITY };
    let (rw, rh) = if rotate { (ch, cw) } else { (cw, ch) };
    let (aw, ah) = ((mw - 2.0 * how.margin).max(1.0), (mh - 2.0 * how.margin).max(1.0));
    let fit = (aw / rw).min(ah / rh);
    let s = match how.scaling {
        Scaling::Fit => fit,
        Scaling::Fill => (mw / rw).max(mh / rh),
        Scaling::None => 1.0,
        Scaling::Shrink => fit.min(1.0),
    };
    turn.then(Affine::scale(s, s)).then(Affine::translate((mw - s * rw) / 2.0, (mh - s * rh) / 2.0))
}
