// kindred-capture — the "device" half of Kindred. Everything here runs on-device with Argmax.
//
//   kindred-capture process <audio.wav> [--session ID] [--place TEXT] [--out data/inbox]
//       transcribe (WhisperKit) + diarize (SpeakerKit) → session JSONL per docs/CONTRACT.md
//   kindred-capture record [--session ID] [--place TEXT] [--out data/inbox] [--audio-dir data/audio] [--seconds N]
//       record the mic until Enter (or N seconds), save the WAV, then process it as above
//   kindred-capture speak "<text>"
//       say a line with TTSKit (Qwen3-TTS, voice "ryan")
//   kindred-capture serve [--out data/inbox] [--audio-dir data/audio] [--no-tts 1]
//       long-lived JSON-lines server (models load once); see Server.swift / bridge.mjs
//
// Models load from local folders (see Models.swift) so all of this works with Wi-Fi off.
// Voiceprints (Argmax Pro) and live streaming speaker events come next; see capture/README.md.
import Foundation
import WhisperKit

struct Args {
    var positional: [String] = []
    var flags: [String: String] = [:]
    init(_ argv: [String]) {
        var i = 0
        while i < argv.count {
            let a = argv[i]
            if a.hasPrefix("--"), i + 1 < argv.count { flags[String(a.dropFirst(2))] = argv[i + 1]; i += 2 }
            else { positional.append(a); i += 1 }
        }
    }
}

enum CaptureError: Error { case usage }

func process(_ args: Args) async throws {
    guard let audioPath = args.positional.dropFirst().first else { throw CaptureError.usage }
    async let w = loadWhisper()
    async let s = loadSpeakerKit()
    let (whisper, speakers) = try await (w, s)
    let audio = try AudioProcessor.loadAudioAsFloatArray(fromPath: audioPath)
    _ = try await writeSession(audio: audio, audioPath: audioPath, session: args.flags["session"] ?? sessionId(), place: args.flags["place"],
                               startedAt: Date(), outDir: URL(fileURLWithPath: args.flags["out"] ?? "data/inbox"), whisper: whisper, speakers: speakers)
}

func record(_ args: Args) async throws {
    // Load models while the mic runs, so processing starts as soon as recording ends.
    async let w = loadWhisper()
    async let s = loadSpeakerKit()
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
    let (whisper, speakers) = try await (w, s)
    _ = try await writeSession(audio: audio, audioPath: wav.path, session: session, place: args.flags["place"],
                               startedAt: started, outDir: URL(fileURLWithPath: args.flags["out"] ?? "data/inbox"), whisper: whisper, speakers: speakers)
}

func speak(_ args: Args) async throws {
    let text = args.positional.dropFirst().joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { throw CaptureError.usage }
    let tts = try await loadTTS()
    _ = try await tts.play(text: String(text.prefix(240)), speaker: voice(), language: .english, options: whisperLineOptions(chars: text.count))
}

let args = Args(Array(CommandLine.arguments.dropFirst()))
do {
    switch args.positional.first {
    case "process": await setupPro(); try await process(args)
    case "record": await setupPro(); try await record(args)
    case "speak": try await speak(args)
    case "serve": await setupPro(); try await serve(args)
    case "license": await printLicense()
    case "provision": try await provision()
    default: throw CaptureError.usage
    }
} catch CaptureError.usage {
    Out.log("""
    usage: kindred-capture process <audio.wav> [--session ID] [--place TEXT] [--out DIR]
           kindred-capture record [--session ID] [--place TEXT] [--out DIR] [--audio-dir DIR] [--seconds N] [--simulate file.wav]
           kindred-capture speak "text"
           kindred-capture serve [--out DIR] [--audio-dir DIR] [--no-tts 1]
           kindred-capture license      (Argmax Pro status; run once online before going Wi-Fi off)
           kindred-capture provision    (download all models once, with Wi-Fi on)
    """)
    exit(2)
} catch {
    Out.log("error: \(error.localizedDescription)")
    exit(1)
}
