// kindred-capture — the "device" half of Kindred. Everything here runs on-device with Argmax.
//
//   kindred-capture process <audio.wav> [--session ID] [--place TEXT] [--out data/inbox] [--translate]
//       transcribe (WhisperKit) + diarize (SpeakerKit) → session JSONL per docs/CONTRACT.md
//       (--translate: multilingual Whisper, adds `language` + English `translation` to foreign utterances)
//   kindred-capture record [--session ID] [--place TEXT] [--out data/inbox] [--audio-dir data/audio] [--seconds N]
//       record the mic until Enter (or N seconds), save the WAV, then process it as above
//   kindred-capture speak "<text>"
//       say a line with TTSKit (Qwen3-TTS, voice "aiden", calm sampling)
//   kindred-capture serve [--out data/inbox] [--audio-dir data/audio] [--no-tts 1] [--no-translate 1]
//       long-lived JSON-lines server (models load once); see Server.swift / bridge.mjs
//
// Models load from local folders (see Models.swift) so all of this works with Wi-Fi off.
// Voiceprints (Argmax Pro) and live streaming speaker events come next; see capture/README.md.
import Foundation
import WhisperKit

struct Args {
    static let booleans: Set<String> = ["--translate"]
    var positional: [String] = []
    var flags: [String: String] = [:]
    func bool(_ name: String) -> Bool { flags[name].map { $0 == "1" || $0 == "true" } ?? false }
    init(_ argv: [String]) {
        var i = 0
        while i < argv.count {
            let a = argv[i]
            // Boolean flags (`--translate`) take no value unless one is given explicitly (`--translate 1`).
            if Args.booleans.contains(a), i + 1 >= argv.count || !["1", "0", "true", "false"].contains(argv[i + 1]) { flags[String(a.dropFirst(2))] = "1"; i += 1 }
            else if a.hasPrefix("--"), i + 1 < argv.count { flags[String(a.dropFirst(2))] = argv[i + 1]; i += 2 }
            else { positional.append(a); i += 1 }
        }
    }
}

enum CaptureError: Error { case usage }

func process(_ args: Args) async throws {
    guard let audioPath = args.positional.dropFirst().first else { throw CaptureError.usage }
    let translate = args.bool("translate")
    async let w = loadWhisper()
    async let s = loadSpeakerKit()
    async let m = translate ? loadWhisperMulti() : nil
    let (whisper, speakers, multi) = try await (w, s, m)
    let audio = try AudioProcessor.loadAudioAsFloatArray(fromPath: audioPath)
    _ = try await writeSession(audio: audio, audioPath: audioPath, session: args.flags["session"] ?? sessionId(), place: args.flags["place"],
                               startedAt: Date(), outDir: URL(fileURLWithPath: args.flags["out"] ?? "data/inbox"), whisper: whisper, speakers: speakers,
                               multilingual: multi)
}

func record(_ args: Args) async throws {
    // Load models while the mic runs, so processing starts as soon as recording ends.
    async let w = loadWhisper()
    async let s = loadSpeakerKit()
    async let m = args.bool("translate") ? loadWhisperMulti() : nil
    let session = args.flags["session"] ?? sessionId()
    let maxSeconds = Double(args.flags["seconds"] ?? "3600") ?? 3600
    let started = Date()
    let stop = StopFlag(false)
    let mic = try await openMic(simulate: args.flags["simulate"], onLive: { Out.log("● recording on \($0) — press Enter to stop") },
                                onFallback: { Out.log("\($0) sent only silence; switched to \($1)") })
    FileHandle.standardInput.readabilityHandler = { h in if !h.availableData.isEmpty { stop.set(true) } }
    while !stop.get() && !mic.finished.get() && Date().timeIntervalSince(started) < maxSeconds { try await Task.sleep(nanoseconds: 100_000_000) }
    FileHandle.standardInput.readabilityHandler = nil
    try await Task.sleep(nanoseconds: 150_000_000)
    let audio = mic.stop()
    guard mic.live.get() else { throw Failure(message: "No microphone sent any sound. Pick a working input in System Settings › Sound.") }
    let wav = URL(fileURLWithPath: args.flags["audio-dir"] ?? "data/audio").appendingPathComponent("\(session).wav")
    try writeWAV(audio, sampleRate: 16000, to: wav)
    Out.log("saved \(wav.path)")
    let (whisper, speakers, multi) = try await (w, s, m)
    _ = try await writeSession(audio: audio, audioPath: wav.path, session: session, place: args.flags["place"],
                               startedAt: started, outDir: URL(fileURLWithPath: args.flags["out"] ?? "data/inbox"), whisper: whisper, speakers: speakers,
                               multilingual: multi)
}

func speak(_ args: Args) async throws {
    let text = args.positional.dropFirst().joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { throw CaptureError.usage }
    guard let lang = ttsLanguage(args.flags["language"]) else { throw Failure(message: "Argmax voice can't speak \(args.flags["language"] ?? "")") }
    let speaker = voice(args.flags["voice"], for: lang)
    let tts = try await loadTTS()
    let line = String(text.prefix(240))
    if let out = args.flags["out"] {  // write a WAV instead of playing
        let result = try await tts.generate(text: line, voice: speaker.rawValue, language: lang.rawValue, options: whisperLineOptions(chars: line.count, language: lang))
        try writeWAV(result.audio, sampleRate: 24000, to: URL(fileURLWithPath: out))
        return
    }
    _ = try await tts.play(text: line, speaker: speaker, language: lang, options: whisperLineOptions(chars: line.count, language: lang))
}

let args = Args(Array(CommandLine.arguments.dropFirst()))
do {
    switch args.positional.first {
    case "process": await setupPro(); try await process(args)
    case "record": await setupPro(); try await record(args)
    case "speak": try await speak(args)
    case "serve": await setupPro(); try await serve(args)
    case "license": await printLicense()
    case "provision": try await provision(only: args.flags["only"])
    default: throw CaptureError.usage
    }
} catch CaptureError.usage {
    Out.log("""
    usage: kindred-capture process <audio.wav> [--session ID] [--place TEXT] [--out DIR] [--translate]
           kindred-capture record [--session ID] [--place TEXT] [--out DIR] [--audio-dir DIR] [--seconds N] [--simulate file.wav] [--translate]
           kindred-capture speak "text" [--language fr] [--voice NAME] [--out file.wav]
           kindred-capture serve [--out DIR] [--audio-dir DIR] [--no-tts 1] [--no-translate 1]
           kindred-capture license      (Argmax Pro status; run once online before going Wi-Fi off)
           kindred-capture provision [--only whisper-multi]   (download all models once, with Wi-Fi on)
    """)
    exit(2)
} catch {
    Out.log("error: \(error.localizedDescription)")
    exit(1)
}
