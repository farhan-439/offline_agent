import Foundation
import AVFoundation
import CoreAudio
import WhisperKit

// Microphone capture (AVAudioEngine → 16 kHz mono, in memory) with device helpers and the
// AirPods/Bluetooth "silent mic" fallback. Ported from local_ai/speech-helper.

/// Name of the device output will play on (e.g. "AirPods", "MacBook Pro Speakers").
func defaultOutputDeviceName() -> String {
    var device = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                             mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr else { return "" }
    var name: Unmanaged<CFString>?
    size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    address.mSelector = kAudioObjectPropertyName
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &name) == noErr, let name else { return "" }
    return name.takeRetainedValue() as String
}

struct InputDevice { let id: AudioDeviceID; let name: String; let builtIn: Bool }
func inputDevices() -> [InputDevice] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.compactMap { id in
        var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var streamSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &streamSize) == noErr, streamSize > 0 else { return nil }
        var transport: UInt32 = 0, tsize = UInt32(MemoryLayout<UInt32>.size)
        var taddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        AudioObjectGetPropertyData(id, &taddr, 0, nil, &tsize, &transport)
        var name: Unmanaged<CFString>?, nsize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var naddr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        AudioObjectGetPropertyData(id, &naddr, 0, nil, &nsize, &name)
        return InputDevice(id: id, name: (name?.takeRetainedValue() as String?) ?? "Microphone", builtIn: transport == kAudioDeviceTransportTypeBuiltIn)
    }
}
func defaultInputDeviceName() -> String {
    var device = AudioDeviceID(0), size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr else { return "" }
    return inputDevices().first { $0.id == device }?.name ?? ""
}

final class MicCapture: @unchecked Sendable {
    private let engine = AVAudioEngine()
    let samples = Locked<[Float]>([])
    let live = Locked(false)
    let heardSpeech = Locked(false)
    let lastSpeechAt = Locked(Date())
    let peak = Locked<Float>(0)
    let speechMs = Locked<Double>(0)
    let noiseFloorDb = Locked<Float>(0)
    let liveSamples = Locked(0)
    var onLive: (() -> Void)?
    /// Every 16 kHz mono chunk as it arrives (live speaker detection streams these).
    var onChunk: (([Float]) -> Void)?

    func start(device: AudioDeviceID? = nil) throws {
        let input = engine.inputNode
        if var device, let unit = input.audioUnit {
            let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, UInt32(MemoryLayout<AudioDeviceID>.size))
            guard status == noErr else { throw Failure(message: "Could not switch to the built-in microphone.") }
        }
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { throw Failure(message: "No microphone input is available.") }
        guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: inputFormat, to: target) else { throw Failure(message: "Microphone format is not supported.") }
        let ratio = 16000 / inputFormat.sampleRate
        input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { [weak self] buffer, _ in
            guard let self, buffer.frameLength > 0 else { return }
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
            guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var fed = false
            var error: NSError?
            converter.convert(to: out, error: &error) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true; status.pointee = .haveData; return buffer
            }
            guard error == nil, out.frameLength > 0, let channel = out.floatChannelData?[0] else { return }
            self.process(Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength))))
        }
        engine.prepare()
        try engine.start()
    }

    /// One 16 kHz chunk from the mic (or the simulator): buffer it, stream it, track levels.
    func process(_ chunk: [Float]) {
        samples.mutate { $0.append(contentsOf: chunk) }
        onChunk?(chunk)
        // Bluetooth headsets deliver pure zeros while switching into mic mode: only report
        // "live" once real signal arrives.
        var energy: Float = 0
        for s in chunk { energy += s * s }
        let rms = (energy / Float(chunk.count)).squareRoot()
        if rms > peak.get() { peak.set(rms) }
        if !live.get() && rms > 0.00001 { live.set(true); onLive?() }
        guard live.get() else { return }
        // Learn the room's noise floor over the first ~0.3 s, then call it speech only
        // when clearly louder than that (and never below -45 dBFS). Cap the bar at -30 dBFS: if
        // someone was already talking during calibration, the "floor" is really speech, and an
        // uncapped floor + 12 dB would make every later word count as silence ("no speech").
        let db = 20 * log10(max(rms, 1e-7))
        var calibrating = false
        liveSamples.mutate { n in calibrating = n < 4800; n += chunk.count }
        if calibrating { noiseFloorDb.mutate { $0 = $0 == 0 ? db : min($0, db) }; return }
        if db > max(-45, min(noiseFloorDb.get() + 12, -30)) {
            speechMs.mutate { $0 += Double(chunk.count) / 16 }
            if speechMs.get() >= 250 { heardSpeech.set(true) }
            lastSpeechAt.set(Date())
        }
    }

    // MARK: Simulated mic (testing live detection without a person talking)

    private var simulation: Task<Void, Never>?
    /// True once a simulated recording has played to the end.
    let finished = Locked(false)

    /// Play a WAV into this capture in real time (`speed` > 1 plays faster), exactly as if the mic
    /// heard it. A faint noise floor is added so level detection calibrates as it would on a real mic.
    func simulate(file: String, speed: Double = 1) throws {
        let audio = try AudioProcessor.loadAudioAsFloatArray(fromPath: file)
        let chunkSize = 2048
        simulation = Task.detached { [weak self] in
            var i = 0
            let start = Date()
            while i < audio.count, !Task.isCancelled, let self {
                let chunk = audio[i..<min(i + chunkSize, audio.count)].map { $0 + Float.random(in: -0.0003...0.0003) }
                self.process(chunk)
                i += chunkSize
                let due = Double(i) / 16000 / speed - Date().timeIntervalSince(start)
                if due > 0 { try? await Task.sleep(nanoseconds: UInt64(due * 1e9)) }
            }
            self?.finished.set(true)
        }
    }

    func stop() -> [Float] {
        if let simulation { simulation.cancel(); return samples.get() }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        return samples.get()
    }
}

func requireMicPermission() async throws {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return
        case .notDetermined: if await AVCaptureDevice.requestAccess(for: .audio) { return }
        default: break
    }
    throw Failure(message: "Microphone permission denied. Allow it in System Settings › Privacy & Security › Microphone.")
}

/// Start the default mic; if it sends only digital silence for 1.2 s (AirPods not in mic mode),
/// switch to the built-in mic. `onLive(deviceName)` fires once real audio flows.
/// `simulate`: play this WAV in as if the mic heard it (no permission, no device). Speed: KINDRED_SIM_SPEED.
func openMic(cancel: StopFlag = StopFlag(false), simulate: String? = nil, onLive: @escaping (String) -> Void = { _ in },
             onFallback: @escaping (_ from: String, _ to: String) -> Void = { _, _ in }) async throws -> MicCapture {
    if let simulate {
        guard FileManager.default.fileExists(atPath: simulate) else { throw Failure(message: "Simulation file not found: \(simulate)") }
        let mic = MicCapture()
        let name = "Simulated mic (\(URL(fileURLWithPath: simulate).lastPathComponent))"
        mic.onLive = { onLive(name) }
        try mic.simulate(file: simulate, speed: env("KINDRED_SIM_SPEED").flatMap(Double.init) ?? 1)
        return mic
    }
    try await requireMicPermission()
    let started = Date()
    var mic = MicCapture()
    var device = defaultInputDeviceName()
    mic.onLive = { [device] in onLive(device) }
    try mic.start()
    while !mic.live.get() && !cancel.get() && Date().timeIntervalSince(started) < 1.2 { try await Task.sleep(nanoseconds: 50_000_000) }
    if !mic.live.get() && !cancel.get(), let builtIn = inputDevices().first(where: { $0.builtIn }), builtIn.name != device {
        _ = mic.stop()
        onFallback(device, builtIn.name)
        mic = MicCapture()
        device = builtIn.name
        mic.onLive = { [device] in onLive(device) }
        try mic.start(device: builtIn.id)
    }
    return mic
}
