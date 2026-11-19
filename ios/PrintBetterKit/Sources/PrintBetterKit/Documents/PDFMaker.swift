import CoreGraphics
import Foundation

/// Writes JPEG files into a PDF, one per page, streaming to disk so long scans and photo sets fit in a share extension.
enum PDFMaker {
    /// `margin` in points: photos get a white border, scans fill the page edge to edge.
    static func pdf(fromJPEGs jpegs: [URL], paper: PaperSize, margin: Double, to destination: URL) throws {
        var mediaBox = paper.rect
        let info = [kCGPDFContextCreator: "Print Better"] as CFDictionary
        guard let context = CGContext(destination as CFURL, mediaBox: &mediaBox, info) else {
            throw PrintBetterError.message("The PDF can't be created.")
        }
        for jpeg in jpegs {
            // A JPEG-backed image goes into the PDF as is, without being decoded and compressed again.
            guard let provider = CGDataProvider(url: jpeg as CFURL),
                let image = CGImage(jpegDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
            else { throw PrintBetterError.message("A page can't be added to the PDF.") }
            let landscape = image.width > image.height
            var page = landscape ? CGRect(x: 0, y: 0, width: paper.height, height: paper.width) : paper.rect
            let box = Data(bytes: &page, count: MemoryLayout<CGRect>.size) as CFData
            context.beginPDFPage([kCGPDFContextMediaBox: box] as CFDictionary)
            context.draw(image, in: fitted(CGSize(width: image.width, height: image.height), in: page.insetBy(dx: margin, dy: margin)))
            context.endPDFPage()
        }
        context.closePDF()
    }

    static func fitted(_ size: CGSize, in frame: CGRect) -> CGRect {
        let scale = min(frame.width / size.width, frame.height / size.height)
        let fit = CGSize(width: size.width * scale, height: size.height * scale)
        return CGRect(x: frame.midX - fit.width / 2, y: frame.midY - fit.height / 2, width: fit.width, height: fit.height)
    }

    static func pageCount(of url: URL) -> Int? {
        CGPDFDocument(url as CFURL).map { $0.numberOfPages }
    }
}
