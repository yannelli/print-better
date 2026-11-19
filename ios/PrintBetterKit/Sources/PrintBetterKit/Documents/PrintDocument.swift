import Foundation
import UniformTypeIdentifiers

/// The formats the server accepts (`DOC_TYPES`).
public enum DocumentKind: String, Sendable, Codable, CaseIterable {
    case pdf, jpeg, png, text

    public var mimeType: String {
        switch self {
        case .pdf: "application/pdf"
        case .jpeg: "image/jpeg"
        case .png: "image/png"
        case .text: "text/plain"
        }
    }

    public var fileExtension: String {
        switch self {
        case .pdf: "pdf"
        case .jpeg: "jpg"
        case .png: "png"
        case .text: "txt"
        }
    }

    public var type: UTType {
        switch self {
        case .pdf: .pdf
        case .jpeg: .jpeg
        case .png: .png
        case .text: .plainText
        }
    }
}

/// A file ready to upload: already in a format the server takes, in this app's own folder.
public struct PrintDocument: Sendable, Equatable, Identifiable {
    public let id: UUID
    public let fileURL: URL
    public let kind: DocumentKind
    /// The job title people see in the web app and in print queues.
    public let title: String
    public let size: Int
    /// Known for PDFs; images are one page each.
    public let pageCount: Int?

    public init(fileURL: URL, kind: DocumentKind, title: String, pageCount: Int?) throws {
        let size = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size > 0 else { throw PrintBetterError.message("This document is empty.") }
        self.id = UUID()
        self.fileURL = fileURL
        self.kind = kind
        self.title = String(title.prefix(200))
        self.size = size
        self.pageCount = pageCount
    }

    public var fileName: String { fileURL.lastPathComponent }

    /// "3 pages, 1.2 MB" for the preview row.
    public var summary: String {
        let bytes = size.formatted(.byteCount(style: .file))
        guard let pageCount else { return bytes }
        return "\(pageCount) \(pageCount == 1 ? "page" : "pages"), \(bytes)"
    }

    /// Page ranges only mean something for PDFs.
    public var hasPages: Bool { kind == .pdf }
}
