import Foundation
import PrintBetterKit

/// Both targets read the shared Keychain group from their Info.plist; it holds the device token.
enum AppConfig {
    static let keychainGroup = Bundle.main.object(forInfoDictionaryKey: "PBKeychainGroup") as? String
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
    static let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"

    static var credentials: CredentialStore {
        CredentialStore(store: KeychainStore(service: "dev.yannelli.printbetter", account: "device", accessGroup: keychainGroup))
    }

    static var preferences: SharedPreferences { SharedPreferences(appGroup: nil) }
}
