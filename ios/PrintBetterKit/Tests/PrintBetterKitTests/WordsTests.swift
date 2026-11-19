import Foundation
import Testing

@testable import PrintBetterKit

struct WordsTests {
    @Test func printerStatusMatchesTheWebApp() {
        let printer = Printer(id: "p", name: "Laser", location: "Office", clientName: "Den Pi")
        #expect(printer.status == StatusWords("Ready", .ok))
        #expect(printer.whereabouts == "Office, on Den Pi")
        var away = printer
        away.online = false
        #expect(away.status.label == "Offline")
        #expect(away.status.detail == "Den Pi is turned off or not connected. Jobs wait until it's back.")
        var jammed = printer
        jammed.state = .stopped
        #expect(jammed.status.tone == .warn)
        var gone = printer
        (gone.online, gone.state) = (false, .offline)
        #expect(gone.status.label == "Not responding")
    }

    @Test func jobStatusSaysWhatHappened() {
        let printer = Printer(id: "p", name: "Laser", clientName: "Den Pi", online: false)
        let waiting = Job(id: "j", printerId: "p", printerName: "Laser", title: "Report", status: .queued)
        #expect(waiting.status(printer: printer).detail == "Waiting for Den Pi to come online.")
        #expect(Job(id: "j", printerId: "p", printerName: "Laser", title: "Report", status: .completed).status() == StatusWords("Printed", .ok))
        let failed = Job(id: "j", printerId: "p", printerName: "Laser", title: "Report", status: .failed, statusMessage: "Out of paper")
        #expect(failed.status() == StatusWords("Didn't print", .bad, detail: "Out of paper"))
        #expect(failed.canCancel == false)
    }

    @Test func namesPaperTraysAndTypes() {
        #expect(OptionWords.paperName("na_letter_8.5x11in") == "Letter (8.5 × 11 in)")
        #expect(OptionWords.paperName("iso_a4_210x297mm") == "A4 (210 × 297 mm)")
        #expect(OptionWords.paperName("na_index-4x6_4x6in") == "4 × 6 in photo")
        #expect(OptionWords.paperName("om_square-photo_89x89mm") == "Square photo (89 × 89 mm)")
        #expect(OptionWords.paperName("custom") == "custom")
        #expect(OptionWords.trayName("tray-2") == "Tray 2")
        #expect(OptionWords.trayName("manual") == "Manual feed")
        #expect(OptionWords.paperTypeName("photographic-glossy") == "Glossy photo paper")
        #expect(OptionWords.isStandardPaperType("com.hp.ecosmart-lite") == false)
        #expect(OptionWords.sidesName(.twoSidedLongEdge) == "Both sides, like a book")
    }

    @Test func pageRangesFollowTheServerRule() {
        #expect(PageRanges.isValid("1-3,5"))
        #expect(PageRanges.isValid(" 2 - 4 , 7 "))
        #expect(!PageRanges.isValid("1-"))
        #expect(!PageRanges.isValid("all"))
        #expect(PageRanges.normalized(" 2 - 4 , 7 ") == "2-4,7")
        #expect(PageRanges.normalized("  ") == nil)
    }

    @Test func readsPaperSizesFromMediaNames() throws {
        #expect(PaperSize(pwg: "na_letter_8.5x11in") == .letter)
        let a4 = try #require(PaperSize(pwg: "iso_a4_210x297mm"))
        #expect(abs(a4.width - PaperSize.a4.width) < 0.01 && abs(a4.height - PaperSize.a4.height) < 0.01)
        #expect(PaperSize(pwg: "na_index-4x6_4x6in") == PaperSize(width: 288, height: 432))
        #expect(PaperSize(pwg: "auto") == nil)
        #expect(PaperSize.regional(Locale(identifier: "en_US")) == .letter)
        #expect(PaperSize.regional(Locale(identifier: "de_DE")) == .a4)
    }
}
