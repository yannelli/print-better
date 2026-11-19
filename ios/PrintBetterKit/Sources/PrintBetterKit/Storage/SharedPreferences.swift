import Foundation

/// Non-secret state the app and the share extension both use, in the App Group's defaults.
public struct SharedPreferences: Sendable {
    private let suiteName: String?

    public init(appGroup: String?) {
        self.suiteName = appGroup
    }

    private var defaults: UserDefaults {
        suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard
    }

    /// The printer someone printed to last, picked first next time.
    public var lastPrinterId: String? {
        get { defaults.string(forKey: "lastPrinterId") }
        nonmutating set { defaults.set(newValue, forKey: "lastPrinterId") }
    }

    public var identity: ClientIdentity? {
        get { decoded(ClientIdentity.self, "identity") }
        nonmutating set { encode(newValue, "identity") }
    }

    /// The last printer list, so a sheet shows printers at once and refreshes them in place.
    public var printers: [Printer] {
        get { decoded([Printer].self, "printers") ?? [] }
        nonmutating set { encode(newValue, "printers") }
    }

    public func clear() {
        for key in ["lastPrinterId", "identity", "printers"] { defaults.removeObject(forKey: key) }
    }

    private func decoded<T: Decodable>(_ type: T.Type, _ key: String) -> T? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(type, from: $0) }
    }

    private func encode(_ value: (some Encodable)?, _ key: String) {
        guard let value, let data = try? JSONEncoder().encode(value) else { return defaults.removeObject(forKey: key) }
        defaults.set(data, forKey: key)
    }
}
