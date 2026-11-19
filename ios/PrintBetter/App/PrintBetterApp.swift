import PrintBetterKit
import SwiftUI

@main
struct PrintBetterApp: App {
    @State private var model = AppModel()

    init() {
        ThisDevice.model = UIDevice.current.model
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onOpenURL { model.open($0) }
        }
    }
}
