// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "FlowPassVisionOCR", platforms: [.macOS(.v13)], targets: [
  .target(name: "FlowPassVisionOCRCore"),
  .executableTarget(name: "FlowPassVisionOCR", dependencies: ["FlowPassVisionOCRCore"]),
  .testTarget(name: "FlowPassVisionOCRTests", dependencies: ["FlowPassVisionOCRCore"])
])
