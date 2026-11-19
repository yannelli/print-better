import PrintBetterKit
import SwiftUI

/// The form the app and the share sheet both use: the document, the printer and its settings, then the result.
struct PrintForm<DocumentRows: View>: View {
    @Bindable var session: PrintSession
    /// The share sheet shows only the settings people change most.
    var compact = false
    let onDone: @MainActor () -> Void
    @ViewBuilder let documentRows: DocumentRows

    var body: some View {
        Form {
            if case let .sent(job) = session.stage {
                Section {
                    JobStatusCard(job: job, printer: session.printer) { Task { await session.cancelJob() } }
                }
            }
            if let error = session.error {
                Section { ErrorRow(error) }
            }
            Section("Document") { documentRows }
            if !isSent {
                PrinterPickerSection(session: session)
                PrintOptionsSection(session: session, compact: compact)
            }
        }
        .disabled(isSending)
        .safeAreaBar(edge: .bottom) { bar }
        .jobFeedback(sentJob)
        .refreshable { await session.loadPrinters() }
    }

    private var sentJob: Job? {
        if case let .sent(job) = session.stage { job } else { nil }
    }

    private var isSent: Bool { sentJob != nil }

    private var isSending: Bool {
        if case .sending = session.stage { true } else { false }
    }

    @ViewBuilder
    private var bar: some View {
        Group {
            switch session.stage {
            case .editing:
                Button {
                    Task { await session.send() }
                } label: {
                    Label("Print", systemImage: "printer.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .disabled(!session.canSend)
            case let .sending(fraction):
                UploadProgressView(fraction: fraction)
                    .padding()
                    .glassEffect(in: .rect(cornerRadius: 20))
            case .sent:
                Button(action: onDone) {
                    Text("Done").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass)
            }
        }
        .controlSize(.large)
        .padding(.horizontal)
        .padding(.bottom, 8)
    }
}
