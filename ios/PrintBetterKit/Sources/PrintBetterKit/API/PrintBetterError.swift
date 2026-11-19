import Foundation

/// Everything that can go wrong talking to the server or preparing a document, in words people can act on.
public enum PrintBetterError: Error, Equatable, Sendable, LocalizedError {
    /// The server refused: its status, error code and message.
    case server(status: Int, code: String, message: String)
    case offline
    case unreachable(host: String)
    /// The device token stopped working: someone removed this iPhone in the web app.
    case revoked
    case badResponse
    /// A problem on this iPhone, such as a document no printer takes, already in plain words.
    case message(String)

    public var code: String? {
        if case let .server(_, code, _) = self { code } else { nil }
    }

    /// Worth trying again later without asking: no connection, or the server had a moment.
    public var isTransient: Bool {
        switch self {
        case .offline, .unreachable: true
        case let .server(status, _, _): status >= 500 || status == 429
        default: false
        }
    }

    public var errorDescription: String? {
        switch self {
        case let .server(status, code, message): Self.words(status: status, code: code, message: message)
        case .offline: "You're offline. Check your internet connection and try again."
        case let .unreachable(host): "Can't reach \(host). Check the address and your internet connection."
        case .revoked: "This iPhone was removed from Print Better. Connect it again to print."
        case .badResponse: "The server sent an answer this app doesn't understand. Check that the address is your Print Better server."
        case let .message(message): message
        }
    }

    private static func words(status: Int, code: String, message: String) -> String {
        switch code {
        case "printer_access_denied": "You can't print to this printer from this iPhone."
        case "printer_not_found": "This printer isn't available anymore. Pull down on the printer list to refresh it."
        case "too_large": "This document is too big to print. \(message)."
        case "unsupported_type": "Print Better can print PDFs, photos and text."
        case "invalid_token": "This pairing code was already used or has expired. Make a new one under Devices > Add a device."
        case "rate_limited": "Too many tries. Wait a minute, then try again."
        case "job_finished": "This print job already finished."
        case "size_mismatch": "The upload stopped partway. Try again."
        case "expired_token": "The code expired. Start again."
        case "access_denied": "Pairing was declined in the browser."
        case "setup_required": "This server isn't set up yet. Open it in a browser to finish setup."
        default:
            if status >= 500 { "The server had a problem (\(status)). Try again in a moment." } else if message.isEmpty { "Something went wrong (\(code))." } else { message }
        }
    }

    /// Maps URLSession failures; cancellation stays a `CancellationError` so callers can ignore it.
    static func transport(_ error: any Error, host: String) -> any Error {
        guard let urlError = error as? URLError else { return error }
        switch urlError.code {
        case .cancelled: return CancellationError()
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff: return PrintBetterError.offline
        default: return PrintBetterError.unreachable(host: host)
        }
    }
}
