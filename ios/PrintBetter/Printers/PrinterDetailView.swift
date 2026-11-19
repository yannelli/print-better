import PrintBetterKit
import SwiftUI

/// One printer: its state, supplies, what it can do, and a way to print to it.
struct PrinterDetailView: View {
    let session: PrintSession
    let printerId: String
    @Environment(AppModel.self) private var app

    var body: some View {
        if let printer = session.printers.first(where: { $0.id == printerId }) {
            List {
                Section {
                    LabeledContent("Status") { StatusBadge(words: printer.status) }
                    if let detail = printer.status.detail {
                        Text(detail).foregroundStyle(.secondary)
                    }
                    LabeledContent("Connected to", value: printer.clientName)
                    if let location = printer.location, !location.isEmpty {
                        LabeledContent("Location", value: location)
                    }
                    if let model = printer.makeModel, !model.isEmpty {
                        LabeledContent("Model", value: model)
                    }
                }
                if !printer.supplies.isEmpty {
                    Section("Supplies") { SupplyList(supplies: printer.supplies) }
                }
                Section("Prints") {
                    LabeledContent("Color", value: printer.capabilities.color ? "Yes" : "Black and white only")
                    LabeledContent("Two-sided", value: printer.capabilities.duplex ? "Yes" : "No")
                    if !printer.capabilities.media.isEmpty {
                        LabeledContent("Paper sizes", value: printer.capabilities.media.prefix(6).map(OptionWords.paperName).joined(separator: ", "))
                    }
                }
            }
            .navigationTitle(printer.name)
            .safeAreaBar(edge: .bottom) {
                Button {
                    session.select(printer.id)
                    app.selectedTab = .print
                } label: {
                    Label("Print to This Printer", systemImage: "printer.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .padding(.horizontal)
                .padding(.bottom, 8)
            }
        } else {
            ContentUnavailableView("Printer Not Available", systemImage: "printer", description: Text("This printer isn't shared with this iPhone anymore."))
        }
    }
}
