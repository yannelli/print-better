import Foundation

/// The RFC 8628 polling loop the desktop client runs, for "sign in and approve" pairing.
public enum DevicePairing {
    public enum Step: Equatable, Sendable {
        case approved(IssuedDevice)
        case pending
        case slowDown
        case failed(String)
    }

    public static let expired = "The code expired. Start again."

    /// What one `device/token` answer means. Network trouble and server hiccups keep waiting.
    public static func step(_ answer: Result<IssuedDevice, any Error>) -> Step {
        switch answer {
        case let .success(issued): return .approved(issued)
        case let .failure(error as PrintBetterError):
            if error.isTransient { return .pending }
            switch error.code {
            case "authorization_pending": return .pending
            case "slow_down": return .slowDown
            case "access_denied": return .failed("Pairing was declined in the browser.")
            case "expired_token": return .failed(expired)
            default: return .failed(error.localizedDescription)
            }
        case let .failure(error): return .failed(error.localizedDescription)
        }
    }

    /// Polls until someone approves or denies the code, or it expires. Cancel the task to stop.
    public static func waitForApproval(
        _ code: DeviceCode,
        poll: @Sendable () async throws -> IssuedDevice,
        sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) async throws -> IssuedDevice {
        var interval = Duration.seconds(max(code.interval, 1))
        var waited = Duration.zero
        let lifetime = Duration.seconds(max(code.expiresIn, 1))
        while waited < lifetime {
            try await sleep(interval)
            waited += interval
            let answer: Result<IssuedDevice, any Error>
            do {
                answer = .success(try await poll())
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                answer = .failure(error)
            }
            switch step(answer) {
            case let .approved(issued): return issued
            case .pending: continue
            case .slowDown: interval += .seconds(5)
            case let .failed(message): throw PrintBetterError.message(message)
            }
        }
        throw PrintBetterError.message(expired)
    }
}
