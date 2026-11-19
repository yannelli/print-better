import Observation
import PrintBetterKit
import UIKit

/// Pairs this iPhone by signing in on the server's approval page, or with a pairing code from a QR code.
@Observable @MainActor
final class PairingModel {
    enum Phase: Equatable {
        case idle
        case checking
        case waiting(DeviceCode)
        case connecting
    }

    var address = ""
    var deviceName = UIDevice.current.name
    private(set) var phase = Phase.idle
    var error: String?
    @ObservationIgnored private var work: Task<Void, Never>?
    private let approval = WebApproval()
    private let onPaired: @MainActor (Credentials) throws -> Void

    init(onPaired: @escaping @MainActor (Credentials) throws -> Void) {
        self.onPaired = onPaired
    }

    var busy: Bool { phase != .idle }

    private var device: DeviceInfo { DeviceInfo(name: deviceName, version: AppConfig.version) }

    /// Checks the address, then opens the approval page and waits for someone to approve this iPhone.
    func signIn() {
        error = nil
        let server: ServerAddress
        do {
            server = try ServerAddress.parse(address)
        } catch {
            self.error = error.localizedDescription
            return
        }
        let device = device
        run {
            let client = APIClient(server: server)
            self.phase = .checking
            let instance = try await client.instance()
            if instance.setupRequired { throw PrintBetterError.message("This server isn't set up yet. Open it in a browser to finish setup.") }
            let code = try await client.startPairing(device)
            self.phase = .waiting(code)
            self.openApprovalPage()
            let issued = try await DevicePairing.waitForApproval(code) { try await client.pollPairing(deviceCode: code.deviceCode) }
            self.approval.close()
            try self.onPaired(Credentials(server: server, issued: issued))
        }
    }

    /// Pairs with the single-use code from a QR code or a pairing link.
    func connect(_ link: PairingLink, then done: @escaping @MainActor () -> Void = {}) {
        error = nil
        let device = device
        run {
            self.phase = .connecting
            var info = device
            info.token = link.pairingCode
            let issued = try await APIClient(server: link.server).enroll(info)
            try self.onPaired(Credentials(server: link.server, issued: issued))
            done()
        }
    }

    func openApprovalPage() {
        guard case let .waiting(code) = phase, let url = URL(string: code.verificationUriComplete) else { return }
        if !approval.open(url) { error = "Can't open the approval page. Open \(code.verificationUri) in Safari and enter the code." }
    }

    func cancel() {
        work?.cancel()
        work = nil
        approval.close()
        phase = .idle
    }

    private func run(_ steps: @escaping @MainActor () async throws -> Void) {
        work?.cancel()
        work = Task {
            do {
                try await steps()
            } catch is CancellationError {
                return
            } catch {
                approval.close()
                self.error = error.localizedDescription
            }
            phase = .idle
        }
    }
}
