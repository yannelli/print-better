import Foundation
import Testing

@testable import PrintBetterKit

/// Answers polls from a script and counts the sleeps, so the loop runs instantly.
actor Script {
    private var answers: [Result<IssuedDevice, any Error>]
    private(set) var sleeps: [Duration] = []

    init(_ answers: [Result<IssuedDevice, any Error>]) {
        self.answers = answers
    }

    func next() throws -> IssuedDevice {
        try answers.removeFirst().get()
    }

    func slept(_ duration: Duration) {
        sleeps.append(duration)
    }
}

struct PairingTests {
    let code = DeviceCode(
        deviceCode: "pbd_x", userCode: "BCDF-GHJK", verificationUri: "https://your-print-better.example/device",
        verificationUriComplete: "https://your-print-better.example/device?code=BCDF-GHJK", interval: 5, expiresIn: 600)
    let issued = IssuedDevice(clientId: "c_1", workspaceId: "w_1", name: "Front Desk iPhone", token: "pbc_new")

    static func refusal(_ code: String, status: Int = 400) -> Result<IssuedDevice, any Error> {
        .failure(PrintBetterError.server(status: status, code: code, message: code))
    }

    @Test func waitsThroughPendingAndSlowDownUntilApproved() async throws {
        let script = Script([
            Self.refusal("authorization_pending"), .failure(PrintBetterError.offline), Self.refusal("slow_down"),
            Self.refusal("unavailable", status: 503), .success(issued),
        ])
        let result = try await DevicePairing.waitForApproval(code, poll: { try await script.next() }, sleep: { await script.slept($0) })
        #expect(result == issued)
        #expect(await script.sleeps == [.seconds(5), .seconds(5), .seconds(5), .seconds(10), .seconds(10)])
    }

    @Test func stopsWhenDeclinedOrExpired() async throws {
        let declined = Script([Self.refusal("access_denied")])
        await #expect(throws: PrintBetterError.message("Pairing was declined in the browser.")) {
            try await DevicePairing.waitForApproval(code, poll: { try await declined.next() }, sleep: { await declined.slept($0) })
        }
        let short = DeviceCode(deviceCode: "d", userCode: "u", verificationUri: "", verificationUriComplete: "", interval: 5, expiresIn: 9)
        let pending = Script([Self.refusal("authorization_pending"), Self.refusal("authorization_pending")])
        await #expect(throws: PrintBetterError.message(DevicePairing.expired)) {
            try await DevicePairing.waitForApproval(short, poll: { try await pending.next() }, sleep: { await pending.slept($0) })
        }
    }
}
