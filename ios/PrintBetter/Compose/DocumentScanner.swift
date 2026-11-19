import PrintBetterKit
import SwiftUI
import VisionKit

/// Pages from the document camera, saved as JPEGs so the camera's images can be released at once.
struct ScannedPages: Sendable {
    let folder: URL
    let pages: [URL]
    let title: String

    @MainActor
    init(_ scan: VNDocumentCameraScan) throws {
        folder = try DocumentPreparer.workFolder()
        var pages: [URL] = []
        for index in 0..<scan.pageCount {
            let page = folder.appending(path: "page-\(index + 1).jpg")
            try autoreleasepool {
                guard let data = scan.imageOfPage(at: index).jpegData(compressionQuality: 0.85) else {
                    throw PrintBetterError.message("A scanned page couldn't be saved. Scan it again.")
                }
                try data.write(to: page)
            }
            pages.append(page)
        }
        self.pages = pages
        title = scan.title
    }
}

/// The system document camera: finds page edges, straightens them, and returns every page.
struct DocumentScanner: UIViewControllerRepresentable {
    let onScan: @MainActor (ScannedPages) -> Void
    let onError: @MainActor (any Error) -> Void
    @Environment(\.dismiss) private var dismiss

    static var isSupported: Bool { VNDocumentCameraViewController.isSupported }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let camera = VNDocumentCameraViewController()
        camera.delegate = context.coordinator
        return camera
    }

    func updateUIViewController(_ camera: VNDocumentCameraViewController, context: Context) {
        context.coordinator.parent = self
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency VNDocumentCameraViewControllerDelegate {
        var parent: DocumentScanner

        init(parent: DocumentScanner) {
            self.parent = parent
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            do {
                parent.onScan(try ScannedPages(scan))
            } catch {
                parent.onError(error)
            }
            parent.dismiss()
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            parent.dismiss()
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: any Error) {
            parent.onError(error)
            parent.dismiss()
        }
    }
}
