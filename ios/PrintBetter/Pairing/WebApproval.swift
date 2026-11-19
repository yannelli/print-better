import AuthenticationServices
import UIKit

/// The server's approval page in a Safari sheet, which shares Safari's sign-in so most people only tap Approve.
@MainActor
final class WebApproval: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    /// The page never redirects back; the app closes the sheet itself once the server issues a token.
    func open(_ url: URL) -> Bool {
        session?.cancel()
        let session = ASWebAuthenticationSession(url: url, callback: .customScheme("printbetter")) { _, _ in }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        self.session = session
        return session.start()
    }

    func close() {
        session?.cancel()
        session = nil
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let window = scenes.compactMap(\.keyWindow).first ?? scenes.first?.windows.first { return window }
        // The page only opens from a button on screen, so a scene exists.
        return UIWindow(windowScene: scenes[0])
    }
}
