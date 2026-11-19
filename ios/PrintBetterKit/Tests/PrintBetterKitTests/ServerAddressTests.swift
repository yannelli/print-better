import Foundation
import Testing

@testable import PrintBetterKit

struct ServerAddressTests {
    @Test(arguments: [
        ("your-print-better.example", "https://your-print-better.example"),
        ("  HTTPS://Your-Print-Better.example/w/abc?x=1  ", "https://your-print-better.example"),
        ("https://your-print-better.example:443/", "https://your-print-better.example"),
        ("your-print-better.example:8443", "https://your-print-better.example:8443"),
        ("http://localhost:5173", "http://localhost:5173"),
        ("http://127.0.0.1:8787/api", "http://127.0.0.1:8787"),
    ])
    func normalizesToTheOrigin(input: String, origin: String) throws {
        #expect(try ServerAddress.parse(input).description == origin)
    }

    @Test func refusesWhatTheDesktopClientRefuses() {
        #expect(throws: ServerAddressError.empty) { try ServerAddress.parse("   ") }
        #expect(throws: ServerAddressError.unsupportedScheme) { try ServerAddress.parse("ftp://your-print-better.example") }
        #expect(throws: ServerAddressError.insecure) { try ServerAddress.parse("http://your-print-better.example") }
        #expect(throws: ServerAddressError.userName) { try ServerAddress.parse("https://me@your-print-better.example") }
        #expect(throws: ServerAddressError.missingHost) { try ServerAddress.parse("https:///path") }
        #expect(throws: ServerAddressError.invalid) { try ServerAddress.parse("your print better") }
        #expect(throws: ServerAddressError.invalid) { try ServerAddress.parse("your-print-better.example:99999") }
    }

    @Test func showsHostAndPortAndBuildsURLs() throws {
        let local = try ServerAddress.parse("http://localhost:5173")
        #expect(local.displayName == "localhost:5173")
        #expect(local.url("/api/client/jobs", query: [URLQueryItem(name: "limit", value: "5")]).absoluteString == "http://localhost:5173/api/client/jobs?limit=5")
        #expect(try ServerAddress.parse("your-print-better.example").displayName == "your-print-better.example")
    }

    @Test func roundTripsThroughJSON() throws {
        let address = try ServerAddress.parse("your-print-better.example")
        let data = try JSONEncoder().encode(address)
        #expect(String(decoding: data, as: UTF8.self) == "\"https:\\/\\/your-print-better.example\"")
        #expect(try JSONDecoder().decode(ServerAddress.self, from: data) == address)
    }
}

struct PairingLinkTests {
    @Test func readsTheQRCodeFromTheAddDevicePage() throws {
        let scanned = "printbetter://pair?server=https%3A%2F%2Fyour-print-better.example&token=pbe_abc123"
        let link = try #require(PairingLink(string: scanned))
        #expect(link.server.description == "https://your-print-better.example")
        #expect(link.pairingCode == "pbe_abc123")
        #expect(PairingLink(url: link.url) == link)
    }

    @Test(arguments: [
        "https://your-print-better.example/pair?server=https%3A%2F%2Fx.example&token=pbe_1",
        "printbetter://pair?server=https%3A%2F%2Fyour-print-better.example&token=pbc_device",
        "printbetter://pair?server=http%3A%2F%2Fyour-print-better.example&token=pbe_1",
        "printbetter://other?server=https%3A%2F%2Fyour-print-better.example&token=pbe_1",
        "printbetter://pair?token=pbe_1",
        "not a link",
    ])
    func ignoresAnythingElse(text: String) {
        #expect(PairingLink(string: text) == nil)
    }
}
