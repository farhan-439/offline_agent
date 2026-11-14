// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "KindredCapture",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "kindred-capture", targets: ["KindredCapture"])],
    dependencies: [
        // Open-source Argmax SDK: WhisperKit (speech-to-text), SpeakerKit (diarization), TTSKit (speech).
        // The Pro SDK (voiceprints, streaming) is added here once the API key is configured — see capture/README.md.
        .package(url: "https://github.com/argmaxinc/argmax-oss-swift.git", exact: "0.18.0"),
    ],
    targets: [
        .executableTarget(name: "KindredCapture", dependencies: [
            .product(name: "WhisperKit", package: "argmax-oss-swift"),
            .product(name: "SpeakerKit", package: "argmax-oss-swift"),
            .product(name: "TTSKit", package: "argmax-oss-swift"),
        ]),
    ]
)
