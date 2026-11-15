import Foundation
import SpeakerKit
import Argmax

// Live speaker detection during a `serve` recording, for the "This is Maya…" whisper.
//
// Emits, as soon as a voice has talked long enough to recognise:
//   {"event":"speaker","id":…,"session":"…","speaker":"L1","voiceprint":[…],"seconds":2.7,"final":false,"engine":"sortformer"}
// and once more with a better voiceprint after ~8 s of speech. Live labels (L1, L2…) are only
// stable within one recording and are not the final S0/S1 labels written to the session file.
//
// Two engines:
//   • Pro (SpeakerKitPro Sortformer streaming): notices who is talking within about a second.
//   • Open source fallback: every 3 s, Pyannote on the last 8 s of audio.
// Either way, the voiceprint itself comes from Pyannote (the same centroid embedding as the final
// session file), computed on that speaker's own audio, so it matches what memory enrolled at dock.

final class LiveSpeakers: @unchecked Sendable {
    static let sampleRate: Float = 16000
    static let firstSeconds = 2.5    // speech needed before the first voiceprint
    static let refreshSeconds = 8.0  // rolling engine: one more, better voiceprint after this much speech
    /// Sortformer: a fresh voiceprint at each of these amounts of speech. Short prints are weak
    /// (test audio: 0.73–0.79 at 2.5–5.6 s vs 0.97 at ~10 s), so keep retrying an unknown voice as
    /// its speech accumulates. LiveWhisper drops labels it has already recognised.
    static let checkpoints: [Double] = [2.5, 4, 5.5, 7, 8.5, 10, 12, 15]
    static let clipSeconds: Float = 10

    let id: Any?
    let session: String
    let mic: MicCapture
    let embedder: SpeakerKit
    private let busy = Locked(false)
    private let emitted = Locked<[String: Double]>([:])  // label → seconds at last emit
    private var task: Task<Void, Never>?
    private var continuation: AsyncStream<[Float]>.Continuation?

    init(id: Any?, session: String, mic: MicCapture, embedder: SpeakerKit) {
        self.id = id; self.session = session; self.mic = mic; self.embedder = embedder
    }

    func stop() { continuation?.finish(); task?.cancel() }

    // MARK: Pro: Sortformer streaming

    /// Samples already recorded when streaming began: Sortformer's t=0 is this index in mic.samples.
    private var streamOffset = 0

    func startPro(streamer: SpeakerKitPro) {
        let (stream, continuation) = AsyncStream<[Float]>.makeStream(bufferingPolicy: .bufferingNewest(400))
        self.continuation = continuation
        streamOffset = mic.samples.get().count
        mic.onChunk = { continuation.yield($0) }
        task = Task {
            do {
                let live = try await streamer.makeDiarizeStreamSession(config: SortformerDiarizationOptions(sortformerMode: .realtime))
                await live.start(audioInputStream: stream)
                // speaker → (segment start → end). Updates may repeat or extend earlier segments.
                var spans: [Int: [Float: Float]] = [:]
                for try await update in live.results {
                    for seg in update.speakerSegments {
                        guard let sid = seg.speaker.speakerId, seg.endTime > seg.startTime else { continue }
                        spans[sid, default: [:]][seg.startTime] = max(spans[sid]?[seg.startTime] ?? 0, seg.endTime)
                    }
                    if env("KINDRED_LIVE_DEBUG") != nil {
                        let now = update.speakerSegments.map { "\($0.speaker.speakerId.map { "L\($0 + 1)" } ?? "?")[\(String(format: "%.1f-%.1f", $0.startTime, $0.endTime))]" }
                        let totals = spans.map { sid, segs in "L\(sid + 1)=\(String(format: "%.1f", segs.reduce(0) { $0 + Double($1.value - $1.key) }))s" }.sorted()
                        Out.log("live update seek=\(String(format: "%.1f", update.seekTime)) count=\(update.speakerCount) segs=\(now.joined(separator: " ")) totals=\(totals.joined(separator: " "))")
                    }
                    for (sid, segs) in spans {
                        let ranges = segs.map { (start: $0.key, end: $0.value) }.sorted { $0.start < $1.start }
                        consider(label: "L\(sid + 1)", ranges: ranges, engine: "sortformer")
                    }
                }
            } catch is CancellationError {
            } catch {
                Out.send(["event": "live-error", "id": id, "error": error.localizedDescription, "engine": "sortformer"])
                Out.log("live sortformer failed (\(error.localizedDescription)); switching to rolling pyannote")
                mic.onChunk = nil
                startRolling()
            }
        }
    }

    // MARK: Open source: rolling Pyannote

    private var known: [(label: String, centroid: [Float])] = []

    func startRolling() {
        task = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard !Task.isCancelled, Date().timeIntervalSince(mic.lastSpeechAt.get()) < 3, mic.heardSpeech.get() else { continue }
                let all = mic.samples.get()
                let window = Int(8 * LiveSpeakers.sampleRate)
                guard all.count > Int(LiveSpeakers.firstSeconds * Double(LiveSpeakers.sampleRate)) else { continue }
                let clip = Array(all.suffix(window))
                guard let result = try? await embedder.diarize(audioArray: clip) else { continue }
                for (sid, centroid) in result.speakerCentroidEmbeddings {
                    let seconds = result.segments.filter { $0.speaker.speakerId == sid }.reduce(0) { $0 + Double($1.endTime - $1.startTime) }
                    guard seconds >= LiveSpeakers.firstSeconds else { continue }
                    let label = match(centroid)
                    let previous = emitted.get()[label]
                    // Rolling windows overlap, so `seconds` is per window: emit once, refresh once on a later sighting.
                    if previous == nil || previous! < LiveSpeakers.refreshSeconds {
                        emitted.mutate { $0[label] = previous == nil ? seconds : LiveSpeakers.refreshSeconds }
                        send(label: label, voiceprint: centroid, seconds: seconds, engine: "pyannote-rolling")
                    }
                }
            }
        }
    }

    /// Same voice as an earlier window? Cosine ≥ 0.7 between centroids → reuse its label.
    private func match(_ centroid: [Float]) -> String {
        if let best = known.map({ ($0, cosine($0.centroid, centroid)) }).max(by: { $0.1 < $1.1 }), best.1 >= 0.7 { return best.0.label }
        let label = "L\(known.count + 1)"
        known.append((label, centroid))
        return label
    }

    // MARK: Voiceprint for one speaker

    private func consider(label: String, ranges: [(start: Float, end: Float)], engine: String) {
        let total = ranges.reduce(0) { $0 + Double($1.end - $1.start) }
        let last = emitted.get()[label]
        // Due when a checkpoint lies between the last emission and now. (LiveWhisper ignores labels
        // it has already recognised, so later checkpoints only matter for still-unknown voices.)
        let due = LiveSpeakers.checkpoints.contains { $0 > (last ?? -1) && total >= $0 }
        guard due, !busy.get() else { return }
        busy.set(true)
        emitted.mutate { $0[label] = total }
        // Same method as the session file's voiceprints (Session.swift), so live prints match enrolled ones.
        let audio = clip(mic.samples.get(), ranges, maxSeconds: LiveSpeakers.clipSeconds, offset: streamOffset)
        Task {
            defer { busy.set(false) }
            guard let centroid = await ownVoiceprint(embedder: embedder, clip: audio) else {
                emitted.mutate { $0[label] = last }; return  // retry on a later update
            }
            send(label: label, voiceprint: centroid, seconds: total, engine: engine)
        }
    }

    private func send(label: String, voiceprint: [Float], seconds: Double, engine: String) {
        Out.send(["event": "speaker", "id": id, "session": session, "speaker": label, "voiceprint": l2normalize(voiceprint),
                  "seconds": (seconds * 10).rounded() / 10, "final": false, "engine": engine])
    }
}

func cosine(_ a: [Float], _ b: [Float]) -> Float {
    guard a.count == b.count, !a.isEmpty else { return -1 }
    var dot: Float = 0, na: Float = 0, nb: Float = 0
    for i in 0..<a.count { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    return na > 0 && nb > 0 ? dot / (na.squareRoot() * nb.squareRoot()) : -1
}

/// Sortformer streaming model (Pro). Offline via KINDRED_SORTFORMER_MODEL, else downloads once.
func loadLiveStreamer() async -> SpeakerKitPro? {
    guard proEnabled, env("KINDRED_NO_LIVE_PRO") == nil else { return nil }
    let t0 = Date()
    do {
        let config: SortformerConfig
        if let folder = modelPath("KINDRED_SORTFORMER_MODEL", "sortformer-model") {
            config = SortformerConfig(modelFolder: folder, verbose: false, download: false, load: true)
        } else {
            Out.log("warning: no local Sortformer model (KINDRED_SORTFORMER_MODEL); downloading — needs internet")
            config = SortformerConfig(verbose: false, download: true, load: true)
        }
        let streamer = try await SpeakerKitPro(config)
        Out.log("live sortformer ready in \(Int(Date().timeIntervalSince(t0) * 1000)) ms")
        return streamer
    } catch {
        Out.log("live sortformer unavailable (\(error.localizedDescription)); live detection will use rolling pyannote")
        return nil
    }
}
