import Foundation

/// Talks to one Print Better server, as an unpaired device or with this device's `pbc_` token.
public struct APIClient: Sendable {
    public let server: ServerAddress
    let token: String?
    let session: URLSession

    public init(server: ServerAddress, token: String? = nil, session: URLSession = .shared) {
        self.server = server
        self.token = token
        self.session = session
    }

    func request(_ method: String, _ path: String, query: [URLQueryItem] = []) -> URLRequest {
        var request = URLRequest(url: server.url(path, query: query))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await send(request("GET", path, query: query))
    }

    func post<T: Decodable>(_ path: String, _ body: some Encodable) async throws -> T {
        var request = request("POST", path)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await send(request)
    }

    func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw PrintBetterError.transport(error, host: server.displayName)
        }
        return try decode(data, response)
    }

    func decode<T: Decodable>(_ data: Data, _ response: URLResponse) throws -> T {
        guard let http = response as? HTTPURLResponse else { throw PrintBetterError.badResponse }
        guard (200..<300).contains(http.statusCode) else { throw failure(data, status: http.statusCode) }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw PrintBetterError.badResponse
        }
    }

    private func failure(_ data: Data, status: Int) -> PrintBetterError {
        let detail = try? JSONDecoder().decode(ErrorEnvelope.self, from: data).error
        if status == 401, token != nil, detail?.code == "invalid_token" { return .revoked }
        guard let detail else {
            return .server(status: status, code: "http_\(status)", message: HTTPURLResponse.localizedString(forStatusCode: status))
        }
        return .server(status: status, code: detail.code, message: detail.message)
    }
}
