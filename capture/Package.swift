// swift-tools-version: 5.9
import PackageDescription

// Embed Info.plist (microphone purpose string) so `record`/`serve` can ask for mic access from a CLI binary.
let here = String(#filePath.prefix(upTo: #filePath.lastIndex(of: "/")!))

let package = Package(
    name: "KindredCapture",
    platforms: [.macOS("15.0")],
    products: [.executable(name: "kindred-capture", targets: ["KindredCapture"])],
    dependencies: [
        // Open-source Argmax SDK: WhisperKit (speech-to-text), SpeakerKit (diarization + voiceprint centroids), TTSKit (speech).
        // Pinned to the exact version the Pro SDK below depends on.
        .package(url: "https://github.com/argmaxinc/argmax-oss-swift.git", exact: "1.1.1"),
        // Argmax Pro SDK (SpeakerKitPro, streaming, LiveTranscriber). Private registry: needs
        // `swift package-registry login https://api.argmaxinc.com/v1/sdk/login` and Swift 6.3+.
        .package(id: "argmaxinc.argmax-sdk-swift", exact: "3.1.8"),
    ],
    targets: [
        .executableTarget(
            name: "KindredCapture",
            dependencies: [
                .product(name: "WhisperKit", package: "argmax-oss-swift"),
                .product(name: "SpeakerKit", package: "argmax-oss-swift"),
                .product(name: "TTSKit", package: "argmax-oss-swift"),
                .product(name: "Argmax", package: "argmaxinc.argmax-sdk-swift"),
            ],
            linkerSettings: [.unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", here + "/Info.plist"])]
        ),
    ]
)
