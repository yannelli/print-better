import PrintBetterKit
import SwiftUI

/// Recent jobs from this iPhone. Refreshes every few seconds while one is still waiting or printing.
struct JobsView: View {
    let jobs: JobsModel
    let printers: [Printer]
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        List {
            if let error = jobs.error {
                Section { ErrorRow(error) }
            }
            ForEach(jobs.jobs) { job in
                JobRow(job: job, printer: printers.first { $0.id == job.printerId })
                    .swipeActions {
                        if job.canCancel {
                            Button("Cancel Print", systemImage: "xmark", role: .destructive) { Task { await jobs.cancel(job) } }
                        }
                    }
                    .contextMenu {
                        if job.canCancel {
                            Button("Cancel Print", systemImage: "xmark", role: .destructive) { Task { await jobs.cancel(job) } }
                        }
                    }
            }
        }
        .overlay {
            if jobs.loaded, jobs.jobs.isEmpty, jobs.error == nil {
                ContentUnavailableView("No Jobs Yet", systemImage: "tray", description: Text("Documents you print from this iPhone show up here."))
            } else if !jobs.loaded {
                ProgressView()
            }
        }
        .navigationTitle("Jobs")
        .refreshable { await jobs.load() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await jobs.load()
                try? await Task.sleep(for: .seconds(jobs.hasActiveJobs ? 3 : 20))
            }
        }
    }
}

/// A job's title, printer, when it was sent and how it's going.
struct JobRow: View {
    let job: Job
    let printer: Printer?

    var body: some View {
        let words = job.status(printer: printer)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(job.title).font(.body.weight(.medium)).lineLimit(2)
                Spacer(minLength: 8)
                StatusBadge(words: words)
            }
            Text("\(job.printerName ?? printer?.name ?? "Printer removed"), \(job.created.formatted(.relative(presentation: .named)))")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let detail = words.detail {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(words.tone == .warn || words.tone == .bad ? words.tone.color : .secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
