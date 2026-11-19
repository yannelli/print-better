import PrintBetterKit
import SwiftUI

extension Tone {
    var color: Color {
        switch self {
        case .ok: .green
        case .warn: .orange
        case .bad: .red
        case .info: .accentColor
        case .neutral: .secondary
        }
    }

    var symbol: String {
        switch self {
        case .ok: "checkmark.circle.fill"
        case .warn: "exclamationmark.triangle.fill"
        case .bad: "xmark.octagon.fill"
        case .info: "printer.fill"
        case .neutral: "clock.fill"
        }
    }
}

/// A small tinted capsule, such as "Ready" or "Offline".
struct StatusBadge: View {
    let words: StatusWords

    var body: some View {
        Label(words.label, systemImage: words.tone.symbol)
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(words.tone.color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(words.tone.color.opacity(0.14), in: .capsule)
            .fixedSize()
    }
}

/// The live state of a job that was just sent, with a way to stop it while it's still waiting or printing.
struct JobStatusCard: View {
    let job: Job
    let printer: Printer?
    var onCancel: (() -> Void)?

    var body: some View {
        let words = job.status(printer: printer)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: words.tone.symbol)
                    .font(.title2)
                    .foregroundStyle(words.tone.color)
                    .symbolEffect(.pulse, isActive: job.status.isMoving)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(words.label).font(.headline)
                    Text("\(job.title) to \(job.printerName ?? printer?.name ?? "the printer")")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let detail = words.detail {
                        Text(detail).font(.subheadline)
                    }
                }
            }
            .accessibilityElement(children: .combine)
            if job.status.isMoving {
                ProgressView().progressViewStyle(.linear).accessibilityLabel("In progress")
            }
            if job.canCancel, let onCancel {
                Button("Cancel Print", role: .destructive, action: onCancel)
            }
        }
        .padding(.vertical, 4)
    }
}

/// Upload progress while the document goes to the server.
struct UploadProgressView: View {
    let fraction: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Sending to Print Better…").font(.headline)
            ProgressView(value: fraction)
                .accessibilityValue("\(Int(fraction * 100)) percent")
        }
        .padding(.vertical, 4)
    }
}

/// Success, warning and error haptics as a sent job finishes.
struct JobFeedback: ViewModifier {
    let job: Job?

    func body(content: Content) -> some View {
        content.sensoryFeedback(trigger: job?.status) { _, status in
            guard let job, status == job.status else { return nil }
            switch job.status {
            case .completed: return job.printedWithProblem ? .warning : .success
            case .failed: return .error
            default: return nil
            }
        }
    }
}

extension View {
    func jobFeedback(_ job: Job?) -> some View { modifier(JobFeedback(job: job)) }
}

/// A problem in plain words, shown where it happened instead of in an alert.
struct ErrorRow: View {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var body: some View {
        Label {
            Text(message)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }
}
