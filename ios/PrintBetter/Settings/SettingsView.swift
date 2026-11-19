import PrintBetterKit
import SwiftUI

/// The server and workspace this iPhone uses, its name, help, and a way to unpair.
struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var confirmingUnpair = false

    var body: some View {
        Form {
            if let credentials = app.credentials {
                Section("Server") {
                    LabeledContent("Address", value: credentials.server.displayName)
                    if let workspace = app.identity?.workspaceName {
                        LabeledContent("Workspace", value: workspace)
                    }
                    Link(destination: credentials.server.origin) {
                        Label("Open Web App", systemImage: "safari")
                    }
                }
                Section {
                    LabeledContent("Name", value: app.identity?.name ?? credentials.deviceName)
                } header: {
                    Text("This iPhone")
                } footer: {
                    Text("To rename this iPhone, open Devices in the web app.")
                }
            }
            Section {
                NavigationLink {
                    AboutView()
                } label: {
                    Label("About and Help", systemImage: "questionmark.circle")
                }
            }
            Section {
                Button("Unpair This iPhone", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                    confirmingUnpair = true
                }
            } footer: {
                Text("Print Better \(AppConfig.version) (\(AppConfig.build))")
            }
        }
        .navigationTitle("Settings")
        .refreshable { await app.refreshIdentity() }
        .confirmationDialog("Unpair this iPhone?", isPresented: $confirmingUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) { app.unpair() }
        } message: {
            Text("You'll need to connect again to print. This iPhone stays under Devices in the web app until someone removes it there.")
        }
    }
}
