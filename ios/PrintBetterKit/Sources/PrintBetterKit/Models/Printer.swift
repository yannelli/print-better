import Foundation

/// Wire enums decode values this app doesn't know yet as `fallback`, so a newer server never breaks a list.
public protocol LenientEnum: RawRepresentable, Codable, Sendable, Hashable where RawValue == String {
    static var fallback: Self { get }
}

extension LenientEnum {
    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .fallback
    }
}

public enum PrinterState: String, LenientEnum {
    case idle, printing, stopped, offline, unknown
    public static let fallback = PrinterState.unknown
}

public struct Supply: Codable, Sendable, Hashable {
    public var name: String
    /// `toner`, `ink`, `drum`, `waste` or `other`.
    public var kind: String
    /// A CSS color such as `#000000`, when the printer reports one.
    public var color: String?
    /// 0 to 100, or -1 when the printer doesn't report a level.
    public var level: Int

    public init(name: String, kind: String, color: String?, level: Int) {
        self.name = name
        self.kind = kind
        self.color = color
        self.level = level
    }
}

public struct Capabilities: Codable, Sendable, Hashable {
    public var formats: [String] = []
    public var color = false
    public var duplex = false
    /// PWG media names such as `na_letter_8.5x11in`.
    public var media: [String] = []
    public var mediaDefault: String?
    public var resolutions: [Int] = []
    public var copiesMax = 99
    /// Paper trays (IPP `media-source` keywords); nil when the printer's device can't tell.
    public var sources: [String]?
    /// Paper types (IPP `media-type` keywords); nil when unknown.
    public var mediaTypes: [String]?
    /// Nil means any quality may be asked for.
    public var qualities: [Quality]?

    public init() {}

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        formats = try c.decodeIfPresent([String].self, forKey: .formats) ?? []
        color = try c.decodeIfPresent(Bool.self, forKey: .color) ?? false
        duplex = try c.decodeIfPresent(Bool.self, forKey: .duplex) ?? false
        media = try c.decodeIfPresent([String].self, forKey: .media) ?? []
        mediaDefault = try c.decodeIfPresent(String.self, forKey: .mediaDefault)
        resolutions = try c.decodeIfPresent([Int].self, forKey: .resolutions) ?? []
        copiesMax = try c.decodeIfPresent(Int.self, forKey: .copiesMax) ?? 99
        sources = try c.decodeIfPresent([String].self, forKey: .sources)
        mediaTypes = try c.decodeIfPresent([String].self, forKey: .mediaTypes)
        qualities = try c.decodeIfPresent([String].self, forKey: .qualities)?.compactMap(Quality.init(rawValue:))
    }
}

/// A workspace printer this device may print to: the server's `RemotePrinter`.
public struct Printer: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var location: String?
    public var makeModel: String?
    public var uuid: String?
    /// The computer or Raspberry Pi the printer is connected to.
    public var clientName: String
    /// That device is connected and the printer isn't offline.
    public var online: Bool
    public var state: PrinterState
    public var capabilities: Capabilities
    public var defaults: JobOptions
    public var supplies: [Supply]

    public init(
        id: String, name: String, location: String? = nil, makeModel: String? = nil, clientName: String, online: Bool = true,
        state: PrinterState = .idle, capabilities: Capabilities = Capabilities(), defaults: JobOptions = JobOptions(), supplies: [Supply] = []
    ) {
        self.id = id
        self.name = name
        self.location = location
        self.makeModel = makeModel
        self.uuid = nil
        self.clientName = clientName
        self.online = online
        self.state = state
        self.capabilities = capabilities
        self.defaults = defaults
        self.supplies = supplies
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        location = try c.decodeIfPresent(String.self, forKey: .location)
        makeModel = try c.decodeIfPresent(String.self, forKey: .makeModel)
        uuid = try c.decodeIfPresent(String.self, forKey: .uuid)
        clientName = try c.decodeIfPresent(String.self, forKey: .clientName) ?? ""
        online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
        state = try c.decodeIfPresent(PrinterState.self, forKey: .state) ?? .unknown
        capabilities = try c.decodeIfPresent(Capabilities.self, forKey: .capabilities) ?? Capabilities()
        defaults = try c.decodeIfPresent(JobOptions.self, forKey: .defaults) ?? JobOptions()
        supplies = try c.decodeIfPresent([Supply].self, forKey: .supplies) ?? []
    }
}
