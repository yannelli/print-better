import Foundation
import Testing

@testable import PrintBetterKit

/// The `remote_printers` fixture the desktop client tests use (client/crates/app/tests/fixtures/protocol).
let printersJSON = """
    {"printers":[{"id":"pr_07","name":"Upstairs laser","location":"Office","makeModel":"Brother HL-L2350DW series",
    "uuid":"7d3b9a1e-2c4f-4e8a-9b6d-1f0e5c2a8b34","clientName":"Den Pi","online":true,"state":"idle",
    "capabilities":{"formats":["application/pdf","image/urf"],"color":false,"duplex":true,"media":["na_letter_8.5x11in","iso_a4_210x297mm"],
    "mediaDefault":"na_letter_8.5x11in","resolutions":[300,600],"copiesMax":99,"sources":["auto","tray-1","manual"],
    "mediaTypes":["stationery","labels"],"qualities":["normal","high","ultra"]},"defaults":{"sides":"two-sided-long-edge","fit":"none"},
    "supplies":[{"name":"Black Toner","kind":"toner","color":"#000000","level":64}]},
    {"id":"pr_08","name":"Label maker","location":null,"makeModel":null,"uuid":null,"clientName":"Garage Mac","online":false,
    "state":"sleeping","capabilities":{"formats":[],"color":false,"duplex":false,"media":[],"mediaDefault":null,"resolutions":[],"copiesMax":1},
    "defaults":{"colorMode":"sepia"}}]}
    """

let jobJSON = """
    {"job":{"id":"job_1","workspaceId":"ws_1","printerId":"pr_07","printerName":"Upstairs laser","userId":null,"source":"device",
    "title":"Boarding pass","fileName":"Boarding pass.pdf","contentType":"application/pdf","size":1234,"options":{"copies":2},
    "status":"completed","statusMessage":"Toner is low","pages":1,"attempts":1,"hasFile":true,"createdAt":1763560000000,
    "updatedAt":1763560005000,"completedAt":1763560005000,"sourceClientId":"c_1","sourceClientName":"Front Desk iPhone","requestedBy":null}}
    """

struct ModelTests {
    @Test func decodesTheRemotePrintersSnapshot() throws {
        let printers = try JSONDecoder().decode(PrintersEnvelope.self, from: Data(printersJSON.utf8)).printers
        #expect(printers.map(\.id) == ["pr_07", "pr_08"])
        let laser = printers[0]
        #expect(laser.capabilities.sources == ["auto", "tray-1", "manual"])
        #expect(laser.capabilities.qualities == [.normal, .high], "unknown qualities are dropped")
        #expect(laser.defaults == JobOptions(sides: .twoSidedLongEdge, fit: .actualSize))
        #expect(laser.supplies.first?.percent == 64)
        let labels = printers[1]
        #expect(labels.state == .unknown, "a state this app doesn't know yet")
        #expect(labels.supplies.isEmpty, "older servers leave supplies out")
        #expect(labels.defaults.colorMode == nil)
        #expect(labels.capabilities.sources == nil)
    }

    @Test func decodesAJobAndItsWarning() throws {
        let job = try JSONDecoder().decode(JobEnvelope.self, from: Data(jobJSON.utf8)).job
        #expect(job.status == .completed)
        #expect(job.printedWithProblem)
        #expect(job.options.copies == 2)
        #expect(job.created == Date(timeIntervalSince1970: 1_763_560_000))
        #expect(job.status() == StatusWords("Printed with a problem", .warn, detail: "Toner is low"))
    }

    @Test func decodesAHeldJobAsWaitingForAnOwnerOrAdmin() throws {
        let held = jobJSON
            .replacingOccurrences(of: #""status":"completed","statusMessage":"Toner is low""#, with: #""status":"held","statusMessage":"Waiting for approval""#)
            .replacingOccurrences(of: #""requestedBy":null"#, with: #""requestedBy":null,"held":{"kind":"approval","until":1763574400000,"reasons":["Over the limit Monthly pages"]}"#)
        let job = try JSONDecoder().decode(JobEnvelope.self, from: Data(held.utf8)).job
        #expect(job.status == .held && job.held?.kind == .approval)
        #expect(job.canCancel && !job.status.isMoving)
        #expect(job.status() == StatusWords("Waiting", .neutral, detail: "Waiting for approval. An owner or admin can approve it in the web app."))
    }

    @Test func encodesOnlyTheOptionsSomeoneSet() throws {
        let data = try JSONEncoder().encode(JobOptions(copies: 3, sides: .twoSidedShortEdge, fit: .actualSize))
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object.count == 3)
        #expect(object["sides"] as? String == "two-sided-short-edge")
        #expect(object["fit"] as? String == "none")
        #expect(JobOptions().isEmpty)
    }

    @Test func describesTheDeviceAsAnIPhoneOrAnIPad() throws {
        let data = try JSONEncoder().encode(DeviceInfo(name: "  Front Desk iPhone ", version: "1.0", token: "pbe_1"))
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(object == ["hostname": "Front Desk iPhone", "name": "Front Desk iPhone", "os": "ios", "arch": "arm64", "version": "1.0", "token": "pbe_1"])
        let blank = try JSONEncoder().encode(DeviceInfo(name: " ", version: "1.0"))
        let fallback = try #require(JSONSerialization.jsonObject(with: blank) as? [String: String])
        #expect(fallback["hostname"] == "iPhone")
        #expect(fallback["name"] == nil && fallback["token"] == nil)
        let iPad = try JSONEncoder().encode(DeviceInfo(name: "", version: "1.0", model: "iPad"))
        let tablet = try #require(JSONSerialization.jsonObject(with: iPad) as? [String: String])
        #expect(tablet["hostname"] == "iPad" && tablet["os"] == "ipados")
    }
}
