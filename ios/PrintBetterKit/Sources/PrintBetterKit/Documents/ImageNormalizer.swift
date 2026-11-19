import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Turns any image (HEIC, PNG, a 48 MP photo) into an upright JPEG a printer can take, without decoding it at full size.
enum ImageNormalizer {
    /// About 300 dpi on a Letter or A4 page; bigger only costs memory and upload time.
    static let maxPixels = 3600

    static func jpeg(from source: URL, to destination: URL) throws {
        guard let input = CGImageSourceCreateWithURL(source as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else {
            throw PrintBetterError.message("This image can't be opened.")
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard var image = CGImageSourceCreateThumbnailAtIndex(input, 0, options as CFDictionary) else {
            throw PrintBetterError.message("This image can't be read.")
        }
        if hasAlpha(image) { image = try flattened(image) }
        guard let output = CGImageDestinationCreateWithURL(destination as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw PrintBetterError.message("This image can't be saved for printing.")
        }
        CGImageDestinationAddImage(output, image, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
        guard CGImageDestinationFinalize(output) else { throw PrintBetterError.message("This image can't be saved for printing.") }
    }

    private static func hasAlpha(_ image: CGImage) -> Bool {
        switch image.alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast: false
        default: true
        }
    }

    /// Transparent areas print white instead of black.
    private static func flattened(_ image: CGImage) throws -> CGImage {
        let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        guard
            let context = CGContext(
                data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { throw PrintBetterError.message("This image can't be prepared for printing.") }
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(rect)
        context.draw(image, in: rect)
        guard let flat = context.makeImage() else { throw PrintBetterError.message("This image can't be prepared for printing.") }
        return flat
    }
}
