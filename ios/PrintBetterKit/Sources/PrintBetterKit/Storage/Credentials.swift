import Foundation
import Security

/// What pairing gives this device. The app and the share extension read it from a shared Keychain item.
public struct Credentials: Codable, Sendable, Equatable {
    public var server: ServerAddress
    public var clientId: String
    public var workspaceId: String
    public var deviceName: String
    public var token: String

    public init(server: ServerAddress, issued: IssuedDevice) {
        self.server = server
        self.clientId = issued.clientId
        self.workspaceId = issued.workspaceId
        self.deviceName = issued.name
        self.token = issued.token
    }

    public var client: APIClient { APIClient(server: server, token: token) }
}

public protocol SecretStore: Sendable {
    func read() throws -> Data?
    func write(_ data: Data) throws
    func remove() throws
}

public struct KeychainError: Error, Equatable, LocalizedError {
    public let status: OSStatus
    public var errorDescription: String? { "The Keychain refused (\(status)). Restart your \(ThisDevice.model), then try again." }
}

/// One generic-password item, optionally in a keychain access group shared with app extensions.
public struct KeychainStore: SecretStore {
    public let service: String
    public let account: String
    public let accessGroup: String?

    public init(service: String, account: String, accessGroup: String?) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    private var query: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    public func read() throws -> Data? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return result as? Data
    }

    /// Readable after the first unlock so the share extension works, and never restored onto another phone.
    public func write(_ data: Data) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}

public struct CredentialStore: Sendable {
    private let store: any SecretStore

    public init(store: any SecretStore) {
        self.store = store
    }

    public func load() throws -> Credentials? {
        guard let data = try store.read() else { return nil }
        return try? JSONDecoder().decode(Credentials.self, from: data)
    }

    public func save(_ credentials: Credentials) throws {
        try store.write(JSONEncoder().encode(credentials))
    }

    public func clear() throws {
        try store.remove()
    }
}
