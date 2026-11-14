// kindred-capture — the "device" half of Kindred. Everything here runs on-device with Argmax.
//
//   kindred-capture process <audio.wav> [--session ID] [--place TEXT] [--out data/inbox]
//       transcribe (WhisperKit) + diarize (SpeakerKit) → session JSONL per docs/CONTRACT.md
//   kindred-capture speak "<text>"
//       say a line with TTSKit (Qwen3-TTS, voice "ryan")
//
// Base version: file-based. Live mic capture, streaming, and voiceprints (Argmax Pro) come next;
// see capture/README.md for the task list.
import Foundation
import WhisperKit
import SpeakerKit
import TTSKit

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

func emit(_ obj: [String: Any?], to handle: FileHandle) throws {
    let clean = obj.compactMapValues { $0 }
    var data = try JSONSerialization.data(withJSONObject: clean, options: [.sortedKeys, .withoutEscapingSlashes])
    data.append(0x0A)
    handle.write(data)
}

func iso(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }

func env(_ k: String) -> String? { ProcessInfo.processInfo.environment[k].flatMap { $0.isEmpty ? nil : $0 } }

/// WhisperKit: offline if KINDRED_WHISPER_MODEL points to a downloaded model folder.
func makeWhisper() async throws -> WhisperKit {
    if let folder = env("KINDRED_WHISPER_MODEL") {
        return try await WhisperKit(WhisperKitConfig(modelFolder: folder, verbose: false, download: false))
    }
    return try await WhisperKit(WhisperKitConfig(model: env("KINDRED_WHISPER_VARIANT") ?? "base.en", verbose: false))
}

func process(_ args: Args) async throws {
    guard let audioPath = args.positional.dropFirst().first else { throw CaptureError.usage }
    let session = args.flags["session"] ?? iso(Date()).replacingOccurrences(of: ":", with: "-")
    let outDir = URL(fileURLWithPath: args.flags["out"] ?? "data/inbox")
    try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    let outURL = outDir.appendingPathComponent("\(session).jsonl")
    FileManager.default.createFile(atPath: outURL.path, contents: nil)
    let out = try FileHandle(forWritingTo: outURL)
    defer { try? out.close() }

    let started = Date()
    try emit(["type": "session_start", "session": session, "startedAt": iso(started), "place": args.flags["place"]], to: out)

    let audio = try AudioProcessor.loadAudioAsFloatArray(fromPath: audioPath)
    FileHandle.standardError.write("audio: \(String(format: "%.1f", Double(audio.count) / 16000)) s\n".data(using: .utf8)!)

    async let transcription: [TranscriptionResult] = {
        let whisper = try await makeWhisper()
        return try await whisper.transcribe(audioArray: audio, decodeOptions: DecodingOptions(wordTimestamps: true))
    }()
    async let diarization: DiarizationResult = {
        let speakers = try await SpeakerKit()
        return try await speakers.diarize(audioArray: audio)
    }()
    let (t, d) = try await (transcription, diarization)

    // Merge: SpeakerKit assigns a speaker to each word, grouped into speaker-homogeneous segments.
    var n = 0
    var seconds: [Int: Float] = [:]
    for segments in d.addSpeakerInfo(to: t) {
        for seg in segments {
            let text = seg.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, let sid = seg.speaker.speakerId else { continue }
            n += 1
            seconds[sid, default: 0] += seg.endTime - seg.startTime
            try emit([
                "type": "utterance", "session": session, "id": String(format: "%@#%04d", session, n),
                "speaker": "S\(sid)", "start": Double(seg.startTime), "end": Double(seg.endTime),
                "text": text, "audio": audioPath,
            ], to: out)
        }
    }
    // Voiceprints: the open-source SpeakerKit does not expose speaker embeddings.
    // TODO(capture): fill `voiceprint` from Argmax Pro so memory can recognise people across sessions.
    for (sid, secs) in seconds.sorted(by: { $0.key < $1.key }) {
        try emit(["type": "speaker", "session": session, "speaker": "S\(sid)", "voiceprint": NSNull(), "seconds": Double(secs), "final": true], to: out)
    }
    try emit(["type": "session_end", "session": session, "endedAt": iso(Date())], to: out)
    FileHandle.standardError.write("wrote \(n) utterances, \(seconds.count) speakers → \(outURL.path)\n".data(using: .utf8)!)
}

func speak(_ args: Args) async throws {
    let text = args.positional.dropFirst().joined(separator: " ")
    guard !text.isEmpty else { throw CaptureError.usage }
    let tts: TTSKit
    if let folder = env("KINDRED_TTS_MODEL") {
        tts = try await TTSKit(modelFolder: URL(fileURLWithPath: folder))
    } else {
        tts = try await TTSKit()
    }
    _ = try await tts.play(text: text, speaker: Qwen3Speaker(rawValue: env("KINDRED_VOICE") ?? "ryan") ?? .ryan)
}

enum CaptureError: Error { case usage }

let args = Args(Array(CommandLine.arguments.dropFirst()))
do {
    switch args.positional.first {
    case "process": try await process(args)
    case "speak": try await speak(args)
    default: throw CaptureError.usage
    }
} catch CaptureError.usage {
    FileHandle.standardError.write("usage: kindred-capture process <audio.wav> [--session ID] [--place TEXT] [--out DIR]\n       kindred-capture speak \"text\"\n".data(using: .utf8)!)
    exit(2)
} catch {
    FileHandle.standardError.write("error: \(error)\n".data(using: .utf8)!)
    exit(1)
}
