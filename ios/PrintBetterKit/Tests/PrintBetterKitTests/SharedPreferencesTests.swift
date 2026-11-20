import Foundation
import Synchronization
import Testing

@testable import PrintBetterKit

/// One Keychain item in memory, shared like the real one between the app and the share extension.
final class MemoryStore: SecretStore {
    private let data = Mutex<Data?>(nil)

    func read() throws -> Data? { data.withLock { $0 } }
    func write(_ new: Data) throws { data.withLock { $0 = new } }
    func remove() throws { data.withLock { $0 = nil } }
}

struct SharedPreferencesTests {
    @Test func theShareExtensionSeesWhatTheAppSaved() {
        let item = MemoryStore()
        let app = SharedPreferences(store: item)
        app.printers = [Printer(id: "pr_1", name: "Laser", clientName: "Den Pi")]
        app.lastPrinterId = "pr_1"
        let share = SharedPreferences(store: item)
        #expect(share.printers.map(\.id) == ["pr_1"])
        #expect(share.lastPrinterId == "pr_1")
    }

    @Test func oneSettingChangesWithoutTouchingTheOthers() {
        let prefs = SharedPreferences(store: MemoryStore())
        prefs.lastPrinterId = "pr_1"
        prefs.printers = [Printer(id: "pr_2", name: "Inkjet", clientName: "Den Pi")]
        prefs.lastPrinterId = nil
        #expect(prefs.printers.count == 1)
        #expect(prefs.lastPrinterId == nil)
    }

    @Test func clearForgetsEverything() throws {
        let item = MemoryStore()
        let prefs = SharedPreferences(store: item)
        prefs.lastPrinterId = "pr_1"
        prefs.identity = ClientIdentity(clientId: "c_1", name: "Front Desk iPhone", workspaceId: "w_1", workspaceName: "Office")
        prefs.clear()
        #expect(prefs.lastPrinterId == nil && prefs.identity == nil && prefs.printers.isEmpty)
        #expect(try item.read() == nil)
    }

    @Test func anUnreadableItemReadsAsEmpty() throws {
        let item = MemoryStore()
        try item.write(Data("not json".utf8))
        let prefs = SharedPreferences(store: item)
        #expect(prefs.printers.isEmpty)
        prefs.lastPrinterId = "pr_1"
        #expect(prefs.lastPrinterId == "pr_1")
    }
}
