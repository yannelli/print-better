import Foundation
import Observation
import PrintBetterKit

/// The share sheet's state: whether this iPhone is paired, and the print it's preparing.
@Observable @MainActor
final class ShareModel {
    enum State {
        case loading
        case notPaired
        case ready(PrintSession)
    }

    private(set) var state = State.loading
    private let finish: @MainActor () -> Void

    init(finish: @escaping @MainActor () -> Void) {
        self.finish = finish
    }

    /// Opens the session from the shared Keychain item, then turns what was shared into a document.
    func start(with providers: [NSItemProvider]) async {
        guard let credentials = try? AppConfig.credentials.load() else {
            state = .notPaired
            return
        }
        let session = PrintSession(client: credentials.client)
        state = .ready(session)
        async let printers: Void = session.loadPrinters()
        await prepare(providers, in: session)
        await printers
    }

    private func prepare(_ providers: [NSItemProvider], in session: PrintSession) async {
        let incoming: URL
        let content: SharedContent
        do {
            incoming = try DocumentPreparer.workFolder()
        } catch {
            return session.report(error)
        }
        do {
            content = try await SharedContent.load(from: providers, into: incoming)
        } catch {
            try? FileManager.default.removeItem(at: incoming)
            return session.report(error)
        }
        let paper = session.paper
        await session.prepare { folder in
            defer { try? FileManager.default.removeItem(at: incoming) }
            return try await content.document(paper: paper, in: folder)
        }
    }

    func close() {
        if case let .ready(session) = state { session.startOver() }
        finish()
    }
}
