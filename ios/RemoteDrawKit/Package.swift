// swift-tools-version: 5.9
import PackageDescription

// Everything about the connection that does not need UIKit or PencilKit, so it
// can be tested on the Mac with `swift test`.
let package = Package(
    name: "RemoteDrawKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "RemoteDrawKit", targets: ["RemoteDrawKit"])],
    targets: [
        .target(name: "RemoteDrawKit"),
        .testTarget(name: "RemoteDrawKitTests", dependencies: ["RemoteDrawKit"]),
    ]
)
