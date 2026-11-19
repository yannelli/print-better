import Synchronization

/// What this device is called in sentences, such as "this iPad", and the `os` the server lists it under.
public enum ThisDevice {
    private static let storage = Mutex("iPhone")

    /// `UIDevice.current.model`, such as "iPhone" or "iPad". The app and the share extension set it at launch.
    public static var model: String {
        get { storage.withLock { $0 } }
        set { storage.withLock { $0 = newValue } }
    }

    /// `ipados` for an iPad, else `ios`.
    public static var os: String { os(for: model) }

    static func os(for model: String) -> String { model.hasPrefix("iPad") ? "ipados" : "ios" }
}
