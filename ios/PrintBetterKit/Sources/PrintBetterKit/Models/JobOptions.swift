import Foundation

public enum Sides: String, Codable, Sendable, CaseIterable {
    case oneSided = "one-sided"
    case twoSidedLongEdge = "two-sided-long-edge"
    case twoSidedShortEdge = "two-sided-short-edge"
}

public enum ColorMode: String, Codable, Sendable, CaseIterable {
    case auto, color, monochrome
}

public enum Orientation: String, Codable, Sendable, CaseIterable {
    case auto, portrait, landscape
}

public enum Fit: String, Codable, Sendable, CaseIterable {
    case fit, fill
    case actualSize = "none"
}

public enum Quality: String, Codable, Sendable, CaseIterable {
    case draft, normal, high
}

/// Print settings for one job. A nil field follows the printer's defaults.
public struct JobOptions: Codable, Sendable, Hashable {
    public var copies: Int?
    public var media: String?
    public var sides: Sides?
    public var colorMode: ColorMode?
    public var orientation: Orientation?
    public var pageRanges: String?
    public var fit: Fit?
    public var quality: Quality?
    public var source: String?
    public var mediaType: String?

    public init(
        copies: Int? = nil, media: String? = nil, sides: Sides? = nil, colorMode: ColorMode? = nil, orientation: Orientation? = nil,
        pageRanges: String? = nil, fit: Fit? = nil, quality: Quality? = nil, source: String? = nil, mediaType: String? = nil
    ) {
        self.copies = copies
        self.media = media
        self.sides = sides
        self.colorMode = colorMode
        self.orientation = orientation
        self.pageRanges = pageRanges
        self.fit = fit
        self.quality = quality
        self.source = source
        self.mediaType = mediaType
    }

    /// Values this app doesn't know are dropped, so they keep following the printer instead of breaking the list.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func keyword<T: RawRepresentable>(_ key: CodingKeys) -> T? where T.RawValue == String {
            (try? c.decodeIfPresent(String.self, forKey: key)).flatMap(T.init(rawValue:))
        }
        copies = try? c.decodeIfPresent(Int.self, forKey: .copies)
        media = try? c.decodeIfPresent(String.self, forKey: .media)
        sides = keyword(.sides)
        colorMode = keyword(.colorMode)
        orientation = keyword(.orientation)
        pageRanges = try? c.decodeIfPresent(String.self, forKey: .pageRanges)
        fit = keyword(.fit)
        quality = keyword(.quality)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        mediaType = try? c.decodeIfPresent(String.self, forKey: .mediaType)
    }

    public var isEmpty: Bool { self == JobOptions() }
}
