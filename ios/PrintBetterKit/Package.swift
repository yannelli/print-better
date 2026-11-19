// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "PrintBetterKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "PrintBetterKit", targets: ["PrintBetterKit"])
    ],
    targets: [
        .target(name: "PrintBetterKit"),
        .testTarget(name: "PrintBetterKitTests", dependencies: ["PrintBetterKit"]),
    ]
)
