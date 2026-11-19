import PrintBetterKit
import QuickLookThumbnailing
import SwiftUI

/// A preview of the first page, made by Quick Look so even a large PDF never loads into memory here.
struct DocumentThumbnail: View {
    let document: PrintDocument
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                Image(systemName: document.kind == .text ? "doc.plaintext" : "doc.richtext")
                    .font(.title)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 60, height: 76)
        .background(.background.secondary, in: .rect(cornerRadius: 8))
        .clipShape(.rect(cornerRadius: 8))
        .accessibilityHidden(true)
        .task(id: document.id) { image = await Self.thumbnail(of: document.fileURL) }
    }

    nonisolated static func thumbnail(of url: URL) async -> UIImage? {
        let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: 120, height: 152), scale: 3, representationTypes: .thumbnail)
        return try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request).uiImage
    }
}

/// The document row at the top of a print form.
struct DocumentRow: View {
    let document: PrintDocument

    var body: some View {
        HStack(spacing: 14) {
            DocumentThumbnail(document: document)
            VStack(alignment: .leading, spacing: 4) {
                Text(document.title).font(.headline).lineLimit(3)
                Text(document.summary).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
