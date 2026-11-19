import AppIntents
import Foundation
import PrintBetterKit
import UniformTypeIdentifiers

/// "Print with Print Better" in Shortcuts: sends a file to a printer without opening the app.
struct PrintIntent: AppIntent {
    static let title: LocalizedStringResource = "Print with Print Better"
    static var description: IntentDescription? {
        IntentDescription("Sends a PDF, photo or text file to a printer in your Print Better workspace.")
    }

    @Parameter(title: "File", supportedContentTypes: [.pdf, .image, .plainText])
    var file: IntentFile

    @Parameter(title: "Printer")
    var printer: PrinterEntity

    @Parameter(title: "Copies", default: 1, inclusiveRange: (1, 99))
    var copies: Int

    static var parameterSummary: some ParameterSummary {
        Summary("Print \(\.$file) on \(\.$printer)") { \.$copies }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let credentials = try AppConfig.credentials.load() else {
            throw PrintBetterError.message("Open Print Better and connect this \(ThisDevice.model) first.")
        }
        let folder = try DocumentPreparer.workFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let source: URL
        if let url = file.fileURL {
            source = url
        } else {
            source = folder.appending(path: "input-\(file.filename)")
            try file.data.write(to: source)
        }
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let title = (file.filename as NSString).deletingPathExtension
        let document = try await DocumentPreparer.file(at: source, title: title.isEmpty ? nil : title, in: folder)
        let options = JobOptions(copies: copies > 1 ? copies : nil)
        _ = try await credentials.client.submit(PrintRequest(printerId: printer.id, document: document, options: options))
        AppConfig.preferences.lastPrinterId = printer.id
        return .result(dialog: "Sent \(document.title) to \(printer.name).")
    }
}

struct PrinterEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Printer" }
    static let defaultQuery = PrinterQuery()

    let id: String
    let name: String
    let whereabouts: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(whereabouts)")
    }
}

struct PrinterQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [PrinterEntity] {
        await printers().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [PrinterEntity] {
        await printers()
    }

    /// The server's list when it answers, else the last list the app saw.
    private func printers() async -> [PrinterEntity] {
        var printers = AppConfig.preferences.printers
        if let credentials = try? AppConfig.credentials.load(), let fresh = try? await credentials.client.printers() {
            AppConfig.preferences.printers = fresh
            printers = fresh
        }
        return printers.map { PrinterEntity(id: $0.id, name: $0.name, whereabouts: $0.whereabouts) }
    }
}
