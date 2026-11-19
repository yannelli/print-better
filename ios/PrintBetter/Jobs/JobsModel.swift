import Foundation
import Observation
import PrintBetterKit

/// The jobs this iPhone sent, newest first.
@Observable @MainActor
final class JobsModel {
    let client: APIClient
    private(set) var jobs: [Job] = []
    private(set) var loaded = false
    var error: String?
    /// Called when the server says this iPhone was removed.
    @ObservationIgnored var onRevoked: (@MainActor () -> Void)?

    init(client: APIClient) {
        self.client = client
    }

    var hasActiveJobs: Bool { jobs.contains { !$0.status.isFinished } }

    func load() async {
        do {
            jobs = try await client.recentJobs()
            error = nil
        } catch {
            report(error)
        }
        loaded = true
    }

    func cancel(_ job: Job) async {
        do {
            let canceled = try await client.cancelJob(id: job.id)
            if let index = jobs.firstIndex(where: { $0.id == canceled.id }) { jobs[index] = canceled }
        } catch {
            report(error)
        }
    }

    private func report(_ error: any Error) {
        if error is CancellationError { return }
        if case PrintBetterError.revoked = error { onRevoked?() }
        self.error = error.localizedDescription
    }
}
