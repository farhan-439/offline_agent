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
//   KINDRED_WHISPER_MULTI_MODEL      multilingual WhisperKit folder (openai_whisper-small) for translation
//   KINDRED_WHISPER_MULTI_TOKENIZER  its tokenizer (openai/whisper-small)
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

/// Same, for the multilingual model: Whisper detects the language (per 30 s window) instead of forcing English.
let sessionMultiDecodeOptions = DecodingOptions(
    verbose: false, task: .transcribe, language: nil, temperature: 0,
    usePrefillPrompt: true, detectLanguage: true, skipSpecialTokens: true, withoutTimestamps: false, wordTimestamps: true, suppressBlank: true
)

/// Text-only decoding of one short clip (live chunks, per-utterance translation). `language: nil` = detect.
/// `task: .translate` makes Whisper write English whatever the input language.
func clipDecodeOptions(task: DecodingTask, language: String?) -> DecodingOptions {
    DecodingOptions(verbose: false, task: task, language: language, temperature: 0, temperatureFallbackCount: 2,
                    usePrefillPrompt: true, detectLanguage: language == nil, skipSpecialTokens: true, withoutTimestamps: true,
                    wordTimestamps: false, suppressBlank: true, compressionRatioThreshold: 2.4, logProbThreshold: -1.0,
                    firstTokenLogProbThreshold: -1.5, noSpeechThreshold: 0.6)
}

func loadWhisper() async throws -> WhisperKit {
    try await loadWhisper(modelKey: "KINDRED_WHISPER_MODEL", model: "whisper-model", tokenizerKey: "KINDRED_WHISPER_TOKENIZER",
                          tokenizer: "whisper-tokenizer", staged: "whisper-staged", fallbackVariant: env("KINDRED_WHISPER_VARIANT") ?? "base.en", label: "whisper")
}

/// Multilingual Whisper for translation (language detection + `task: .translate`). base.en can't do either.
/// openai_whisper-small: 486 MB, the smallest size whose X→English translation is usable
/// (base/tiny multilingual translate poorly; medium is 1.5 GB and ~3× slower to decode).
let defaultMultiVariant = "openai_whisper-small"

func loadWhisperMulti() async throws -> WhisperKit {
    try await loadWhisper(modelKey: "KINDRED_WHISPER_MULTI_MODEL", model: "whisper-multi-model", tokenizerKey: "KINDRED_WHISPER_MULTI_TOKENIZER",
                          tokenizer: "whisper-multi-tokenizer", staged: "whisper-multi-staged",
                          fallbackVariant: env("KINDRED_WHISPER_MULTI_VARIANT") ?? defaultMultiVariant, label: "whisper-multi")
}

func loadWhisper(modelKey: String, model defaultModel: String, tokenizerKey: String, tokenizer defaultTokenizer: String,
                 staged: String, fallbackVariant: String, label: String) async throws -> WhisperKit {
    let t0 = Date()
    defer { Out.log("\(label) ready in \(Int(Date().timeIntervalSince(t0) * 1000)) ms") }
    if let model = modelPath(modelKey, defaultModel) {
        if let tokenizer = modelPath(tokenizerKey, defaultTokenizer) {
            let staging = kindredCache.appendingPathComponent(staged)
            try stageWhisper(model: model, tokenizer: tokenizer, into: staging)
            return try await WhisperKit(WhisperKitConfig(modelFolder: staging.path, tokenizerFolder: staging, verbose: false, prewarm: false, load: true, download: false))
        }
        Out.log("warning: no local \(label) tokenizer (\(tokenizerKey)); WhisperKit may try the network for it")
        return try await WhisperKit(WhisperKitConfig(modelFolder: model, verbose: false, download: false))
    }
    Out.log("warning: no local \(label) model (\(modelKey)); downloading — needs internet. Run `kindred-capture provision` once online.")
    return try await WhisperKit(WhisperKitConfig(model: fallbackVariant, verbose: false))
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
/// Default voice "aiden": in an 11/15 test (8 lines × 3 takes, scored by Whisper) ryan ran long, laughed or
/// produced noise on 7–9 of 24 clips even with calm sampling; aiden with calm sampling on 1 of 24.
func voice(_ name: String? = nil) -> Qwen3Speaker { Qwen3Speaker(rawValue: name ?? env("KINDRED_VOICE") ?? "aiden") ?? .aiden }

/// Sampling tuned in Second Nature for short, natural lines. Budget scales with text length
/// (Kindred whisper lines are ≤ ~30 words / 220 chars).
func whisperLineOptions(chars: Int, language: Qwen3Language = .english) -> GenerationOptions {
    // Qwen3-TTS emits ~12 audio tokens a second. One Chinese/Japanese/Korean character is a whole
    // syllable, so budget per character there, or long lines get cut off.
    let dense: Set<Qwen3Language> = [.chinese, .japanese, .korean]
    // Tunable while we test (KINDRED_TTS_TEMPERATURE / _TOPK / _PENALTY / _BUDGET = tokens per character).
    // Calm, plain delivery (no laughs or expressive noises): lower temperature and top-K than the
    // expressive profile, and a tighter token budget so the model can't ramble past the words.
    let temperature = env("KINDRED_TTS_TEMPERATURE").flatMap(Float.init) ?? 0.5
    let topK = env("KINDRED_TTS_TOPK").flatMap(Int.init) ?? 20
    let penalty = env("KINDRED_TTS_PENALTY").flatMap(Float.init) ?? 1.1
    let perChar = env("KINDRED_TTS_BUDGET").flatMap(Double.init) ?? 0.9
    let budget = dense.contains(language) ? chars * 5 + 20 : Int(Double(chars) * perChar) + 20
    return GenerationOptions(temperature: temperature, topK: topK, repetitionPenalty: penalty, maxNewTokens: min(240, max(40, budget)), concurrentWorkerCount: 1)
}

/// BCP-47 code ("fr", "zh-CN") → a language Qwen3-TTS can speak, or nil if it can't.
func ttsLanguage(_ code: String?) -> Qwen3Language? {
    guard let code, let base = code.lowercased().split(separator: "-").first else { return .english }
    let map: [String: Qwen3Language] = ["en": .english, "zh": .chinese, "ja": .japanese, "ko": .korean, "de": .german,
                                        "fr": .french, "ru": .russian, "pt": .portuguese, "es": .spanish, "it": .italian]
    return map[String(base)]
}

/// The voice for a language: Qwen3-TTS's native speakers where it has one, else the English default
/// (KINDRED_VOICE, default "aiden"). An explicit voice name always wins.
func voice(_ name: String?, for language: Qwen3Language) -> Qwen3Speaker {
    if let name, let v = Qwen3Speaker(rawValue: name) { return v }
    switch language {
        case .chinese: return .vivian
        case .japanese: return .onoAnna
        case .korean: return .sohee
        default: return voice()
    }
}
