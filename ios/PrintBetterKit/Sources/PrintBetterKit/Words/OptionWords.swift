import Foundation

/// Names for print settings, matching the web app's print form and the Mac print dialog.
public enum OptionWords {
    private static let paper: [String: String] = [
        "na_letter": "Letter", "na_legal": "Legal", "na_ledger": "Tabloid", "na_executive": "Executive",
        "na_index-4x6": "4 × 6 in photo", "na_5x7": "5 × 7 in photo", "na_govt-letter": "Government letter",
        "na_number-10": "#10 envelope", "na_invoice": "Statement", "iso_a3": "A3", "iso_a4": "A4", "iso_a5": "A5",
        "iso_a6": "A6", "iso_b5": "B5", "iso_dl": "DL envelope", "iso_c5": "C5 envelope", "jis_b5": "JIS B5",
        "om_small-photo": "Small photo",
    ]

    /// `na_letter_8.5x11in` becomes "Letter (8.5 × 11 in)".
    public static func paperName(_ media: String) -> String {
        guard let match = media.wholeMatch(of: #/([a-z]+_[^_]+)_(.+?)(in|mm)/#) else { return media }
        let size = "\(match.2.replacingOccurrences(of: "x", with: " × ")) \(match.3)"
        if let name = paper[String(match.1)] { return name.contains("×") ? name : "\(name) (\(size))" }
        let label = match.1.split(separator: "_").last.map { $0.replacingOccurrences(of: "-", with: " ") } ?? String(match.1)
        return "\(label.prefix(1).uppercased())\(label.dropFirst()) (\(size))"
    }

    private static let trays: [String: String] = [
        "auto": "Automatic", "main": "Main tray", "manual": "Manual feed", "by-pass-tray": "Bypass tray",
        "envelope": "Envelope feeder", "photo": "Photo tray", "rear": "Rear tray", "top": "Top tray", "middle": "Middle tray",
        "bottom": "Bottom tray", "side": "Side tray", "large-capacity": "High-capacity tray", "alternate": "Alternate tray",
        "disc": "Disc tray", "main-roll": "Main roll", "alternate-roll": "Alternate roll",
    ]

    /// IPP `media-source` keywords: `tray-2` becomes "Tray 2".
    public static func trayName(_ keyword: String) -> String {
        trays[keyword] ?? pretty(keyword)
    }

    private static let paperTypes: [String: String] = [
        "auto": "Automatic", "stationery": "Plain paper", "stationery-letterhead": "Letterhead",
        "stationery-heavyweight": "Heavy paper", "stationery-lightweight": "Light paper", "stationery-recycled": "Recycled paper",
        "stationery-inkjet": "Inkjet paper", "stationery-coated": "Coated paper", "stationery-preprinted": "Preprinted paper",
        "stationery-prepunched": "Hole-punched paper", "stationery-colored": "Colored paper", "photographic": "Photo paper",
        "photographic-glossy": "Glossy photo paper", "photographic-high-gloss": "High-gloss photo paper",
        "photographic-semi-gloss": "Semi-gloss photo paper", "photographic-satin": "Satin photo paper",
        "photographic-matte": "Matte photo paper", "labels": "Labels", "envelope": "Envelope", "cardstock": "Card stock",
        "transparency": "Transparency", "continuous": "Continuous paper",
    ]

    /// IPP `media-type` keywords: `photographic-glossy` becomes "Glossy photo paper".
    public static func paperTypeName(_ keyword: String) -> String {
        paperTypes[keyword] ?? pretty(keyword)
    }

    /// Vendor types such as `com.hp.ecosmart-lite` have no readable name, so the app leaves them out like CUPS does.
    public static func isStandardPaperType(_ keyword: String) -> Bool { !keyword.contains(".") }

    public static func sidesName(_ sides: Sides) -> String {
        switch sides {
        case .oneSided: "One side"
        case .twoSidedLongEdge: "Both sides, like a book"
        case .twoSidedShortEdge: "Both sides, flip up"
        }
    }

    public static func qualityName(_ quality: Quality) -> String {
        switch quality {
        case .draft: "Draft"
        case .normal: "Normal"
        case .high: "Best"
        }
    }

    public static func colorName(_ mode: ColorMode) -> String {
        switch mode {
        case .auto: "Automatic"
        case .color: "Color"
        case .monochrome: "Black and white"
        }
    }

    private static func pretty(_ keyword: String) -> String {
        let words = keyword.replacingOccurrences(of: "-", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}

/// The `pageRanges` option: "1-3,5". Same rule as the server.
public enum PageRanges {
    public static func isValid(_ text: String) -> Bool {
        text.count <= 100 && text.wholeMatch(of: #/\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*/#) != nil
    }

    /// Nil for blank input, which means every page.
    public static func normalized(_ text: String) -> String? {
        let compact = text.filter { !$0.isWhitespace }
        return compact.isEmpty ? nil : compact
    }
}
