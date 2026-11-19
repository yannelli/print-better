import CoreGraphics
import Foundation

/// A sheet size in PostScript points, used to lay out PDFs this app makes.
public struct PaperSize: Sendable, Equatable {
    public var width: Double
    public var height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }

    public static let letter = PaperSize(width: 612, height: 792)
    public static let a4 = PaperSize(width: 595.28, height: 841.89)

    /// Reads the size from a PWG media name such as `na_letter_8.5x11in` or `iso_a4_210x297mm`.
    public init?(pwg: String) {
        guard let match = pwg.wholeMatch(of: #/[a-z0-9]+_[^_]+_([0-9.]+)x([0-9.]+)(in|mm)/#),
            let w = Double(match.1), let h = Double(match.2), w > 0, h > 0
        else { return nil }
        let scale = match.3 == "in" ? 72.0 : 72.0 / 25.4
        self.init(width: min(w, h) * scale, height: max(w, h) * scale)
    }

    /// Letter where it is the norm, A4 everywhere else.
    public static func regional(_ locale: Locale = .current) -> PaperSize {
        let letterRegions: Set = ["US", "CA", "MX", "PH", "CL", "CO", "VE", "CR", "GT", "DO", "PA", "PR", "SV", "NI", "HN", "BZ"]
        return letterRegions.contains(locale.region?.identifier ?? "") ? .letter : .a4
    }

    public var rect: CGRect { CGRect(x: 0, y: 0, width: width, height: height) }
}
