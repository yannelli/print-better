import Foundation

/// How a status should look: green for good, orange for a warning, red for a failure.
public enum Tone: String, Sendable {
    case ok, warn, bad, info, neutral
}

/// The same vocabulary as the web app (server/src/lib/words.ts).
public struct StatusWords: Sendable, Equatable {
    public var label: String
    public var tone: Tone
    public var detail: String?

    public init(_ label: String, _ tone: Tone, detail: String? = nil) {
        self.label = label
        self.tone = tone
        self.detail = detail
    }
}

extension Printer {
    public var status: StatusWords {
        if state == .offline { return StatusWords("Not responding", .bad, detail: "Check that the printer is on and connected.") }
        if !online { return StatusWords("Offline", .neutral, detail: "\(clientName) is turned off or not connected. Jobs wait until it's back.") }
        switch state {
        case .idle: return StatusWords("Ready", .ok)
        case .printing: return StatusWords("Printing", .info)
        case .stopped: return StatusWords("Needs attention", .warn, detail: "Check the printer for a paper jam, an empty tray or an open door.")
        case .offline, .unknown: return StatusWords("Checking", .neutral)
        }
    }

    /// "Office, on Den Pi": where to find it and which device connects it.
    public var whereabouts: String {
        [location, "on \(clientName)"].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: ", ")
    }
}

extension Job {
    /// `printer` is this job's printer as last listed, to say what a waiting job waits for.
    public func status(printer: Printer? = nil) -> StatusWords {
        let message = statusMessage.flatMap { $0.isEmpty ? nil : $0 }
        switch status {
        case .uploading: return StatusWords("Uploading", .info, detail: message)
        case .queued, .unknown:
            if let printer, !printer.online, printer.state != .offline {
                return StatusWords("Waiting", .neutral, detail: message ?? "Waiting for \(printer.clientName) to come online.")
            }
            return StatusWords("Waiting", .neutral, detail: message)
        case .held: return StatusWords("Waiting", .neutral, detail: heldDetail(message))
        case .dispatched: return StatusWords("Sending to printer", .info, detail: message)
        case .printing: return StatusWords("Printing", .info, detail: message)
        case .completed:
            if let message { return StatusWords("Printed with a problem", .warn, detail: message) }
            return StatusWords("Printed", .ok, detail: pages.map { "\($0) \($0 == 1 ? "page" : "pages")" })
        case .failed: return StatusWords("Didn't print", .bad, detail: message)
        case .canceled: return StatusWords("Canceled", .neutral, detail: message)
        }
    }

    /// "Waiting for approval. An owner or admin can approve it in the web app."
    private func heldDetail(_ message: String?) -> String? {
        let who: String? = switch held?.kind {
        case .approval: "An owner or admin can approve it in the web app."
        case .release: "An owner or admin can release it in the web app."
        case .unknown, nil: nil
        }
        let said = message.map { $0.hasSuffix(".") ? $0 : "\($0)." }
        let detail = [said, who].compactMap(\.self).joined(separator: " ")
        return detail.isEmpty ? nil : detail
    }
}

extension Supply {
    /// Nil when the printer doesn't report this supply's level.
    public var percent: Int? { level >= 0 ? min(level, 100) : nil }

    public var isLow: Bool { (percent ?? 100) <= 10 }

    /// "Black toner, 64 percent" for VoiceOver.
    public var spoken: String {
        guard let percent else { return "\(name), level unknown" }
        return "\(name), \(percent) percent\(isLow ? ", low" : "")"
    }
}
