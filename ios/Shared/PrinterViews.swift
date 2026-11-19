import PrintBetterKit
import SwiftUI

/// A printer in a list: name, where it is, its state, and how much toner or ink is left.
struct PrinterRow: View {
    let printer: Printer
    var showsSupplies = true
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 12))
        layout {
            Image(systemName: "printer.fill")
                .font(.title2)
                .foregroundStyle(printer.online ? Color.accentColor : .secondary)
                .frame(minWidth: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(printer.name).font(.body.weight(.medium))
                Text(printer.whereabouts).font(.subheadline).foregroundStyle(.secondary)
                if showsSupplies, !printer.supplies.isEmpty {
                    SupplyStrip(supplies: printer.supplies)
                }
            }
            Spacer(minLength: 8)
            StatusBadge(words: printer.status)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Small level bars under a printer's name.
struct SupplyStrip: View {
    let supplies: [Supply]

    var body: some View {
        HStack(spacing: 4) {
            ForEach(supplies.prefix(6), id: \.self) { supply in
                Capsule()
                    .fill(.quaternary)
                    .overlay(alignment: .leading) {
                        GeometryReader { proxy in
                            Capsule().fill(supply.tint).frame(width: proxy.size.width * Double(supply.percent ?? 0) / 100)
                        }
                    }
                    .frame(width: 28, height: 5)
            }
        }
        .accessibilityElement()
        .accessibilityLabel(supplies.map(\.spoken).joined(separator: ". "))
    }
}

/// Every supply with its level, for a printer's page.
struct SupplyList: View {
    let supplies: [Supply]

    var body: some View {
        ForEach(supplies, id: \.self) { supply in
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(supply.name)
                    Spacer()
                    Text(supply.percent.map { "\($0)%" } ?? "Unknown").foregroundStyle(supply.isLow ? .orange : .secondary)
                }
                ProgressView(value: Double(supply.percent ?? 0), total: 100).tint(supply.tint)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(supply.spoken)
        }
    }
}

extension Supply {
    /// The printer's own color for this supply; black shows as the text color so it stays visible in dark mode.
    var tint: Color {
        guard let hex = color?.trimmingCharacters(in: CharacterSet(charactersIn: "#")), hex.count == 6, let value = UInt32(hex, radix: 16) else {
            return .accentColor
        }
        let (r, g, b) = (Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255, Double(value & 0xFF) / 255)
        return r + g + b < 0.3 ? .primary : Color(red: r, green: g, blue: b)
    }
}
