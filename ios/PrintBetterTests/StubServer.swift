import Foundation
import PrintBetterKit

/// A pretend Print Better server: answers requests from a table, keyed by method and path.
final class StubServer: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) private static var answers: [String: (status: Int, body: String)] = [:]
    private static let lock = NSLock()

    static func client(_ answers: [String: (status: Int, body: String)]) -> APIClient {
        lock.withLock { Self.answers = answers }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubServer.self]
        return APIClient(server: try! ServerAddress.parse("your-print-better.example"), token: "pbc_test", session: URLSession(configuration: config))
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let key = "\(request.httpMethod ?? "GET") \(request.url?.path() ?? "")"
        guard let answer = Self.lock.withLock({ Self.answers[key] }), let url = request.url else {
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

enum Fixtures {
    static let printers = """
        {"printers":[
        {"id":"pr_1","name":"Hall laser","clientName":"Office Mac","online":false,"state":"idle",
        "capabilities":{"color":false,"duplex":true,"media":["na_letter_8.5x11in"],"copiesMax":5},"defaults":{"copies":2}},
        {"id":"pr_2","name":"Studio inkjet","clientName":"Studio Pi","online":true,"state":"idle",
        "capabilities":{"color":true,"duplex":false,"media":["iso_a4_210x297mm","na_letter_8.5x11in"],"mediaDefault":"iso_a4_210x297mm"},
        "defaults":{}}]}
        """

    static func job(_ status: String, message: String? = nil) -> String {
        let note = message.map { "\"\($0)\"" } ?? "null"
        return """
            {"id":"job_1","printerId":"pr_2","printerName":"Studio inkjet","title":"Note","contentType":"text/plain","size":5,\
            "options":{},"status":"\(status)","statusMessage":\(note),"pages":1,"createdAt":1,"updatedAt":2,"completedAt":null}
            """
    }
}
