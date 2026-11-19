import Foundation

/// The device endpoints in docs/protocol.md that an iPhone or iPad uses.
extension APIClient {
    public func instance() async throws -> InstanceInfo {
        try await get("/api/instance")
    }

    public func startPairing(_ device: DeviceInfo) async throws -> DeviceCode {
        try await post("/api/client/device/code", device)
    }

    public func pollPairing(deviceCode: String) async throws -> IssuedDevice {
        try await post("/api/client/device/token", DevicePoll(deviceCode: deviceCode))
    }

    /// Pairs with a single-use `pbe_` code from the web app's Add a device page.
    public func enroll(_ device: DeviceInfo) async throws -> IssuedDevice {
        try await post("/api/client/enroll", device)
    }

    public func identity() async throws -> ClientIdentity {
        try await get("/api/client/me")
    }

    /// The workspace printers this device may print to.
    public func printers() async throws -> [Printer] {
        let envelope: PrintersEnvelope = try await get("/api/client/printers")
        return envelope.printers
    }

    /// Jobs this device sent, newest first.
    public func recentJobs(limit: Int = 30) async throws -> [Job] {
        let page: Page<Job> = try await get("/api/client/jobs", query: [URLQueryItem(name: "limit", value: String(limit))])
        return page.items
    }

    public func job(id: String) async throws -> Job {
        let envelope: JobEnvelope = try await get("/api/client/jobs/\(id)")
        return envelope.job
    }

    public func cancelJob(id: String) async throws -> Job {
        let envelope: JobEnvelope = try await post("/api/client/jobs/\(id)/cancel", NoBody())
        return envelope.job
    }
}
