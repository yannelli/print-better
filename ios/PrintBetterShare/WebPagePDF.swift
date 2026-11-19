import PrintBetterKit
import UIKit
import WebKit

/// A web page to print: Safari's copy of it as shown, or only its address when another app shared a link.
struct PageSnapshot: Sendable {
    var url: URL
    var title: String
    var html: String?
}

/// Lays a page out on the printer's paper with WebKit's own print layout, then writes it as a PDF.
@MainActor
enum WebPagePDF {
    static let margin: CGFloat = 36

    static func make(_ page: PageSnapshot, paper: PaperSize, in folder: URL) async throws -> PrintDocument {
        let configuration = WKWebViewConfiguration()
        // The snapshot already ran its scripts in Safari.
        configuration.defaultWebpagePreferences.allowsContentJavaScript = page.html == nil
        let webView = WKWebView(frame: paper.rect, configuration: configuration)
        let loader = PageLoader()
        webView.navigationDelegate = loader
        if let html = page.html {
            webView.loadHTMLString(html, baseURL: page.url)
        } else {
            webView.load(URLRequest(url: page.url))
        }
        try await loader.finished(within: .seconds(30))
        // Lets late images and fonts settle before the layout is fixed.
        try await Task.sleep(for: .milliseconds(500))
        let file = DocumentPreparer.pdfFile(titled: page.title, in: folder)
        try write(webView.viewPrintFormatter(), paper: paper, to: file)
        return try DocumentPreparer.madePDF(file, title: page.title)
    }

    private static func write(_ formatter: UIPrintFormatter, paper: PaperSize, to file: URL) throws {
        let renderer = PaperRenderer(paper: paper.rect, printable: paper.rect.insetBy(dx: margin, dy: margin))
        renderer.addPrintFormatter(formatter, startingAtPageAt: 0)
        let pages = renderer.numberOfPages
        guard pages > 0 else { throw PrintBetterError.message("The page came out empty. Open it in Safari and try again.") }
        try UIGraphicsPDFRenderer(bounds: paper.rect).writePDF(to: file) { context in
            renderer.prepare(forDrawingPages: NSRange(location: 0, length: pages))
            for index in 0..<pages {
                context.beginPage()
                renderer.drawPage(at: index, in: context.pdfContextBounds)
            }
        }
    }
}

/// UIPrintPageRenderer only reads the paper size from a print job, so this sets it directly.
private final class PaperRenderer: UIPrintPageRenderer {
    private let paper: CGRect
    private let printable: CGRect

    init(paper: CGRect, printable: CGRect) {
        self.paper = paper
        self.printable = printable
        super.init()
    }

    override var paperRect: CGRect { paper }
    override var printableRect: CGRect { printable }
}

/// Waits for the page and its images to load. A slow page prints with whatever arrived in time.
@MainActor
private final class PageLoader: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, any Error>?
    private var outcome: Result<Void, any Error>?

    func finished(within limit: Duration) async throws {
        let timer = Task { [weak self] in
            try await Task.sleep(for: limit)
            self?.finish(.success(()))
        }
        defer { timer.cancel() }
        try await withCheckedThrowingContinuation { continuation in
            if let outcome { continuation.resume(with: outcome) } else { self.continuation = continuation }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finish(.success(()))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        fail(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        fail(error)
    }

    private func fail(_ error: any Error) {
        // A redirect or a script starting another load cancels the first one; the next load reports for itself.
        if (error as NSError).code == NSURLErrorCancelled { return }
        finish(.failure(PrintBetterError.message("The page couldn't be loaded. \(error.localizedDescription)")))
    }

    private func finish(_ result: Result<Void, any Error>) {
        guard outcome == nil else { return }
        outcome = result
        continuation?.resume(with: result)
        continuation = nil
    }
}
