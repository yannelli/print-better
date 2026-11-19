import Foundation
import PrintBetterKit
import UniformTypeIdentifiers

/// What another app shared, copied out of the share sheet so it no longer depends on its item providers.
enum SharedContent: Sendable {
    case page(PageSnapshot)
    case file(URL, title: String?)
    case images([URL])
    case text(String)

    static let unsupported = "Print Better can print PDFs, photos, text and web pages."
    static let maxImages = 20

    /// Picks the most faithful form: Safari's page snapshot, then a PDF, photos, a web link, and plain text last.
    @MainActor
    static func load(from providers: [NSItemProvider], into folder: URL) async throws -> SharedContent {
        if let page = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) }),
            let snapshot = await page.pageSnapshot()
        {
            return .page(snapshot)
        }
        if let pdf = providers.first(where: { $0.conforms(to: .pdf) }) {
            return .file(try await pdf.copyFile(conformingTo: .pdf, into: folder), title: pdf.suggestedName)
        }
        let images = providers.filter { $0.conforms(to: .image) }.prefix(maxImages)
        if !images.isEmpty {
            var files: [URL] = []
            for image in images { files.append(try await image.copyFile(conformingTo: .image, into: folder)) }
            return .images(files)
        }
        if let link = providers.first(where: { $0.conforms(to: .url) && !$0.conforms(to: .fileURL) }),
            let url = await link.load(URL.self), url.scheme == "https" || url.scheme == "http"
        {
            return .page(PageSnapshot(url: url, title: url.host() ?? "Web page", html: nil))
        }
        if let text = providers.first(where: { $0.conforms(to: .plainText) }) {
            if let string = await text.load(String.self) { return .text(string) }
            return .file(try await text.copyFile(conformingTo: .plainText, into: folder), title: text.suggestedName)
        }
        throw PrintBetterError.message(unsupported)
    }

    func document(paper: PaperSize, in folder: URL) async throws -> PrintDocument {
        switch self {
        case let .page(snapshot):
            return try await WebPagePDF.make(snapshot, paper: paper, in: folder)
        case let .file(url, title):
            return try await DocumentPreparer.file(at: url, title: title, in: folder)
        case let .images(files):
            return try await DocumentPreparer.images(files, title: files.count == 1 ? "Photo" : "\(files.count) Photos", paper: paper, in: folder)
        case let .text(string):
            let firstLine = string.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
            return try await DocumentPreparer.text(string, title: firstLine.isEmpty ? "Text" : String(firstLine.prefix(60)), in: folder)
        }
    }
}

@MainActor
extension NSItemProvider {
    func conforms(to type: UTType) -> Bool {
        registeredTypeIdentifiers.contains { UTType($0)?.conforms(to: type) == true }
    }

    /// Copies the file while the share sheet's temporary copy still exists; it's deleted when the handler returns.
    func copyFile(conformingTo type: UTType, into folder: URL) async throws -> URL {
        let identifier = registeredTypeIdentifiers.first { UTType($0)?.conforms(to: type) == true } ?? type.identifier
        return try await withCheckedThrowingContinuation { continuation in
            _ = loadFileRepresentation(forTypeIdentifier: identifier) { url, error in
                guard let url else {
                    continuation.resume(throwing: error ?? PrintBetterError.message("The shared file couldn't be opened."))
                    return
                }
                let copy = folder.appending(path: "\(UUID().uuidString).\(url.pathExtension)")
                continuation.resume(with: Result { try FileManager.default.copyItem(at: url, to: copy) }.map { copy })
            }
        }
    }

    func load<T: _ObjectiveCBridgeable & Sendable>(_ type: T.Type) async -> T? where T._ObjectiveCType: NSItemProviderReading {
        guard canLoadObject(ofClass: type) else { return nil }
        return await withCheckedContinuation { continuation in
            _ = loadObject(ofClass: type) { value, _ in continuation.resume(returning: value) }
        }
    }

    /// The result of Preprocess.js, which Safari passes as a property list.
    func pageSnapshot() async -> PageSnapshot? {
        await withCheckedContinuation { continuation in
            loadItem(forTypeIdentifier: UTType.propertyList.identifier) { item, _ in
                let results = (item as? NSDictionary)?[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any]
                guard let address = results?["url"] as? String, let url = URL(string: address) else {
                    continuation.resume(returning: nil)
                    return
                }
                let title = (results?["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? url.host() ?? "Web page"
                continuation.resume(returning: PageSnapshot(url: url, title: title, html: results?["html"] as? String))
            }
        }
    }
}
