import PrintBetterKit
import SwiftUI

/// Asks before using a pairing link, since anything printed afterwards goes to that server.
struct PairingLinkSheet: View {
    let link: PairingLink
    let app: AppModel
    @State private var model: PairingModel
    @Environment(\.dismiss) private var dismiss

    init(link: PairingLink, app: AppModel) {
        self.link = link
        self.app = app
        _model = State(initialValue: PairingModel(onPaired: { try app.paired($0) }))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Server", value: link.server.displayName)
                    TextField("Name", text: $model.deviceName, prompt: Text(ThisDevice.model))
                        .textInputAutocapitalization(.words)
                } footer: {
                    Text("Only connect to a server you trust. Everything you print from this \(ThisDevice.model) goes to it.")
                }
                if let current = app.credentials {
                    Section {
                        ErrorRow("This \(ThisDevice.model) is connected to \(current.server.displayName). Connecting here replaces that connection.")
                    }
                }
                if let error = model.error {
                    Section { ErrorRow(error) }
                }
            }
            .disabled(model.busy)
            .navigationTitle("Connect to Print Better?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.busy {
                        ProgressView()
                    } else {
                        Button("Connect", systemImage: "checkmark") { model.connect(link) { dismiss() } }
                            .buttonStyle(.glassProminent)
                    }
                }
            }
        }
        .interactiveDismissDisabled(model.busy)
        .presentationDetents([.medium, .large])
    }
}
