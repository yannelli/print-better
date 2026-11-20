import Foundation

/// Non-secret state the app and the share extension both use, kept in one item of their shared Keychain
/// group: they have no App Group, so neither can read the other's defaults.
public struct SharedPreferences: Sendable {
    private struct Values: Codable {
        var lastPrinterId: String?
        var identity: ClientIdentity?
        var printers: [Printer]?
    }

    private let store: any SecretStore

    public init(store: any SecretStore) {
        self.store = store
    }

    /// The printer someone printed to last, picked first next time.
    public var lastPrinterId: String? {
        get { values.lastPrinterId }
        nonmutating set { update { $0.lastPrinterId = newValue } }
    }

    public var identity: ClientIdentity? {
        get { values.identity }
        nonmutating set { update { $0.identity = newValue } }
    }

    /// The last printer list, so a sheet shows printers at once and refreshes them in place.
    public var printers: [Printer] {
        get { values.printers ?? [] }
        nonmutating set { update { $0.printers = newValue } }
    }

    public func clear() {
        try? store.remove()
    }

    private var values: Values {
        (try? store.read()).flatMap { try? JSONDecoder().decode(Values.self, from: $0) } ?? Values()
    }

    private func update(_ change: (inout Values) -> Void) {
        var values = values
        change(&values)
        guard let data = try? JSONEncoder().encode(values) else { return }
        try? store.write(data)
    }
}
