import Foundation

/// `GET /api/instance`: public facts about a server, used to check an address before pairing.
public struct InstanceInfo: Decodable, Sendable, Equatable {
    public var appName: String
    public var version: String
    public var setupRequired: Bool
}

/// `GET /api/client/me`: this device's name and workspace.
public struct ClientIdentity: Codable, Sendable, Equatable {
    public var clientId: String
    public var name: String
    public var workspaceId: String
    public var workspaceName: String?
}

/// What the server answers to `POST /api/client/device/code` (RFC 8628).
public struct DeviceCode: Decodable, Sendable, Equatable {
    public var deviceCode: String
    public var userCode: String
    public var verificationUri: String
    public var verificationUriComplete: String
    /// Seconds between polls.
    public var interval: Int
    /// Seconds until the code expires.
    public var expiresIn: Int

    public init(deviceCode: String, userCode: String, verificationUri: String, verificationUriComplete: String, interval: Int, expiresIn: Int) {
        self.deviceCode = deviceCode
        self.userCode = userCode
        self.verificationUri = verificationUri
        self.verificationUriComplete = verificationUriComplete
        self.interval = interval
        self.expiresIn = expiresIn
    }
}

/// The device token and identity the server issues once pairing succeeds.
public struct IssuedDevice: Decodable, Sendable, Equatable {
    public var clientId: String
    public var workspaceId: String
    public var name: String
    public var token: String

    public init(clientId: String, workspaceId: String, name: String, token: String) {
        self.clientId = clientId
        self.workspaceId = workspaceId
        self.name = name
        self.token = token
    }
}

/// How this device describes itself when it pairs. The server lists it as an iPhone.
public struct DeviceInfo: Encodable, Sendable, Equatable {
    public var hostname: String
    public var os = "ios"
    public var arch = "arm64"
    public var version: String
    public var name: String?
    /// A `pbe_` pairing code, for `POST /api/client/enroll` only.
    public var token: String?

    public init(name: String, version: String, token: String? = nil) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        self.hostname = trimmed.isEmpty ? "iPhone" : String(trimmed.prefix(100))
        self.name = trimmed.isEmpty ? nil : String(trimmed.prefix(100))
        self.version = String(version.prefix(32))
        self.token = token
    }
}

public struct Page<Item: Decodable & Sendable>: Decodable, Sendable {
    public var items: [Item]
    public var nextCursor: String?
}

struct JobEnvelope: Decodable {
    var job: Job
}

struct JobSlot: Decodable {
    var job: Job
    var uploadUrl: String
}

struct PrintersEnvelope: Decodable {
    var printers: [Printer]
}

struct NewJob: Encodable {
    var printerId: String
    var title: String
    var contentType: String
    var size: Int
    var fileName: String
    var options: JobOptions?
}

struct DevicePoll: Encodable {
    var deviceCode: String
}

struct NoBody: Codable {}

struct ErrorEnvelope: Decodable {
    struct Detail: Decodable {
        var code: String
        var message: String
    }
    var error: Detail
}
