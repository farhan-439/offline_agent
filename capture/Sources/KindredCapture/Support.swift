import Foundation
import AVFoundation

// Small shared helpers. Ported from local_ai/speech-helper (Second Nature).

struct Failure: LocalizedError { let message: String; var errorDescription: String? { message } }

/// Thread-safe box, used by audio taps and the serve loop.
final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value
    init(_ value: Value) { self.value = value }
    func get() -> Value { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ newValue: Value) { lock.lock(); value = newValue; lock.unlock() }
    func mutate(_ body: (inout Value) -> Void) { lock.lock(); body(&value); lock.unlock() }
}
typealias StopFlag = Locked<Bool>

/// stdout = JSON lines (machine-readable), stderr = human log.
enum Out {
    static let lock = NSLock()
    static func send(_ object: [String: Any?]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object.mapValues { $0 ?? NSNull() }, options: [.sortedKeys, .withoutEscapingSlashes]) else { return }
        lock.lock(); FileHandle.standardOutput.write(data + Data([10])); lock.unlock()
    }
    static func log(_ text: String) { FileHandle.standardError.write(Data((text + "\n").utf8)) }
}

/// One contract line (docs/CONTRACT.md). nil values are omitted.
func emit(_ obj: [String: Any?], to handle: FileHandle) throws {
    let clean = obj.compactMapValues { $0 }
    var data = try JSONSerialization.data(withJSONObject: clean, options: [.sortedKeys, .withoutEscapingSlashes])
    data.append(0x0A)
    handle.write(data)
}

func iso(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }
func sessionId(_ d: Date = Date()) -> String { iso(d).replacingOccurrences(of: ":", with: "-").replacingOccurrences(of: "Z", with: "") }

func env(_ k: String) -> String? { ProcessInfo.processInfo.environment[k].flatMap { $0.isEmpty ? nil : $0 } }

/// Whisper emits tags like [BLANK_AUDIO], (music), *coughs* for non-speech. Drop them.
func cleanTranscript(_ text: String) -> String {
    var t = text
    for pattern in [#"\[[^\]]*\]"#, #"\([^)]*\)"#, #"\*[^*]*\*"#, #"<\|[^|]*\|>"#] {
        t = t.replacingOccurrences(of: pattern, with: " ", options: .regularExpression)
    }
    t = t.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    return t.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "\"'")))
}

/// Save mono float samples as a WAV so recall can replay evidence clips.
func writeWAV(_ samples: [Float], sampleRate: Double, to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(max(samples.count, 1))) else {
        throw Failure(message: "Could not allocate audio buffer.")
    }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { src in
        if let base = src.baseAddress { buffer.floatChannelData![0].update(from: base, count: src.count) }
    }
    let file = try AVAudioFile(forWriting: url, settings: format.settings)
    try file.write(from: buffer)
}
