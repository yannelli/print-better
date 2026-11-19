import Foundation
import Observation
import PrintBetterKit

enum AppTab: Hashable {
    case print, printers, jobs, settings
}

/// Whether this iPhone is paired, and the state every tab shares.
@Observable @MainActor
final class AppModel {
    private(set) var credentials: Credentials?
    private(set) var identity: ClientIdentity?
    private(set) var session: PrintSession?
    /// A pairing link from a QR code or the Camera app, waiting for someone to confirm it.
    var pendingLink: PairingLink?
    var selectedTab = AppTab.print
    /// The server stopped accepting this iPhone's token.
    var revoked = false
    var keychainError: String?

    init() {
        do {
            if let saved = try AppConfig.credentials.load() { start(saved) }
        } catch {
            keychainError = error.localizedDescription
        }
        identity = AppConfig.preferences.identity
    }

    func paired(_ credentials: Credentials) throws {
        try AppConfig.credentials.save(credentials)
        AppConfig.preferences.clear()
        identity = nil
        selectedTab = .print
        start(credentials)
    }

    private func start(_ credentials: Credentials) {
        self.credentials = credentials
        revoked = false
        let session = PrintSession(client: credentials.client)
        session.onRevoked = { [weak self] in self?.revoked = true }
        self.session = session
    }

    func open(_ url: URL) {
        if let link = PairingLink(url: url) { pendingLink = link }
    }

    func refreshIdentity() async {
        guard let client = credentials?.client else { return }
        do {
            let identity = try await client.identity()
            self.identity = identity
            AppConfig.preferences.identity = identity
        } catch PrintBetterError.revoked {
            revoked = true
        } catch {
            // Settings keeps showing the last names it knew.
        }
    }

    /// Forgets the token on this iPhone. The web app keeps listing it until someone removes it there.
    func unpair() {
        session?.startOver()
        try? AppConfig.credentials.clear()
        AppConfig.preferences.clear()
        credentials = nil
        identity = nil
        session = nil
        revoked = false
    }
}
