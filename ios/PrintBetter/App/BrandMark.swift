import SwiftUI

/// The Print Better mark (a page leaving a printer), from docs/assets via scripts/make-ios-icon.sh.
struct BrandMark: View {
    let size: CGFloat

    var body: some View {
        Image("BrandMark")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .shadow(color: .black.opacity(0.18), radius: size / 10, y: size / 20)
            .accessibilityHidden(true)
    }
}
