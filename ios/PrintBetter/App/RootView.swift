import PrintBetterKit
import SwiftUI

/// Pairing until this iPhone has a token, then the tabs.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            if let session = model.session {
                MainView(session: session).id(ObjectIdentifier(session))
            } else {
                PairingView(app: model)
            }
        }
        .sheet(item: $model.pendingLink) { link in
            PairingLinkSheet(link: link, app: model)
        }
        .alert("This iPhone was removed", isPresented: $model.revoked) {
            Button("Connect Again") { model.unpair() }
            Button("Not Now", role: .cancel) {}
        } message: {
            Text("Someone removed this iPhone from Print Better. Connect it again to print.")
        }
        .alert("Can't read the Keychain", isPresented: .constant(model.keychainError != nil)) {
            Button("OK") { model.keychainError = nil }
        } message: {
            Text(model.keychainError ?? "")
        }
    }
}

/// The four tabs; on iPad they become a sidebar.
struct MainView: View {
    @Environment(AppModel.self) private var model
    let session: PrintSession
    @State private var jobs: JobsModel

    init(session: PrintSession) {
        self.session = session
        _jobs = State(initialValue: JobsModel(client: session.client))
    }

    var body: some View {
        TabView(selection: Bindable(model).selectedTab) {
            Tab("Print", systemImage: "printer.fill", value: AppTab.print) {
                NavigationStack { ComposeView(session: session) }
            }
            Tab("Printers", systemImage: "printer.dotmatrix", value: AppTab.printers) {
                NavigationStack { PrintersView(session: session) }
            }
            Tab("Jobs", systemImage: "tray.full", value: AppTab.jobs) {
                NavigationStack { JobsView(jobs: jobs, printers: session.printers) }
            }
            Tab("Settings", systemImage: "gearshape", value: AppTab.settings) {
                NavigationStack { SettingsView() }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .task {
            let model = model
            jobs.onRevoked = { model.revoked = true }
            await model.refreshIdentity()
        }
    }
}
