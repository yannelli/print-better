import PrintBetterKit
import SwiftUI

/// The chosen printer as one row that opens the full list.
struct PrinterPickerSection: View {
    let session: PrintSession

    var body: some View {
        Section("Printer") {
            if let printer = session.printer {
                NavigationLink {
                    PrinterChooser(session: session)
                } label: {
                    PrinterRow(printer: printer, showsSupplies: false)
                }
            } else if session.loadingPrinters {
                ProgressView("Loading printers…")
            } else if session.printersError == nil {
                NoPrintersText()
            }
            if let error = session.printersError {
                ErrorRow(error)
            }
        }
    }
}

struct NoPrintersText: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("No printers yet").font(.headline)
            Text("Printers show up here once a computer or Raspberry Pi near them is connected to Print Better.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Every printer this iPhone may use, with the chosen one checked.
struct PrinterChooser: View {
    let session: PrintSession
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List(session.printers) { printer in
            let chosen = printer.id == session.printerId
            Button {
                session.select(printer.id)
                dismiss()
            } label: {
                HStack {
                    PrinterRow(printer: printer)
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                        .opacity(chosen ? 1 : 0)
                        .accessibilityHidden(true)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(chosen ? .isSelected : [])
        }
        .navigationTitle("Printer")
        .refreshable { await session.loadPrinters() }
    }
}
