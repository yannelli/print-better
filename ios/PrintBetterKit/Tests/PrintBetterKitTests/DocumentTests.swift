import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import PrintBetterKit

struct DocumentTests {
    /// A tall PNG with transparency and an EXIF-free orientation, like a screenshot.
    static func png(width: Int, height: Int, in folder: URL) throws -> URL {
        let context = try #require(
            CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 0.1, green: 0.4, blue: 0.9, alpha: 0.5))
        context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height))
        let url = folder.appending(path: "shot-\(width)x\(height).png")
        let destination = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try #require(context.makeImage()), nil)
        #expect(CGImageDestinationFinalize(destination))
        return url
    }

    static func pixelSize(_ url: URL) throws -> (Int, Int) {
        let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        return (properties[kCGImagePropertyPixelWidth] as? Int ?? 0, properties[kCGImagePropertyPixelHeight] as? Int ?? 0)
    }

    @Test func oneImageBecomesAnOpaqueJPEGNoBiggerThanNeeded() async throws {
        let folder = try DocumentPreparer.workFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let document = try await DocumentPreparer.images([try Self.png(width: 1200, height: 5000, in: folder)], title: "Screenshot", in: folder)
        #expect(document.kind == .jpeg)
        #expect(document.fileName == "Screenshot.jpg")
        #expect(try Self.pixelSize(document.fileURL) == (864, 3600))
    }

    @Test func severalImagesBecomeOnePDFPagePerImage() async throws {
        let folder = try DocumentPreparer.workFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let images = [try Self.png(width: 300, height: 200, in: folder), try Self.png(width: 200, height: 300, in: folder)]
        let document = try await DocumentPreparer.images(images, title: "2 photos", paper: .letter, in: folder)
        #expect(document.kind == .pdf)
        #expect(document.pageCount == 2)
        let pdf = try #require(CGPDFDocument(document.fileURL as CFURL))
        #expect(pdf.page(at: 1)?.getBoxRect(.mediaBox).size == CGSize(width: 792, height: 612), "a wide photo gets a landscape page")
        #expect(pdf.page(at: 2)?.getBoxRect(.mediaBox).size == CGSize(width: 612, height: 792))
        #expect(document.summary.hasPrefix("2 pages, "))
    }

    @Test func filesKeepTheirFormatAndRefuseOthers() async throws {
        let folder = try DocumentPreparer.workFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let note = folder.appending(path: "Shopping list.txt")
        try Data("Milk\nEggs\n".utf8).write(to: note)
        let text = try await DocumentPreparer.file(at: note, in: folder)
        #expect(text.kind == .text && text.title == "Shopping list" && text.size == 10)

        let scan = try await DocumentPreparer.scan([try Self.png(width: 100, height: 100, in: folder)].map { png in
            let jpeg = folder.appending(path: "page.jpg")
            try ImageNormalizer.jpeg(from: png, to: jpeg)
            return jpeg
        }, title: "Receipt", paper: .a4, in: folder)
        let pdf = try await DocumentPreparer.file(at: scan.fileURL, title: "Receipt copy", in: folder)
        #expect(pdf.kind == .pdf && pdf.pageCount == 1 && pdf.fileName == "Receipt copy.pdf")

        let zip = folder.appending(path: "Archive.zip")
        try Data([0x50, 0x4b, 0x03, 0x04]).write(to: zip)
        await #expect(throws: PrintBetterError.message(DocumentPreparer.unsupported)) { try await DocumentPreparer.file(at: zip, in: folder) }
        await #expect(throws: PrintBetterError.self) { try await DocumentPreparer.text("  \n", title: "Empty", in: folder) }
    }

    @Test func fileNamesStaySafe() {
        #expect(DocumentPreparer.safeName("Q3/Q4: plan?", .pdf) == "Q3 Q4  plan.pdf")
        #expect(DocumentPreparer.safeName("   ", .text) == "Document.txt")
    }
}
