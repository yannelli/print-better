import Foundation
import PrintBetterKit

@testable import PrintBetter
import Testing

/// The print form's rules: which printer it starts on, which settings it shows, and when it can send.
@MainActor @Suite(.serialized)
struct PrintSessionTests {
    init() {
        AppConfig.preferences.clear()
    }

    private func session(_ answers: [String: (status: Int, body: String)]) async -> PrintSession {
        let session = PrintSession(client: StubServer.client(answers))
        await session.loadPrinters()
        return session
    }

    private func note() async throws -> PrintDocument {
        try await DocumentPreparer.text("Hello", title: "Note", in: try DocumentPreparer.workFolder())
    }

    @Test func startsOnTheLastPrinterUsed() async {
        AppConfig.preferences.lastPrinterId = "pr_1"
        let session = await session(["GET /api/client/printers": (200, Fixtures.printers)])
        #expect(session.printerId == "pr_1")
    }

    @Test func otherwiseStartsOnTheFirstPrinterOnline() async {
        let session = await session(["GET /api/client/printers": (200, Fixtures.printers)])
        #expect(session.printerId == "pr_2")
        #expect(AppConfig.preferences.printers.count == 2)
    }

    @Test func showsThePrintersDefaultsUntilSomeoneChangesThem() async {
        AppConfig.preferences.lastPrinterId = "pr_1"
        let session = await session(["GET /api/client/printers": (200, Fixtures.printers)])
        #expect(session.copies == 2)
        #expect(session.maxCopies == 5)
        #expect(session.colorMode == .monochrome)
        session.options.copies = 3
        #expect(session.copies == 3)
        session.select("pr_2")
        #expect(session.options.isEmpty)
        #expect(session.colorMode == .color)
        #expect(session.media == "iso_a4_210x297mm")
        #expect(abs(session.paper.width - PaperSize.a4.width) < 0.1)
    }

    @Test func sendsOnlyWithADocumentAPrinterAndValidPages() async throws {
        let session = await session(["GET /api/client/printers": (200, Fixtures.printers)])
        #expect(!session.canSend)
        let document = try await note()
        session.use(document, folder: document.fileURL.deletingLastPathComponent())
        #expect(session.canSend)
        session.pageRangesText = "two"
        #expect(!session.pageRangesValid)
        session.pageRangesText = " "
        #expect(session.pageRangesValid)
        session.clearDocument()
        #expect(!FileManager.default.fileExists(atPath: document.fileURL.path()))
    }

    @Test func followsTheJobUntilItPrints() async throws {
        let session = await session([
            "GET /api/client/printers": (200, Fixtures.printers),
            "POST /api/client/jobs": (201, #"{"job":\#(Fixtures.job("uploading")),"uploadUrl":"https://your-print-better.example/x"}"#),
            "PUT /api/client/jobs/job_1/file": (200, #"{"job":\#(Fixtures.job("queued"))}"#),
            "GET /api/client/jobs/job_1": (200, #"{"job":\#(Fixtures.job("completed", message: "Paper is low"))}"#),
        ])
        let document = try await note()
        session.use(document, folder: document.fileURL.deletingLastPathComponent())
        await session.send()
        #expect(AppConfig.preferences.lastPrinterId == "pr_2")
        for _ in 0..<50 where session.sentJob?.status != .completed {
            try await Task.sleep(for: .milliseconds(100))
        }
        let job = try #require(session.sentJob)
        #expect(job.status(printer: session.printer).label == "Printed with a problem")
        #expect(job.status(printer: session.printer).detail == "Paper is low")
        session.startOver()
        #expect(session.stage == .editing && session.document == nil)
    }

    @Test func explainsARefusalInPlainWords() async throws {
        let refusal = #"{"error":{"code":"printer_access_denied","message":"Not allowed"}}"#
        let session = await session(["GET /api/client/printers": (200, Fixtures.printers), "POST /api/client/jobs": (403, refusal)])
        let document = try await note()
        session.use(document, folder: document.fileURL.deletingLastPathComponent())
        await session.send()
        #expect(session.stage == .editing)
        #expect(session.error == "You can't print to this printer from this iPhone.")
    }

    @Test func tellsTheAppWhenThisIPhoneWasRemoved() async {
        let removed = Flag()
        let session = PrintSession(client: StubServer.client(["GET /api/client/printers": (401, #"{"error":{"code":"invalid_token","message":"Unknown"}}"#)]))
        session.onRevoked = { removed.raised = true }
        await session.loadPrinters()
        #expect(removed.raised)
        #expect(session.printersError == PrintBetterError.revoked.localizedDescription)
    }
}

@MainActor
final class Flag {
    var raised = false
}

extension PrintSession {
    var sentJob: Job? {
        if case let .sent(job) = stage { job } else { nil }
    }
}
