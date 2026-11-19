import PrintBetterKit
import SwiftUI

/// The first screen: connect this iPhone with a server address and the browser, or with a QR code.
struct PairingView: View {
    let app: AppModel
    @State private var model: PairingModel
    @State private var scanning = false
    @State private var scanned: PairingLink?
    @FocusState private var addressFocused: Bool

    init(app: AppModel) {
        self.app = app
        _model = State(initialValue: PairingModel(onPaired: { try app.paired($0) }))
    }

    var body: some View {
        NavigationStack {
            Group {
                if case let .waiting(code) = model.phase {
                    ApprovalWaitView(code: code, model: model)
                } else {
                    form
                }
            }
            .navigationTitle("Connect")
            .navigationBarTitleDisplayMode(.inline)
        }
        .sheet(isPresented: $scanning, onDismiss: showScannedLink) {
            QRScannerSheet { scanned = $0 }
        }
    }

    private var form: some View {
        Form {
            Section {
                WelcomeHeader()
            }
            .listRowBackground(Color.clear)
            Section {
                TextField("Server address", text: $model.address, prompt: Text("your-print-better.example"))
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($addressFocused)
                    .onSubmit { model.signIn() }
                TextField("Name", text: $model.deviceName, prompt: Text("iPhone"))
                    .textInputAutocapitalization(.words)
            } header: {
                Text("Server")
            } footer: {
                Text("The name is how this iPhone appears under Devices in the web app.")
            }
            if let error = model.error {
                Section { ErrorRow(error) }
            }
        }
        .disabled(model.busy)
        .safeAreaBar(edge: .bottom) { actions }
    }

    private var actions: some View {
        VStack(spacing: 12) {
            Button(action: model.signIn) {
                Group {
                    if model.busy { ProgressView() } else { Text("Sign In to Connect") }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            .disabled(model.busy || model.address.allSatisfy(\.isWhitespace))
            Button {
                scanning = true
            } label: {
                Label("Scan QR Code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
            }
            .buttonStyle(.glass)
            .disabled(model.busy)
        }
        .controlSize(.large)
        .padding(.horizontal)
        .padding(.bottom, 8)
    }

    private func showScannedLink() {
        guard let scanned else { return }
        self.scanned = nil
        app.pendingLink = scanned
    }
}

private struct WelcomeHeader: View {
    var body: some View {
        VStack(spacing: 12) {
            BrandMark(size: 88)
            Text("Print Better").font(.largeTitle.bold())
            Text("Connect this iPhone to your Print Better server to print to your workspace's printers from anywhere.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }
}

/// Shown while the approval page is open: the code to compare, and a way back to the page if it was closed.
struct ApprovalWaitView: View {
    let code: DeviceCode
    let model: PairingModel

    var body: some View {
        Form {
            Section {
                VStack(spacing: 16) {
                    ProgressView().controlSize(.large)
                    Text("Approve this iPhone").font(.title2.bold())
                    Text(code.userCode)
                        .font(.system(.largeTitle, design: .monospaced).bold())
                        .textSelection(.enabled)
                        .accessibilityLabel("Code \(code.userCode.map(String.init).joined(separator: " "))")
                    Text("Sign in on the approval page and check that it shows this code. Then tap Approve. This screen continues by itself.")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
            if let error = model.error {
                Section { ErrorRow(error) }
            }
            Section {
                Button("Open Approval Page", systemImage: "safari", action: model.openApprovalPage)
                Button("Cancel", role: .cancel, action: model.cancel)
            } footer: {
                Text("You can also approve from a computer: open \(code.verificationUri) and enter the code.")
            }
        }
    }
}
