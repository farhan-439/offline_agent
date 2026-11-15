import Foundation
import WhisperKit
import SpeakerKit
import TTSKit
import Argmax

// `kindred-capture provision` — run ONCE with Wi-Fi on. Downloads every model into
// ~/Library/Caches/Kindred/hub, then links each into the folder name Models.swift loads offline:
//   whisper-model, whisper-tokenizer, speaker-model, tts-model, tts-tokenizer, sortformer-model (Pro),
//   whisper-multi-model, whisper-multi-tokenizer (multilingual Whisper for translation).
// After this, every command works with Wi-Fi off.

let hub = kindredCache.appendingPathComponent("hub")

/// Folders under `root` that directly contain a file or folder named `name`.
func folders(containing name: String, under root: URL) -> [URL] {
    guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return [] }
    var found: [URL] = []
    for case let url as URL in walker where url.lastPathComponent == name {
        found.append(url.deletingLastPathComponent())
        walker.skipDescendants()
    }
    return found
}

func link(_ name: String, to target: URL) throws {
    let at = kindredCache.appendingPathComponent(name)
    try? FileManager.default.removeItem(at: at)
    try FileManager.default.createSymbolicLink(at: at, withDestinationURL: target)
    Out.log("  \(name) → \(target.path)")
}

/// Download one WhisperKit Core ML variant + its OpenAI tokenizer and link both under the Kindred cache.
func provisionWhisper(variant: String, modelLink: String, tokenizerLink: String) async throws {
    let whisperFolder = try await WhisperKit.download(variant: variant, downloadBase: hub)
    // Loading once with downloadBase as the tokenizer folder fetches the matching tokenizer files
    // (and compiles the Core ML models once).
    _ = try await WhisperKit(WhisperKitConfig(downloadBase: hub, modelFolder: whisperFolder.path, tokenizerFolder: hub, verbose: false, load: true, download: false))
    try link(modelLink, to: whisperFolder)
    // Tokenizer repo for "openai_whisper-small_216MB" is "openai/whisper-small".
    let tokenizerName = variant.replacingOccurrences(of: "openai_", with: "")
        .replacingOccurrences(of: #"_\d+MB$"#, with: "", options: .regularExpression)
    let candidates = folders(containing: "tokenizer_config.json", under: hub).filter { $0.path.contains("openai") }
    guard let tok = candidates.first(where: { $0.lastPathComponent == tokenizerName }) ?? (candidates.count == 1 ? candidates.first : nil) else {
        throw Failure(message: "Whisper tokenizer \(tokenizerName) not found under \(hub.path)")
    }
    try link(tokenizerLink, to: tok)
}

/// `provision [--only whisper-multi]`: everything, or just the multilingual Whisper used for translation.
func provision(only: String? = nil) async throws {
    try FileManager.default.createDirectory(at: hub, withIntermediateDirectories: true)
    let multiVariant = env("KINDRED_WHISPER_MULTI_VARIANT") ?? defaultMultiVariant
    if only == "whisper-multi" {
        Out.log("Whisper multilingual (\(multiVariant), translation)…")
        try await provisionWhisper(variant: multiVariant, modelLink: "whisper-multi-model", tokenizerLink: "whisper-multi-tokenizer")
        Out.log("done. Models are in \(kindredCache.path)")
        return
    }
    let variant = env("KINDRED_WHISPER_VARIANT") ?? "openai_whisper-base.en"

    Out.log("1/5 Whisper (\(variant))…")
    try await provisionWhisper(variant: variant, modelLink: "whisper-model", tokenizerLink: "whisper-tokenizer")

    Out.log("2/5 SpeakerKit (pyannote)…")
    _ = try await SpeakerKit(PyannoteConfig(downloadBase: hub.path, download: true, load: true, verbose: false))
    // Repo root holds speaker_segmenter/, speaker_embedder/, speaker_clusterer/ (each <version>/<variant>/).
    guard let speakerRoot = folders(containing: "speaker_embedder", under: hub).first else {
        throw Failure(message: "SpeakerKit models not found under \(hub.path)")
    }
    try link("speaker-model", to: speakerRoot)

    Out.log("3/5 TTSKit (Qwen3-TTS 0.6B)…")
    let ttsFolder = try await TTSKit.download(variant: .qwen3TTS_0_6b, downloadBase: hub)
    _ = try await TTSKit(TTSKitConfig(model: .qwen3TTS_0_6b, downloadBase: hub, verbose: false, load: true))
    try link("tts-model", to: ttsFolder)
    // TTSKit fetches the Qwen tokenizer into the default Hub cache (~/Documents/huggingface), not
    // downloadBase. Copy it into the Kindred cache so everything offline lives in one place.
    let hfDefault = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Documents/huggingface")
    let isQwen = { (u: URL) in u.path.lowercased().contains("qwen") && !u.path.contains("ttskit") }
    if let found = (folders(containing: "tokenizer_config.json", under: hub) + folders(containing: "tokenizer_config.json", under: hfDefault)).first(where: isQwen) {
        let dest = kindredCache.appendingPathComponent("tts-tokenizer-files")
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        for name in (try FileManager.default.contentsOfDirectory(atPath: found.path)) where name.hasSuffix(".json") || name.hasSuffix(".txt") {
            try FileManager.default.copyItem(at: found.appendingPathComponent(name), to: dest.appendingPathComponent(name))
        }
        try link("tts-tokenizer", to: dest)
    } else {
        Out.log("  warning: Qwen tokenizer not found; TTSKit may need the network for it")
    }

    Out.log("4/5 Sortformer (Argmax Pro, live speaker detection)…")
    if await setupPro() {
        _ = try await SpeakerKitPro(SortformerConfig(downloadBase: hub.path, verbose: false, download: true, load: true))
        if let sf = folders(containing: "sortformer", under: hub).first.map({ $0.appendingPathComponent("sortformer") })
            ?? folders(containing: "SortformerStreaming.mlmodelc", under: hub).first {
            try link("sortformer-model", to: sf.deletingLastPathComponent())
        } else {
            Out.log("  warning: Sortformer folder not found under \(hub.path); live detection will download it on first use")
        }
    } else {
        Out.log("  skipped (no Pro license) — live detection will use rolling pyannote")
    }
    Out.log("5/5 Whisper multilingual (\(multiVariant), translation)…")
    try await provisionWhisper(variant: multiVariant, modelLink: "whisper-multi-model", tokenizerLink: "whisper-multi-tokenizer")
    Out.log("done. Models are in \(kindredCache.path)")
}
