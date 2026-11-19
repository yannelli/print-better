import PrintBetterKit
import SwiftUI

/// The compact print sheet in other apps' share menus.
struct ShareView: View {
    let model: ShareModel

    var body: some View {
        NavigationStack {
            Group {
                switch model.state {
                case .loading:
                    ProgressView()
                case .notPaired:
                    ContentUnavailableView(
                        "Connect Print Better First", systemImage: "printer",
                        description: Text("Open the Print Better app and connect this \(ThisDevice.model) to your server. Then share again."))
                case let .ready(session):
                    PrintForm(session: session, compact: true, onDone: model.close) {
                        if session.preparing {
                            ProgressView("Preparing…")
                        } else if let document = session.document {
                            DocumentRow(document: document)
                        } else if session.error == nil {
                            Text("Nothing to print.").foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Print Better")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark", action: model.close)
                }
            }
        }
    }
}
