import Foundation
import WhisperKit
import SpeakerKit
import TTSKit
import Argmax

// Offline model loading. Ported from local_ai/speech-helper and extended with SpeakerKit.
//
// Every model is read from a local folder so the demo works with Wi-Fi off. Defaults live under
// ~/Library/Caches/Kindred/; each can be overridden with an env var:
//   KINDRED_WHISPER_MODEL      WhisperKit Core ML folder (MelSpectrogram/AudioEncoder/TextDecoder)
//   KINDRED_WHISPER_TOKENIZER  folder with tokenizer.json + tokenizer_config.json
//   KINDRED_SPEAKER_MODEL      SpeakerKit (pyannote) Core ML folder
//   KINDRED_TTS_MODEL          TTSKit Qwen3-TTS 0.6B folder
//   KINDRED_TTS_TOKENIZER      Qwen/Qwen3-0.6B tokenizer folder
// If a folder is missing, the loader falls back to downloading (needs internet) and says so on
// stderr — useful once for provisioning, never during the demo.

let kindredCache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Kindred")

func modelPath(_ envKey: String, _ defaultName: String) -> String? {
    let path = env(envKey) ?? kindredCache.appendingPathComponent(defaultName).path
    return FileManager.default.fileExists(atPath: path) ? path : nil
}

/// Links local Core ML components + tokenizer files into one stable folder WhisperKit can load.
/// A stable path (not a random temp dir) lets Core ML reuse its compiled-model cache across launches.
func stageWhisper(model: String, tokenizer: String, into staging: URL) throws {
    let fm = FileManager.default
    try? fm.removeItem(at: staging)
    try fm.createDirectory(at: staging, withIntermediateDirectories: true)
    for name in ["tokenizer.json", "tokenizer_config.json"] {
        let data = try Data(contentsOf: URL(fileURLWithPath: tokenizer).appendingPathComponent(name))
        guard (try JSONSerialization.jsonObject(with: data)) is [String: Any] else { throw Failure(message: "Invalid local \(name)") }
        try data.write(to: staging.appendingPathComponent(name))
    }
    for name in ["MelSpectrogram", "AudioEncoder", "TextDecoder"] {
        let candidate = ["mlmodelc", "mlpackage"].map { URL(fileURLWithPath: model).appendingPathComponent("\(name).\($0)") }.first { fm.fileExists(atPath: $0.path) }
        guard let candidate else { throw Failure(message: "Missing local model component: \(name)") }
        try fm.createSymbolicLink(at: staging.appendingPathComponent(candidate.lastPathComponent), withDestinationURL: candidate)
    }
}

/// Decoding for session capture: word timestamps are required so SpeakerKit can assign speakers per word.
let sessionDecodeOptions = DecodingOptions(
    verbose: false, task: .transcribe, language: "en", temperature: 0,
    usePrefillPrompt: true, skipSpecialTokens: true, withoutTimestamps: false, wordTimestamps: true, suppressBlank: true
)

func loadWhisper() async throws -> WhisperKit {
    let t0 = Date()
    defer { Out.log("whisper ready in \(Int(Date().timeIntervalSince(t0) * 1000)) ms") }
    if let model = modelPath("KINDRED_WHISPER_MODEL", "whisper-model") {
        if let tokenizer = modelPath("KINDRED_WHISPER_TOKENIZER", "whisper-tokenizer") {
            let staging = kindredCache.appendingPathComponent("whisper-staged")
            try stageWhisper(model: model, tokenizer: tokenizer, into: staging)
            return try await WhisperKit(WhisperKitConfig(modelFolder: staging.path, tokenizerFolder: staging, verbose: false, prewarm: false, load: true, download: false))
        }
        Out.log("warning: no local Whisper tokenizer (KINDRED_WHISPER_TOKENIZER); WhisperKit may try the network for it")
        return try await WhisperKit(WhisperKitConfig(modelFolder: model, verbose: false, download: false))
    }
    Out.log("warning: no local Whisper model (KINDRED_WHISPER_MODEL); downloading — needs internet")
    return try await WhisperKit(WhisperKitConfig(model: env("KINDRED_WHISPER_VARIANT") ?? "base.en", verbose: false))
}

/// Pyannote diarization (it produces the per-speaker centroid embeddings we use as voiceprints).
/// Runs through SpeakerKitPro when the Pro license is active (call setupPro() first), else open-source SpeakerKit.
func loadSpeakerKit() async throws -> SpeakerKit {
    let t0 = Date()
    defer { Out.log("speakerkit\(proEnabled ? " pro" : "") ready in \(Int(Date().timeIntervalSince(t0) * 1000)) ms") }
    let config: PyannoteConfig
    if let folder = modelPath("KINDRED_SPEAKER_MODEL", "speaker-model") {
        config = PyannoteConfig(modelFolder: folder, download: false, load: true, verbose: false)
    } else {
        Out.log("warning: no local SpeakerKit model (KINDRED_SPEAKER_MODEL); downloading — needs internet")
        config = PyannoteConfig(load: true, verbose: false)
    }
    return proEnabled ? try await SpeakerKitPro(config) : try await SpeakerKit(config)
}

func loadTTS() async throws -> TTSKit {
    let t0 = Date()
    defer { Out.log("tts ready in \(Int(Date().timeIntervalSince(t0) * 1000)) ms") }
    if let model = modelPath("KINDRED_TTS_MODEL", "tts-model") {
        if let tokenizer = modelPath("KINDRED_TTS_TOKENIZER", "tts-tokenizer") {
            return try await TTSKit(TTSKitConfig(model: .qwen3TTS_0_6b, modelFolder: URL(fileURLWithPath: model), tokenizerFolder: URL(fileURLWithPath: tokenizer),
                                                 verbose: false, download: false, prewarm: false, load: true, seed: nil))
        }
        Out.log("warning: no local TTS tokenizer (KINDRED_TTS_TOKENIZER); TTSKit may try the network for it")
        return try await TTSKit(modelFolder: URL(fileURLWithPath: model))
    }
    Out.log("warning: no local TTS model (KINDRED_TTS_MODEL); downloading — needs internet")
    return try await TTSKit()
}

/// Ryan and Aiden are Qwen3-TTS's native-English voices.
func voice(_ name: String? = nil) -> Qwen3Speaker { Qwen3Speaker(rawValue: name ?? env("KINDRED_VOICE") ?? "ryan") ?? .ryan }

/// Sampling tuned in Second Nature for short, natural lines. Budget scales with text length
/// (Kindred whisper lines are ≤ ~30 words / 220 chars).
func whisperLineOptions(chars: Int) -> GenerationOptions {
    GenerationOptions(temperature: 0.9, topK: 50, repetitionPenalty: 1.08, maxNewTokens: min(240, max(60, chars + 20)), concurrentWorkerCount: 1)
}
