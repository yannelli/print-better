import PrintBetterKit
import SwiftUI

/// Every printer this iPhone may print to, refreshed while the list is on screen.
struct PrintersView: View {
    let session: PrintSession
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        List {
            if let error = session.printersError {
                Section { ErrorRow(error) }
            }
            ForEach(session.printers) { printer in
                NavigationLink(value: printer.id) {
                    PrinterRow(printer: printer)
                }
            }
        }
        .overlay {
            if session.printers.isEmpty, !session.loadingPrinters, session.printersError == nil {
                ContentUnavailableView(
                    "No Printers Yet", systemImage: "printer",
                    description: Text("Printers show up here once a computer or Raspberry Pi near them is connected to Print Better."))
            }
        }
        .navigationTitle("Printers")
        .navigationDestination(for: String.self) { id in
            PrinterDetailView(session: session, printerId: id)
        }
        .refreshable { await session.loadPrinters() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await session.loadPrinters()
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }
}
