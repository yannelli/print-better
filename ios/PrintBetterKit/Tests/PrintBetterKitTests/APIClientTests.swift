import Foundation
import Testing

@testable import PrintBetterKit

/// Answers requests from a table, so the client is tested without a network.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    struct Answer: Sendable {
        var status: Int
        var body: String
    }

    nonisolated(unsafe) static var answers: [String: Answer] = [:]
    nonisolated(unsafe) static var seen: [URLRequest] = []
    static let lock = NSLock()

    static func session(_ answers: [String: Answer]) -> URLSession {
        lock.withLock {
            Self.answers = answers
            Self.seen = []
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let key = "\(request.httpMethod ?? "GET") \(request.url?.path() ?? "")"
        let answer = Self.lock.withLock {
            Self.seen.append(request)
            return Self.answers[key]
        }
        guard let answer, let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(answer.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Suite(.serialized)
struct APIClientTests {
    let server = try! ServerAddress.parse("your-print-better.example")

    @Test func sendsTheDeviceTokenAndDecodesPrinters() async throws {
        let session = StubProtocol.session(["GET /api/client/printers": .init(status: 200, body: printersJSON)])
        let printers = try await APIClient(server: server, token: "pbc_secret", session: session).printers()
        #expect(printers.count == 2)
        let request = try #require(StubProtocol.lock.withLock { StubProtocol.seen.first })
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer pbc_secret")
    }

    @Test func turnsServerErrorsIntoPlainWords() async throws {
        let refusal = #"{"error":{"code":"printer_access_denied","message":"You can't print to this printer from this computer"}}"#
        let session = StubProtocol.session(["GET /api/client/jobs/job_1": .init(status: 403, body: refusal)])
        let client = APIClient(server: server, token: "pbc_secret", session: session)
        await #expect(throws: PrintBetterError.server(status: 403, code: "printer_access_denied", message: "You can't print to this printer from this computer")) {
            try await client.job(id: "job_1")
        }
        let error = PrintBetterError.server(status: 403, code: "printer_access_denied", message: "")
        #expect(error.localizedDescription == "You can't print to this printer from this iPhone.")
        let blocked = PrintBetterError.server(status: 403, code: "policy_blocked", message: "Color printing is off on weekends")
        #expect(blocked.localizedDescription == "Color printing is off on weekends")
        let costCenter = PrintBetterError.server(status: 400, code: "cost_center_invalid", message: "The cost center Marketing is turned off")
        #expect(costCenter.localizedDescription == "The cost center Marketing is turned off")
    }

    @Test func reportsARemovedDeviceAsRevoked() async throws {
        let session = StubProtocol.session(["GET /api/client/me": .init(status: 401, body: #"{"error":{"code":"invalid_token","message":"Unknown"}}"#)])
        await #expect(throws: PrintBetterError.revoked) { try await APIClient(server: server, token: "pbc_old", session: session).identity() }
    }

    @Test func saysWhenTheServerCantBeReached() async throws {
        let session = StubProtocol.session([:])
        await #expect(throws: PrintBetterError.unreachable(host: "your-print-better.example")) {
            try await APIClient(server: server, session: session).instance()
        }
    }

    @Test func uploadsTheFileToThisServerOnly() async throws {
        let folder = try DocumentPreparer.workFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let document = try await DocumentPreparer.text("Hello", title: "Note", in: folder)
        let job = #"{"id":"job_9","printerId":"pr_07","printerName":"Upstairs laser","title":"Note","contentType":"text/plain","size":5,"options":{},"status":"uploading","statusMessage":null,"pages":null,"createdAt":1,"updatedAt":1,"completedAt":null}"#
        let session = StubProtocol.session([
            "POST /api/client/jobs": .init(status: 201, body: #"{"job":\#(job),"uploadUrl":"https://elsewhere.example/api/client/jobs/job_9/file"}"#),
            "PUT /api/client/jobs/job_9/file": .init(status: 200, body: #"{"job":\#(job.replacingOccurrences(of: "uploading", with: "queued"))}"#),
        ])
        let client = APIClient(server: server, token: "pbc_secret", session: session)
        let queued = try await client.submit(PrintRequest(printerId: "pr_07", document: document, options: JobOptions(copies: 2)))
        #expect(queued.status == .queued)
        let requests = StubProtocol.lock.withLock { StubProtocol.seen }
        #expect(requests.map { $0.url?.host() } == ["your-print-better.example", "your-print-better.example"])
        #expect(requests[1].value(forHTTPHeaderField: "Content-Type") == "text/plain")
    }
}
