import PrintBetterKit
import SwiftUI

/// The printer's own choices only: no two-sided picker for a printer that can't, no trays it doesn't have.
struct PrintOptionsSection: View {
    @Bindable var session: PrintSession
    /// The share sheet shows the settings people change most; the app shows them all.
    var compact = false

    var body: some View {
        if let printer = session.printer {
            let caps = printer.capabilities
            Section("Options") {
                Stepper(value: bind(\.copies, session.copies), in: 1...session.maxCopies) {
                    LabeledContent("Copies") { Text(session.copies, format: .number) }
                }
                if caps.duplex {
                    Picker("Sides", selection: bind(\.sides, session.sides)) {
                        ForEach(Sides.allCases, id: \.self) { Text(OptionWords.sidesName($0)) }
                    }
                }
                if caps.color {
                    Picker("Color", selection: bind(\.colorMode, session.colorMode)) {
                        Text(OptionWords.colorName(.color)).tag(ColorMode.color)
                        Text(OptionWords.colorName(.monochrome)).tag(ColorMode.monochrome)
                    }
                }
                if caps.media.count > 1 {
                    Picker("Paper size", selection: bind(\.media, session.media)) {
                        ForEach(caps.media, id: \.self) { Text(OptionWords.paperName($0)) }
                    }
                }
                if !compact { MoreOptions(session: session) }
            }
        }
    }

    /// A binding that shows the effective value and stores only an explicit choice.
    private func bind<T: Equatable & Sendable>(_ key: WritableKeyPath<JobOptions, T?> & Sendable, _ shown: T) -> Binding<T> {
        let session = session
        return Binding(get: { shown }, set: { session.options[keyPath: key] = $0 })
    }
}

private struct MoreOptions: View {
    @Bindable var session: PrintSession

    var body: some View {
        if session.trays.count > 1 {
            Picker("Paper tray", selection: bind(\.source, session.tray)) {
                ForEach(session.trays, id: \.self) { Text(OptionWords.trayName($0)) }
            }
        }
        if session.paperTypes.count > 1 {
            Picker("Paper type", selection: bind(\.mediaType, session.paperType)) {
                ForEach(session.paperTypes, id: \.self) { Text(OptionWords.paperTypeName($0)) }
            }
        }
        if session.qualities.count > 1 {
            Picker("Quality", selection: bind(\.quality, session.quality)) {
                ForEach(session.qualities, id: \.self) { Text(OptionWords.qualityName($0)) }
            }
        }
        if session.document?.hasPages == true {
            LabeledContent("Pages") {
                TextField("All", text: $session.pageRangesText, prompt: Text("All"))
                    .multilineTextAlignment(.trailing)
                    .keyboardType(.numbersAndPunctuation)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityHint("Page numbers and ranges, such as 1-3,5. Leave empty to print every page.")
            }
            if !session.pageRangesValid {
                Text("Use page numbers and ranges, such as 1-3,5.")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }

    private func bind<T: Equatable & Sendable>(_ key: WritableKeyPath<JobOptions, T?> & Sendable, _ shown: T) -> Binding<T> {
        let session = session
        return Binding(get: { shown }, set: { session.options[keyPath: key] = $0 })
    }
}
