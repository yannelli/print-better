import Foundation
import Observation
import PrintBetterKit

/// One print from start to finish: the document, the printer and its settings, the upload, then the live status.
@Observable @MainActor
final class PrintSession {
    enum Stage: Equatable {
        case editing
        case sending(Double)
        case sent(Job)
    }

    let client: APIClient
    private let preferences = AppConfig.preferences
    @ObservationIgnored private var following: Task<Void, Never>?
    @ObservationIgnored private var folder: URL?
    /// Called when the server says this iPhone was removed, so the app can offer to pair again.
    @ObservationIgnored var onRevoked: (@MainActor () -> Void)?

    private(set) var printers: [Printer]
    private(set) var printersError: String?
    private(set) var loadingPrinters = false
    private(set) var printerId: String?
    /// Only the settings someone changed; everything else follows the printer's defaults.
    var options = JobOptions()
    var pageRangesText = ""
    private(set) var document: PrintDocument?
    private(set) var preparing = false
    private(set) var stage = Stage.editing
    var error: String?

    init(client: APIClient) {
        self.client = client
        self.printers = AppConfig.preferences.printers
        pickPrinter()
    }

    var printer: Printer? { printers.first { $0.id == printerId } }

    func select(_ id: String?) {
        guard id != printerId else { return }
        printerId = id
        options = JobOptions()
    }

    func loadPrinters() async {
        loadingPrinters = true
        defer { loadingPrinters = false }
        do {
            printers = try await client.printers()
            preferences.printers = printers
            printersError = nil
            pickPrinter()
        } catch {
            if error is CancellationError { return }
            printersError = describe(error)
        }
    }

    /// Keeps the chosen printer while it's listed; otherwise the last one used, then the first one ready, then the first one online.
    private func pickPrinter() {
        if let printerId, printers.contains(where: { $0.id == printerId }) { return }
        let last = preferences.lastPrinterId
        let pick = printers.first { $0.id == last } ?? printers.first { $0.online && $0.state != .stopped }
            ?? printers.first { $0.online } ?? printers.first
        select(pick?.id)
    }

    // MARK: Settings as shown: what someone chose, else the printer's default, else a sensible start.

    var copies: Int { options.copies ?? printer?.defaults.copies ?? 1 }
    var maxCopies: Int { max(1, min(printer?.capabilities.copiesMax ?? 99, 999)) }
    var sides: Sides { options.sides ?? printer?.defaults.sides ?? .oneSided }
    var colorMode: ColorMode {
        if let chosen = options.colorMode { return chosen }
        return printer?.capabilities.color == true && printer?.defaults.colorMode != .monochrome ? .color : .monochrome
    }
    var media: String { options.media ?? printer?.defaults.media ?? printer?.capabilities.mediaDefault ?? printer?.capabilities.media.first ?? "" }
    var trays: [String] { printer?.capabilities.sources ?? [] }
    var tray: String { options.source ?? printer?.defaults.source ?? trays.first ?? "" }
    var paperTypes: [String] { (printer?.capabilities.mediaTypes ?? []).filter(OptionWords.isStandardPaperType) }
    var paperType: String { options.mediaType ?? printer?.defaults.mediaType ?? paperTypes.first ?? "" }
    var qualities: [Quality] { printer?.capabilities.qualities ?? Quality.allCases }
    var quality: Quality { options.quality ?? printer?.defaults.quality ?? .normal }
    var pageRangesValid: Bool { pageRangesText.allSatisfy(\.isWhitespace) || PageRanges.isValid(pageRangesText) }

    /// The paper this printer uses unless someone picks another, for laying out PDFs this app makes.
    var paper: PaperSize { PaperSize(pwg: media) ?? .regional() }

    var canSend: Bool {
        guard document != nil, printer != nil, pageRangesValid, !preparing else { return false }
        if case .sending = stage { return false }
        return true
    }

    // MARK: Documents

    /// Runs `make` off the main actor in a fresh folder, then shows the result.
    func prepare(_ make: @escaping @Sendable (URL) async throws -> PrintDocument) async {
        preparing = true
        error = nil
        defer { preparing = false }
        do {
            let folder = try DocumentPreparer.workFolder()
            do {
                use(try await make(folder), folder: folder)
            } catch {
                try? FileManager.default.removeItem(at: folder)
                throw error
            }
        } catch {
            report(error)
        }
    }

    func use(_ document: PrintDocument, folder: URL?) {
        clearDocument()
        self.document = document
        self.folder = folder
        pageRangesText = ""
    }

    func clearDocument() {
        if let folder { try? FileManager.default.removeItem(at: folder) }
        folder = nil
        document = nil
    }

    // MARK: Printing

    func send() async {
        guard canSend, let document, let printer else { return }
        var options = options
        if document.hasPages { options.pageRanges = PageRanges.normalized(pageRangesText) }
        stage = .sending(0)
        error = nil
        preferences.lastPrinterId = printer.id
        do {
            let job = try await client.submit(PrintRequest(printerId: printer.id, document: document, options: options)) { [weak self] fraction in
                Task { @MainActor [weak self] in self?.uploaded(fraction) }
            }
            stage = .sent(job)
            follow(job)
        } catch {
            stage = .editing
            report(error)
        }
    }

    private func uploaded(_ fraction: Double) {
        if case .sending = stage { stage = .sending(fraction) }
    }

    private func follow(_ job: Job) {
        following?.cancel()
        following = Task { [weak self, client] in
            do {
                for try await update in client.follow(jobId: job.id) {
                    guard let self else { return }
                    self.stage = .sent(update)
                }
            } catch {
                self?.report(error)
            }
        }
    }

    func cancelJob() async {
        guard case let .sent(job) = stage, job.canCancel else { return }
        do {
            stage = .sent(try await client.cancelJob(id: job.id))
        } catch {
            report(error)
        }
    }

    /// Back to an empty form for the next document; the sent job keeps going on the server.
    func startOver() {
        following?.cancel()
        following = nil
        stage = .editing
        error = nil
        clearDocument()
    }

    func report(_ error: any Error) {
        guard !(error is CancellationError) else { return }
        self.error = describe(error)
    }

    private func describe(_ error: any Error) -> String {
        if case PrintBetterError.revoked = error { onRevoked?() }
        return error.localizedDescription
    }
}
