import PhotosUI
import PrintBetterKit
import SwiftUI
import UniformTypeIdentifiers

/// Which picker is open.
struct DocumentSources {
    var files = false
    var photos = false
    var camera = false
}

/// The rows that open each picker.
struct DocumentSourceRows: View {
    @Binding var sources: DocumentSources

    var body: some View {
        Button("Choose File", systemImage: "folder") { sources.files = true }
        Button("Choose Photos", systemImage: "photo.on.rectangle") { sources.photos = true }
        if DocumentScanner.isSupported {
            Button("Scan Document", systemImage: "doc.viewfinder") { sources.camera = true }
        }
    }
}

/// Presents Files, the photo picker and the document camera, and turns what comes back into a document.
struct DocumentPickers: ViewModifier {
    @Binding var sources: DocumentSources
    let session: PrintSession
    @State private var photos: [PhotosPickerItem] = []

    func body(content: Content) -> some View {
        content
            .fileImporter(isPresented: $sources.files, allowedContentTypes: [.pdf, .image, .plainText]) { result in
                switch result {
                case let .success(url): importFile(url)
                case let .failure(error): session.report(error)
                }
            }
            .photosPicker(isPresented: $sources.photos, selection: $photos, maxSelectionCount: 20, matching: .images)
            .onChange(of: photos) { _, items in importPhotos(items) }
            .fullScreenCover(isPresented: $sources.camera) {
                DocumentScanner(onScan: importScan, onError: session.report).ignoresSafeArea()
            }
    }

    private func importFile(_ url: URL) {
        Task {
            await session.prepare { folder in
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                return try await DocumentPreparer.file(at: url, in: folder)
            }
        }
    }

    private func importPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        photos = []
        let paper = session.paper
        Task {
            await session.prepare { folder in
                var files: [URL] = []
                defer { for file in files { try? FileManager.default.removeItem(at: file) } }
                for item in items {
                    if let photo = try await item.loadTransferable(type: PickedPhoto.self) { files.append(photo.url) }
                }
                let title = files.count == 1 ? "Photo" : "\(files.count) Photos"
                return try await DocumentPreparer.images(files, title: title, paper: paper, in: folder)
            }
        }
    }

    private func importScan(_ scan: ScannedPages) {
        let paper = session.paper
        Task {
            await session.prepare { folder in
                defer { try? FileManager.default.removeItem(at: scan.folder) }
                return try await DocumentPreparer.scan(scan.pages, title: scan.title, paper: paper, in: folder)
            }
        }
    }
}

/// A photo copied out of the library as a file, so even a large one never sits in memory whole.
struct PickedPhoto: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            let name = received.file.pathExtension.isEmpty ? "photo" : "photo.\(received.file.pathExtension)"
            let copy = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString)-\(name)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedPhoto(url: copy)
        }
    }
}
