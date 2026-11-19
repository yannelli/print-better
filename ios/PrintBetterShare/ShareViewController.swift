import PrintBetterKit
import SwiftUI
import UIKit

/// The share extension's entry point: hosts the SwiftUI sheet and hands it what was shared.
final class ShareViewController: UIViewController {
    private lazy var model = ShareModel { [weak self] in
        self?.extensionContext?.completeRequest(returningItems: nil)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        ThisDevice.model = UIDevice.current.model
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        Task { await model.start(with: providers) }
    }
}
