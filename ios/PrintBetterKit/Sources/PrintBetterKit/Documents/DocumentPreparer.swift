import Foundation
import UniformTypeIdentifiers

/// Copies or converts what someone picked into a `PrintDocument`. The work runs off the main actor.
public enum DocumentPreparer {
    static let unsupported = "Print Better can print PDFs, photos and text files. Save this as a PDF first, then print the PDF."

    /// A new empty folder for one document; delete it when the document is done.
    public static func workFolder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Print/\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    /// A file from Files, the share sheet or Shortcuts. The caller keeps any security scope open until this returns.
    public static func file(at source: URL, title: String? = nil, in folder: URL) async throws -> PrintDocument {
        let type = (try? source.resourceValues(forKeys: [.contentTypeKey]).contentType) ?? UTType(filenameExtension: source.pathExtension)
        let name = title ?? source.deletingPathExtension().lastPathComponent
        guard let type else { throw PrintBetterError.message(unsupported) }
        if type.conforms(to: .pdf) {
            let copy = try place(source, as: safeName(name, .pdf), in: folder)
            guard let pages = PDFMaker.pageCount(of: copy) else { throw PrintBetterError.message("This PDF can't be opened. It may be damaged or locked.") }
            return try PrintDocument(fileURL: copy, kind: .pdf, title: name, pageCount: pages)
        }
        if type.conforms(to: .image) { return try await images([source], title: name, in: folder) }
        if type.conforms(to: .plainText) {
            let copy = try place(source, as: safeName(name, .text), in: folder)
            return try PrintDocument(fileURL: copy, kind: .text, title: name, pageCount: nil)
        }
        throw PrintBetterError.message(unsupported)
    }

    /// One photo prints as a JPEG; several become one PDF with a photo on each page.
    public static func images(_ sources: [URL], title: String, paper: PaperSize = .regional(), in folder: URL) async throws -> PrintDocument {
        guard !sources.isEmpty else { throw PrintBetterError.message("Choose at least one photo.") }
        var jpegs: [URL] = []
        for (index, source) in sources.enumerated() {
            try Task.checkCancellation()
            let jpeg = folder.appending(path: "photo-\(index + 1).jpg")
            try ImageNormalizer.jpeg(from: source, to: jpeg)
            jpegs.append(jpeg)
        }
        if jpegs.count == 1 {
            let named = folder.appending(path: safeName(title, .jpeg))
            try FileManager.default.moveItem(at: jpegs[0], to: named)
            return try PrintDocument(fileURL: named, kind: .jpeg, title: title, pageCount: 1)
        }
        return try pdf(fromJPEGs: jpegs, title: title, paper: paper, margin: 18, in: folder)
    }

    /// Scanned pages fill the sheet edge to edge, like a photocopy.
    public static func scan(_ pages: [URL], title: String, paper: PaperSize = .regional(), in folder: URL) async throws -> PrintDocument {
        guard !pages.isEmpty else { throw PrintBetterError.message("The scan has no pages.") }
        return try pdf(fromJPEGs: pages, title: title, paper: paper, margin: 0, in: folder)
    }

    public static func text(_ text: String, title: String, in folder: URL) async throws -> PrintDocument {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw PrintBetterError.message("There's no text to print.") }
        let file = folder.appending(path: safeName(title, .text))
        try Data(text.utf8).write(to: file)
        return try PrintDocument(fileURL: file, kind: .text, title: title, pageCount: nil)
    }

    /// Where to write a PDF this app makes, such as a rendered web page, named after its title.
    public static func pdfFile(titled title: String, in folder: URL) -> URL {
        folder.appending(path: safeName(title, .pdf))
    }

    /// A PDF this app already wrote into `folder`, such as a rendered web page.
    public static func madePDF(_ file: URL, title: String) throws -> PrintDocument {
        guard let pages = PDFMaker.pageCount(of: file), pages > 0 else { throw PrintBetterError.message("The page couldn't be turned into a PDF.") }
        return try PrintDocument(fileURL: file, kind: .pdf, title: title, pageCount: pages)
    }

    private static func pdf(fromJPEGs jpegs: [URL], title: String, paper: PaperSize, margin: Double, in folder: URL) throws -> PrintDocument {
        let file = folder.appending(path: safeName(title, .pdf))
        try PDFMaker.pdf(fromJPEGs: jpegs, paper: paper, margin: margin, to: file)
        for jpeg in jpegs where jpeg.deletingLastPathComponent() == folder { try? FileManager.default.removeItem(at: jpeg) }
        return try PrintDocument(fileURL: file, kind: .pdf, title: title, pageCount: jpegs.count)
    }

    private static func place(_ source: URL, as name: String, in folder: URL) throws -> URL {
        let destination = folder.appending(path: name)
        if source.standardizedFileURL != destination.standardizedFileURL {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.copyItem(at: source, to: destination)
        }
        return destination
    }

    /// File names reach the server and print queues, so they stay short and free of path characters.
    static func safeName(_ title: String, _ kind: DocumentKind) -> String {
        let cleaned = title.components(separatedBy: CharacterSet(charactersIn: "/\\:?%*|\"<>\n\r\t")).joined(separator: " ")
        let trimmed = cleaned.trimmingCharacters(in: .whitespaces)
        return "\(trimmed.isEmpty ? "Document" : String(trimmed.prefix(80))).\(kind.fileExtension)"
    }
}
