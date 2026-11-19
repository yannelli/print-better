import Foundation

/// `printbetter://pair?server=<origin>&token=pbe_…`: the QR code on the web app's Add a device page.
public struct PairingLink: Sendable, Equatable, Identifiable {
    public let server: ServerAddress
    /// A single-use `pbe_` enrollment token.
    public let pairingCode: String

    public var id: String { pairingCode }

    public init(server: ServerAddress, pairingCode: String) {
        self.server = server
        self.pairingCode = pairingCode
    }

    public init?(url: URL) {
        guard url.scheme?.lowercased() == "printbetter", url.host()?.lowercased() == "pair",
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
            let serverText = items.first(where: { $0.name == "server" })?.value,
            let token = items.first(where: { $0.name == "token" })?.value?.trimmingCharacters(in: .whitespaces),
            token.hasPrefix("pbe_"), token.count <= 200,
            let server = try? ServerAddress.parse(serverText)
        else { return nil }
        self.init(server: server, pairingCode: token)
    }

    public init?(string: String) {
        guard let url = URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        self.init(url: url)
    }

    public var url: URL {
        var components = URLComponents()
        components.scheme = "printbetter"
        components.host = "pair"
        components.queryItems = [URLQueryItem(name: "server", value: server.description), URLQueryItem(name: "token", value: pairingCode)]
        return components.url!
    }
}
