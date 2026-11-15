import Foundation
import WhisperKit

// Translation with the multilingual Whisper (openai_whisper-small, see Models.swift).
//
// Whisper detects the spoken language, transcribes in that language (`task: .transcribe`), and
// translates to English (`task: .translate`, which can only produce English). Two uses:
//   • session files (`process` / `record-stop` with translate): `language` + `translation` per utterance
//   • live (`record-start` with translate): voice-activity chunks of the mic → `translation` events
//
//   {"event":"translation","id":1,"seq":3,"language":"fr","text":"Où est la gare ?",
//    "translation":"Where is the station?","start":12.4,"end":14.1,"final":false}
//
// English chunks are skipped (only the cheap language-detection pass runs on them). Nothing is
// spoken here: the app speaks `translation` with the `speak` command if it wants to.

/// Output Whisper is known to invent on near-silence or noise (subtitle credits, "thanks for watching").
func isWhisperHallucination(_ text: String) -> Bool {
    let t = text.lowercased()
    if t.count < 2 { return true }
    let patterns = ["amara.org", "sous-titr", "subtitles by", "subtítulos", "untertitel", "thanks for watching", "thank you for watching",
                    "merci d'avoir regardé", "gracias por ver", "please subscribe", "abonnez-vous", "suscríbete", "www.", ".com"]
    return patterns.contains { t.contains($0) }
}

/// Joined, cleaned text of Whisper results, dropping low-confidence segments. Empty if nothing usable.
func usableText(_ results: [TranscriptionResult]) -> String {
    let segs = results.flatMap(\.segments).filter { $0.avgLogprob > -1.2 && $0.compressionRatio < 2.6 }
    let text = cleanTranscript(segs.map(\.text).joined(separator: " "))
    return isWhisperHallucination(text) ? "" : text
}

/// Language of a clip: ("fr", 0.97). Confidence is the probability Whisper gave its top language.
func detectClipLanguage(_ whisper: WhisperKit, _ clip: [Float]) async -> (language: String, confidence: Float)? {
    guard let r = try? await whisper.detectLangauge(audioArray: clip) else { return nil }
    return (r.language, exp(r.langProbs[r.language] ?? -10))
}

/// Original-language text and English translation of one clip in a known language, decoded in parallel
/// (the two passes share the model; WhisperKit runs them as concurrent tasks).
func transcribeAndTranslate(_ whisper: WhisperKit, _ clip: [Float], language: String, needText: Bool = true) async -> (text: String, translation: String) {
    var arrays = [clip], options = [clipDecodeOptions(task: .translate, language: language)]
    if needText { arrays.append(clip); options.append(clipDecodeOptions(task: .transcribe, language: language)) }
    let results = await whisper.transcribeWithOptions(audioArrays: arrays, decodeOptionsArray: options)
    let text = { (i: Int) -> String in
        guard i < results.count, case .success(let r) = results[i] else { return "" }
        return usableText(r)
    }
    return (needText ? text(1) : "", text(0))
}

/// Minimum confidence to trust a per-clip language over the default (short clips are often misdetected).
let languageConfidence: Float = { env("KINDRED_TRANSLATE_MIN_CONFIDENCE").flatMap(Float.init) ?? 0.5 }()

// MARK: Speech chunks (energy VAD)

/// One stretch of speech: `start`/`end` are sample indexes in the recording.
struct SpeechChunk { let samples: [Float]; let start: Int; let end: Int; var speechEndedAt = Date(); var closedAt = Date() }

/// Cuts a 16 kHz stream into speech chunks at pauses (≥ 500 ms of silence), or at the quietest
/// point once a chunk reaches 7 s. Used live (mic) and for translated session files, so both
/// translate the same kind of unit. Pure arithmetic on 30 ms frames: cheap enough for the audio thread.
struct SpeechChunker {
    static let frame = 480  // 30 ms at 16 kHz
    let silenceFrames = (env("KINDRED_TRANSLATE_SILENCE_MS").flatMap(Int.init) ?? 500) / 30
    let maxFrames = Int((env("KINDRED_TRANSLATE_MAX_S").flatMap(Double.init) ?? 7) * 1000 / 30)
    let minSpeechFrames = 400 / 30
    let prerollFrames = 10

    private var residual: [Float] = []
    private var residualStart = 0
    private var floorDb: Float? = nil
    private var preroll: [(samples: [Float], db: Float)] = []
    private var chunk: [(samples: [Float], db: Float, speech: Bool)] = []
    private var chunkStart = 0
    private var silence = 0
    private var active = false
    private var out: [SpeechChunk] = []

    /// `at` is the index of samples[0] in the recording; `now` the wall-clock time the last sample arrived.
    mutating func feed(_ samples: [Float], at: Int, now: Date = Date()) -> [SpeechChunk] {
        if residual.isEmpty { residualStart = at }
        residual.append(contentsOf: samples)
        let streamEnd = at + samples.count
        var i = 0
        while residual.count - i >= SpeechChunker.frame {
            step(Array(residual[i..<i + SpeechChunker.frame]), at: residualStart, now: now, streamEnd: streamEnd)
            residualStart += SpeechChunker.frame
            i += SpeechChunker.frame
        }
        residual.removeFirst(i)
        defer { out = [] }
        return out
    }

    /// End of stream: close the chunk in progress.
    mutating func flush(now: Date = Date()) -> [SpeechChunk] {
        if active { close(keep: chunk.count, now: now, streamEnd: chunkStart + chunk.count * SpeechChunker.frame) }
        defer { out = [] }
        return out
    }

    private mutating func step(_ frame: [Float], at: Int, now: Date, streamEnd: Int) {
        var energy: Float = 0
        for s in frame { energy += s * s }
        let db = 20 * log10(max((energy / Float(frame.count)).squareRoot(), 1e-7))
        // Noise floor: drops instantly to quieter frames, creeps up ~0.3 dB/s so it follows a noisier room.
        let floor = floorDb.map { db < $0 ? db : $0 + 0.01 } ?? db
        floorDb = floor
        let speech = db > max(-45, min(floor + 12, -30))  // same rule as MicCapture's speech detection
        if !active {
            preroll.append((frame, db)); if preroll.count > prerollFrames { preroll.removeFirst() }
            guard speech else { return }
            active = true; silence = 0
            chunkStart = at - (preroll.count - 1) * SpeechChunker.frame
            chunk = preroll.dropLast().map { ($0.samples, $0.db, false) } + [(frame, db, true)]
            preroll = []
            return
        }
        chunk.append((frame, db, speech))
        silence = speech ? 0 : silence + 1
        if silence >= silenceFrames {
            close(keep: chunk.count - silence + 7, now: now, streamEnd: streamEnd)  // keep ~200 ms after the last word
        } else if chunk.count >= maxFrames {
            // Long unbroken speech: cut at the quietest frame of the last 1.5 s so a word isn't split.
            let from = max(1, chunk.count - 50)
            let cut = (from..<chunk.count).min { chunk[$0].db < chunk[$1].db } ?? chunk.count
            close(keep: cut, now: now, streamEnd: streamEnd, continueAfter: true)
        }
    }

    /// Emit chunk[0..<keep] (if it holds enough speech). With `continueAfter`, the rest starts the next chunk.
    private mutating func close(keep: Int, now: Date, streamEnd: Int, continueAfter: Bool = false) {
        let keep = min(keep, chunk.count)
        let head = chunk.prefix(keep), rest = chunk.dropFirst(keep)
        if head.filter(\.speech).count >= minSpeechFrames {
            let samples = head.flatMap(\.samples)
            let lastSpeech = chunkStart + ((head.lastIndex { $0.speech } ?? keep - 1) + 1) * SpeechChunker.frame
            out.append(SpeechChunk(samples: samples, start: chunkStart, end: chunkStart + samples.count,
                                   speechEndedAt: now.addingTimeInterval(-Double(streamEnd - lastSpeech) / 16000), closedAt: Date()))
        }
        if continueAfter && !rest.isEmpty {
            chunkStart += keep * SpeechChunker.frame
            chunk = Array(rest)
            silence = 0
        } else {
            active = false; chunk = []; preroll = []
        }
    }
}

/// All speech chunks of a finished recording.
func speechChunks(_ audio: [Float]) -> [SpeechChunk] {
    var c = SpeechChunker()
    var chunks: [SpeechChunk] = []
    var i = 0
    while i < audio.count { let j = min(audio.count, i + 16000); chunks += c.feed(Array(audio[i..<j]), at: i); i = j }
    return chunks + c.flush()
}

// MARK: Live translation

/// Chunks the mic stream (SpeechChunker) and translates each foreign chunk on a separate task,
/// so the mic callback never waits for Whisper.
final class LiveTranslator: @unchecked Sendable {
    typealias Chunk = SpeechChunk
    let id: Any?
    private let lock = NSLock()
    private var chunker = SpeechChunker()  // guarded by lock
    private var closed = false

    private var seq = 0
    private let continuation: AsyncStream<Chunk>.Continuation
    private var worker: Task<Void, Never>!

    /// `whisper` is awaited once by the worker, so chunks heard while the model is still loading queue up.
    init(id: Any?, whisper: @escaping @Sendable () async -> WhisperKit?) {
        self.id = id
        let (stream, continuation) = AsyncStream<Chunk>.makeStream()
        self.continuation = continuation
        worker = Task { [weak self] in
            guard let model = await whisper() else { return }
            for await chunk in stream {
                guard let self, !Task.isCancelled else { break }
                await self.translate(chunk, model)
            }
        }
    }

    /// Mic callback: `at` is the index of samples[0] in the recording.
    func feed(_ samples: [Float], at: Int) {
        let chunks: [Chunk] = lock.withLock { closed ? [] : chunker.feed(samples, at: at) }
        for c in chunks { continuation.yield(c) }
    }

    /// Recording stopped: translate whatever speech is still open, then wait for the queue to drain.
    func finish() async {
        let chunks: [Chunk] = lock.withLock {
            defer { closed = true }
            return closed ? [] : chunker.flush()
        }
        for c in chunks { continuation.yield(c) }
        continuation.finish()
        await worker.value
    }

    func cancel() {
        lock.withLock { closed = true }
        continuation.finish(); worker.cancel()
    }

    private func translate(_ chunk: Chunk, _ whisper: WhisperKit) async {
        let t0 = Date()
        guard let detected = await detectClipLanguage(whisper, chunk.samples) else { return }
        let t1 = Date()
        let secs = String(format: "%.1f-%.1fs", Double(chunk.start) / 16000, Double(chunk.end) / 16000)
        // English (or unsure) → nothing to translate. Unsure foreign chunks are still tried: a
        // traveller would rather see a shaky translation than none.
        guard detected.language != "en" else {
            Out.log("translate: \(secs) en (\(String(format: "%.2f", detected.confidence))) skipped, detect \(ms(t0, t1)) ms")
            return
        }
        let (text, translation) = await transcribeAndTranslate(whisper, chunk.samples, language: detected.language)
        guard !text.isEmpty, !translation.isEmpty else {
            Out.log("translate: \(secs) \(detected.language) produced no usable text"); return
        }
        seq += 1
        Out.send(["event": "translation", "id": id, "seq": seq, "language": detected.language, "text": text, "translation": translation,
                  "start": round2(Double(chunk.start) / 16000), "end": round2(Double(chunk.end) / 16000), "final": false])
        let done = Date()
        Out.log("translate #\(seq) \(secs) \(detected.language) (\(String(format: "%.2f", detected.confidence))): " +
                "\(ms(chunk.speechEndedAt, done)) ms after speech ended (vad \(ms(chunk.speechEndedAt, chunk.closedAt)), " +
                "queue \(ms(chunk.closedAt, t0)), detect \(ms(t0, t1)), decode \(ms(t1, done)))")
    }
}

private func ms(_ a: Date, _ b: Date) -> Int { Int(b.timeIntervalSince(a) * 1000) }
func round2(_ x: Double) -> Double { (x * 100).rounded() / 100 }

// MARK: Session files

struct TranslatedUtterance { let speaker: Int; let start: Float; let end: Float; let language: String; let text: String; let translation: String? }

/// Translate mode for session files. Whole-recording Whisper picks one language per 30 s window and
/// then drops or mistranslates speech in the other language, so instead each speech chunk (same VAD
/// as live), split where the diarized speaker changes, gets its own language detection, transcription
/// in that language, and, if not English, a translation.
func translatedUtterances(_ whisper: WhisperKit, audio: [Float], segments: [(speaker: Int, start: Float, end: Float)]) async -> [TranslatedUtterance] {
    var units: [(speaker: Int, start: Float, end: Float)] = []
    for chunk in speechChunks(audio) {
        let a = Float(chunk.start) / 16000, b = Float(chunk.end) / 16000
        // Diarized speech inside this chunk, merged per consecutive speaker; slivers < 0.4 s join a neighbour.
        var pieces: [(speaker: Int, start: Float, end: Float)] = []
        for s in segments.sorted(by: { $0.start < $1.start }) where s.end > a && s.start < b {
            let p = (speaker: s.speaker, start: max(a, s.start), end: min(b, s.end))
            if let last = pieces.last, last.speaker == p.speaker || p.end - p.start < 0.4 { pieces[pieces.count - 1].end = p.end }
            else if let last = pieces.last, last.end - last.start < 0.4 { pieces[pieces.count - 1] = (p.speaker, last.start, p.end) }
            else { pieces.append(p) }
        }
        if pieces.isEmpty {  // VAD heard speech the diarizer didn't: give it the nearest speaker
            let nearest = segments.min { min(abs($0.start - b), abs($0.end - a)) < min(abs($1.start - b), abs($1.end - a)) }
            guard let nearest else { continue }
            pieces = [(nearest.speaker, a, b)]
        }
        pieces[0].start = a; pieces[pieces.count - 1].end = b
        units += pieces
    }
    var out: [TranslatedUtterance] = []
    for u in units {
        let i = max(0, Int(u.start * 16000)), j = min(audio.count, Int(u.end * 16000))
        guard j - i >= 4800 else { continue }
        let clip = Array(audio[i..<j])
        let detected = await detectClipLanguage(whisper, clip)
        let language = detected?.language ?? "en"
        let text: String, translation: String?
        if language == "en" {
            let r = try? await whisper.transcribe(audioArray: clip, decodeOptions: clipDecodeOptions(task: .transcribe, language: "en"))
            (text, translation) = (r.map(usableText) ?? "", nil)
        } else {
            let r = await transcribeAndTranslate(whisper, clip, language: language)
            (text, translation) = (r.text, r.translation.isEmpty ? nil : r.translation)
        }
        guard !text.isEmpty else { continue }
        out.append(TranslatedUtterance(speaker: u.speaker, start: u.start, end: u.end, language: language, text: text, translation: translation))
    }
    return out
}
