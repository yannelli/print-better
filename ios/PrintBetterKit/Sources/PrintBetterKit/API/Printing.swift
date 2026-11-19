import Foundation

public struct PrintRequest: Sendable {
    public var printerId: String
    public var document: PrintDocument
    /// Only the settings someone changed; the rest follow the printer's defaults.
    public var options: JobOptions

    public init(printerId: String, document: PrintDocument, options: JobOptions) {
        self.printerId = printerId
        self.document = document
        self.options = options
    }
}

extension APIClient {
    /// Opens an upload slot, then streams the file from disk. Returns the job once it's queued.
    public func submit(_ request: PrintRequest, progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> Job {
        let document = request.document
        let new = NewJob(
            printerId: request.printerId, title: document.title, contentType: document.kind.mimeType, size: document.size,
            fileName: document.fileName, options: request.options.isEmpty ? nil : request.options)
        let slot: JobSlot = try await post("/api/client/jobs", new)
        // The token only ever goes to this server, whatever origin the slot names.
        var upload = self.request("PUT", "/api/client/jobs/\(slot.job.id)/file")
        upload.setValue(document.kind.mimeType, forHTTPHeaderField: "Content-Type")
        upload.timeoutInterval = 120
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.upload(for: upload, fromFile: document.fileURL, delegate: UploadProgress(progress))
        } catch {
            throw PrintBetterError.transport(error, host: server.displayName)
        }
        let envelope: JobEnvelope = try decode(data, response)
        return envelope.job
    }

    /// Every change to a job until it finishes. Phones have no socket, so this polls.
    public func follow(jobId: String, every interval: Duration = .seconds(2)) -> AsyncThrowingStream<Job, any Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var last: Job?
                var misses = 0
                while !Task.isCancelled {
                    do {
                        let job = try await self.job(id: jobId)
                        misses = 0
                        if job != last { continuation.yield(job) }
                        last = job
                        if job.status.isFinished { break }
                    } catch let error as PrintBetterError where error.isTransient && misses < 30 {
                        misses += 1
                    } catch {
                        continuation.finish(throwing: error)
                        return
                    }
                    try? await Task.sleep(for: interval)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

final class UploadProgress: NSObject, URLSessionTaskDelegate, Sendable {
    private let report: @Sendable (Double) -> Void

    init(_ report: @escaping @Sendable (Double) -> Void) {
        self.report = report
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        report(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}
