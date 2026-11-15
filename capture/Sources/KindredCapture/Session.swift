import Foundation
import WhisperKit
import SpeakerKit

// Audio → contract JSONL (docs/CONTRACT.md). Shared by `process`, `record` and `serve`.

func l2normalize(_ v: [Float]) -> [Double] {
    let norm = v.reduce(0) { $0 + Double($1) * Double($1) }.squareRoot()
    return norm > 0 ? v.map { (Double($0) / norm * 1e6).rounded() / 1e6 } : v.map(Double.init)
}

/// Pyannote options for whole-session diarization. Tunable while we calibrate on real audio:
///   KINDRED_CENTROID=final|trainable (voiceprint averaging), KINDRED_SPEAKERS=N (known speaker count),
///   KINDRED_CLUSTER_THRESHOLD=x (merge distance; higher → fewer speakers).
func sessionDiarizationOptions() -> PyannoteDiarizationOptions {
    PyannoteDiarizationOptions(
        numberOfSpeakers: env("KINDRED_SPEAKERS").flatMap(Int.init),
        clusterDistanceThreshold: env("KINDRED_CLUSTER_THRESHOLD").flatMap(Float.init),
        centroidSource: env("KINDRED_CENTROID") == "final" ? .finalAssignment : .trainableOnly)
}

/// The most recent `maxSeconds` of the given time ranges, cut from 16 kHz `audio` (offset in samples).
func clip(_ audio: [Float], _ ranges: [(start: Float, end: Float)], maxSeconds: Float, offset: Int = 0) -> [Float] {
    var picked: [[Float]] = []
    var seconds: Float = 0
    for r in ranges.sorted(by: { $0.start < $1.start }).reversed() where seconds < maxSeconds {
        let a = max(0, offset + Int(r.start * 16000)), b = min(audio.count, offset + Int(r.end * 16000))
        guard b > a else { continue }
        picked.insert(Array(audio[a..<b]), at: 0)
        seconds += Float(b - a) / 16000
    }
    return picked.flatMap { $0 }
}

/// One speaker's own audio → Pyannote with one speaker → the centroid of its dominant cluster.
func ownVoiceprint(embedder: SpeakerKit, clip: [Float]) async -> [Float]? {
    guard clip.count >= 16000 else { return nil }  // < 1 s: too short for a stable embedding
    guard let result = try? await embedder.diarize(audioArray: clip, options: PyannoteDiarizationOptions(numberOfSpeakers: 1)) else { return nil }
    let count = { (id: Int) in result.segments.filter { $0.speaker.speakerId == id }.count }
    return result.speakerCentroidEmbeddings.max(by: { count($0.key) < count($1.key) })?.value
}

struct SessionResult { let session: String; let jsonl: URL; let audio: String; let utterances: Int; let speakers: Int }

func writeSession(audio: [Float], audioPath: String, session: String, place: String?, startedAt: Date,
                  outDir: URL, whisper: WhisperKit, speakers: SpeakerKit) async throws -> SessionResult {
    try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    let outURL = outDir.appendingPathComponent("\(session).jsonl")
    FileManager.default.createFile(atPath: outURL.path, contents: nil)
    let out = try FileHandle(forWritingTo: outURL)
    defer { try? out.close() }

    try emit(["type": "session_start", "session": session, "startedAt": iso(startedAt), "place": place], to: out)
    Out.log("audio: \(String(format: "%.1f", Double(audio.count) / 16000)) s")

    async let transcription = whisper.transcribe(audioArray: audio, decodeOptions: sessionDecodeOptions)
    async let diarization = speakers.diarize(audioArray: audio, options: sessionDiarizationOptions())
    let (t, d) = try await (transcription, diarization)

    // Merge: SpeakerKit assigns a speaker to each word, grouped into speaker-homogeneous segments.
    var n = 0
    var seconds: [Int: Float] = [:]
    var ranges: [Int: [(start: Float, end: Float)]] = [:]
    for segments in d.addSpeakerInfo(to: t) {
        for seg in segments {
            let text = cleanTranscript(seg.text)
            guard !text.isEmpty, let sid = seg.speaker.speakerId else { continue }
            n += 1
            seconds[sid, default: 0] += seg.endTime - seg.startTime
            ranges[sid, default: []].append((seg.startTime, seg.endTime))
            try emit([
                "type": "utterance", "session": session, "id": String(format: "%@#%04d", session, n),
                "speaker": "S\(sid)", "start": Double(seg.startTime), "end": Double(seg.endTime),
                "text": text, "audio": audioPath,
            ], to: out)
        }
    }
    // Voiceprints, L2-normalised (docs/CONTRACT.md); null if none could be computed.
    // Default ("own"): Pyannote on just this speaker's own audio — the same method live detection
    // uses (Live.swift), so the print memory enrolls at dock matches what /identify gets live.
    // KINDRED_VOICEPRINT=centroid uses the whole-session cluster centroid instead (on real-audio
    // tests it varied a lot between parts of one recording).
    let mode = env("KINDRED_VOICEPRINT") ?? "own"
    for (sid, secs) in seconds.sorted(by: { $0.key < $1.key }) {
        var raw = d.speakerCentroidEmbeddings[sid]
        if mode != "centroid", let own = await ownVoiceprint(embedder: speakers, clip: clip(audio, ranges[sid] ?? [], maxSeconds: 20)) { raw = own }
        let print = raw.map(l2normalize)
        try emit(["type": "speaker", "session": session, "speaker": "S\(sid)", "voiceprint": print ?? NSNull(), "seconds": Double(secs), "final": true], to: out)
    }
    try emit(["type": "session_end", "session": session, "endedAt": iso(startedAt.addingTimeInterval(Double(audio.count) / 16000))], to: out)
    Out.log("wrote \(n) utterances, \(seconds.count) speakers → \(outURL.path)")
    return SessionResult(session: session, jsonl: outURL, audio: audioPath, utterances: n, speakers: seconds.count)
}
