import Foundation

public enum ServerAddressError: Error, Equatable, Sendable, LocalizedError {
    case empty, unsupportedScheme, userName, missingHost, insecure, invalid

    public var errorDescription: String? {
        switch self {
        case .empty: "Enter the address of your Print Better server."
        case .unsupportedScheme: "The address must start with https://."
        case .userName: "The address can't contain a user name."
        case .missingHost: "The address is missing a host name."
        case .insecure: "Use https://. Plain http:// only works for localhost."
        case .invalid: "That isn't a web address. Check it and try again."
        }
    }
}

/// A Print Better server's origin. Plain http is allowed only for loopback, like the desktop client.
public struct ServerAddress: Sendable, Hashable, Codable, CustomStringConvertible {
    public let origin: URL

    public init(origin: URL) {
        self.origin = origin
    }

    /// Accepts `your-print-better.example`, `https://…`, or a full URL; the path, query and fragment are dropped.
    public static func parse(_ input: String) throws(ServerAddressError) -> ServerAddress {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw .empty }
        let lower = text.lowercased()
        let secure: Bool
        let rest: Substring
        if lower.hasPrefix("https://") {
            (secure, rest) = (true, text.dropFirst(8))
        } else if lower.hasPrefix("http://") {
            (secure, rest) = (false, text.dropFirst(7))
        } else if text.contains("://") {
            throw .unsupportedScheme
        } else {
            (secure, rest) = (true, Substring(text))
        }
        let authority = rest.prefix { !"/?#".contains($0) }.lowercased()
        guard !authority.contains("@") else { throw .userName }
        let (host, port) = try split(authority)
        guard !host.isEmpty else { throw .missingHost }
        guard host.allSatisfy({ $0.isLetter || $0.isNumber || "-.[]:".contains($0) }) else { throw .invalid }
        let loopback = host == "localhost" || host == "[::1]" || host.hasPrefix("127.")
        guard secure || loopback else { throw .insecure }
        let defaultPort = secure ? 443 : 80
        let suffix = port.map { $0 == defaultPort ? "" : ":\($0)" } ?? ""
        guard let url = URL(string: "\(secure ? "https" : "http")://\(host)\(suffix)"), url.host() != nil else { throw .invalid }
        return ServerAddress(origin: url)
    }

    private static func split(_ authority: String) throws(ServerAddressError) -> (String, Int?) {
        let closing = authority.hasPrefix("[") ? authority.firstIndex(of: "]") : nil
        let searchFrom = closing ?? authority.startIndex
        guard let colon = authority[searchFrom...].lastIndex(of: ":") else { return (authority, nil) }
        guard let port = Int(authority[authority.index(after: colon)...]), (1...65535).contains(port) else { throw .invalid }
        return (String(authority[..<colon]), port)
    }

    /// The host and any port, as people type it: `your-print-better.example`.
    public var displayName: String {
        var name = origin.host(percentEncoded: false) ?? origin.absoluteString
        if let port = origin.port { name += ":\(port)" }
        return name
    }

    public var description: String { origin.absoluteString }

    public func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var url = origin.appending(path: path)
        if !query.isEmpty { url.append(queryItems: query) }
        return url
    }

    public init(from decoder: any Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        do {
            self = try ServerAddress.parse(text)
        } catch {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a server address: \(text)"))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(origin.absoluteString)
    }
}
