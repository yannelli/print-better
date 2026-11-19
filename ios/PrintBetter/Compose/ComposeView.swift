import PrintBetterKit
import SwiftUI

/// The Print tab: pick a file, photos or a scan, choose a printer and settings, then follow the job.
struct ComposeView: View {
    let session: PrintSession
    @State private var sources = DocumentSources()

    var body: some View {
        PrintForm(session: session, onDone: session.startOver) {
            if session.preparing {
                ProgressView("Preparing…")
            } else if let document = session.document {
                DocumentRow(document: document)
                if session.stage == .editing {
                    Button("Remove", systemImage: "xmark.circle", role: .destructive, action: session.clearDocument)
                }
            } else {
                DocumentSourceRows(sources: $sources)
            }
        }
        .navigationTitle("Print")
        .modifier(DocumentPickers(sources: $sources, session: session))
        .task { await session.loadPrinters() }
    }
}
