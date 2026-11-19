import PrintBetterKit
import SwiftUI
import VisionKit

/// The camera, looking for the pairing QR code on the web app's Add a device page.
struct QRScannerSheet: View {
    let onFound: @MainActor (PairingLink) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var wrongCode = false

    var body: some View {
        NavigationStack {
            Group {
                if QRScanner.isAvailable {
                    QRScanner(onFound: found, onOther: { wrongCode = true })
                        .ignoresSafeArea()
                        .overlay(alignment: .bottom) { hint }
                } else {
                    ContentUnavailableView(
                        "Camera Not Available", systemImage: "camera",
                        description: Text("Allow camera access in Settings > Apps > Print Better, or connect with your server address instead."))
                }
            }
            .navigationTitle("Scan QR Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
            }
        }
        .sensoryFeedback(.error, trigger: wrongCode) { _, isWrong in isWrong }
    }

    private var hint: some View {
        Text(wrongCode ? "This isn't a Print Better pairing code. In the web app, open Devices > Add a device and choose iPhone or iPad." : "In the web app, open Devices > Add a device and choose iPhone or iPad. Then point the camera at the QR code.")
            .font(.callout)
            .multilineTextAlignment(.center)
            .padding()
            .glassEffect(in: .rect(cornerRadius: 20))
            .padding()
    }

    private func found(_ link: PairingLink) {
        onFound(link)
        dismiss()
    }
}

private struct QRScanner: UIViewControllerRepresentable {
    let onFound: @MainActor (PairingLink) -> Void
    let onOther: @MainActor () -> Void

    static var isAvailable: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false, isGuidanceEnabled: true, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.parent = self
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var parent: QRScanner
        private var done = false

        init(parent: QRScanner) {
            self.parent = parent
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for case let .barcode(code) in addedItems {
                guard !done, let text = code.payloadStringValue else { continue }
                if let link = PairingLink(string: text) {
                    done = true
                    parent.onFound(link)
                } else {
                    parent.onOther()
                }
            }
        }
    }
}
