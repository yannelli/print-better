import Foundation

public enum JobStatus: String, LenientEnum {
    case uploading, queued, held, dispatched, printing, completed, failed, canceled, unknown
    public static let fallback = JobStatus.unknown

    public var isFinished: Bool { self == .completed || self == .failed || self == .canceled }

    /// On its way to the printer: not finished, and not held until someone approves or releases it.
    public var isMoving: Bool { !isFinished && self != .held }
}

/// Why a `held` job waits. Device jobs have no member, so only owners and admins can approve or release them.
public struct JobHold: Codable, Sendable, Hashable {
    public enum Kind: String, LenientEnum {
        case approval, release, unknown
        public static let fallback = Kind.unknown
    }

    public var kind: Kind
}

/// A print job as the server reports it. Times are Unix epoch milliseconds.
public struct Job: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var printerId: String?
    public var printerName: String?
    public var title: String
    public var fileName: String?
    public var contentType: String
    public var size: Int
    public var options: JobOptions
    public var status: JobStatus
    /// Why a job failed, what it waits for, or, on a completed job, a problem the printer reported.
    public var statusMessage: String?
    public var pages: Int?
    public var createdAt: Double
    public var updatedAt: Double
    public var completedAt: Double?
    public var sourceClientName: String?
    /// Present while `status` is `held`.
    public var held: JobHold?

    public init(
        id: String, printerId: String?, printerName: String?, title: String, status: JobStatus, statusMessage: String? = nil,
        createdAt: Date = .now, contentType: String = "application/pdf", size: Int = 0
    ) {
        self.id = id
        self.printerId = printerId
        self.printerName = printerName
        self.title = title
        self.fileName = nil
        self.contentType = contentType
        self.size = size
        self.options = JobOptions()
        self.status = status
        self.statusMessage = statusMessage
        self.pages = nil
        self.createdAt = createdAt.timeIntervalSince1970 * 1000
        self.updatedAt = self.createdAt
        self.completedAt = nil
        self.sourceClientName = nil
        self.held = nil
    }

    public var created: Date { Date(timeIntervalSince1970: createdAt / 1000) }
    public var updated: Date { Date(timeIntervalSince1970: updatedAt / 1000) }

    /// A finished job whose printer reported a problem, such as low toner, is a warning, not a success.
    public var printedWithProblem: Bool { status == .completed && !(statusMessage ?? "").isEmpty }

    public var canCancel: Bool { !status.isFinished }
}
