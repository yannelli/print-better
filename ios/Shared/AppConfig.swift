import Foundation
import PrintBetterKit

/// Both targets read the App Group from their Info.plist; it also names the Keychain group that holds the device token.
enum AppConfig {
    static let appGroup = Bundle.main.object(forInfoDictionaryKey: "PBAppGroup") as? String
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
    static let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"

    static var credentials: CredentialStore {
        CredentialStore(store: KeychainStore(service: "dev.yannelli.printbetter", account: "device", accessGroup: appGroup))
    }

    static var preferences: SharedPreferences { SharedPreferences(appGroup: appGroup) }
}
