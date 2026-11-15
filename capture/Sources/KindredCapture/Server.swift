import Foundation
import WhisperKit
import SpeakerKit
import TTSKit
import Argmax

// `kindred-capture serve` — one long-lived process so Whisper, SpeakerKit and Qwen3-TTS load once.
// Adapted from local_ai's `second-nature-speech serve`. JSON lines on stdin → JSON lines on stdout.
//
//   {"id":1,"cmd":"record-start","place":"porch"}  → {"event":"recording","id":1,"session":"…"}
//                                                     {"event":"mic-live","id":1,"device":"…"} once audio flows
//                                                     {"event":"live","id":1,"engine":"sortformer"|"pyannote-rolling"}
//                                                     {"event":"speaker","id":1,"speaker":"L1","voiceprint":[…],"final":false,…} (Live.swift)
//                                                     ("live":false in record-start turns live detection off;
//                                                      "simulate":"/path.wav" plays a WAV in as the mic and stops at its end)
//   {"id":1,"cmd":"record-start","translate":true} → as above, plus (Translate.swift, multilingual Whisper):
//                                                     {"event":"translating","id":1,"model":"openai_whisper-small"}
//                                                     {"event":"translation","id":1,"seq":1,"language":"fr","text":"<original>",
//                                                      "translation":"<english>","start":4.54,"end":10.54,"final":false}
//                                                     one per foreign speech chunk (cut at ≥0.5 s pauses, ≤7 s), ~1–2 s after it ends.
//                                                     English chunks are skipped. start/end: seconds into the recording.
//                                                     Nothing is spoken: the app can `speak` the translation.
//                                                     The session file then gets "language" (+ "translation" if not English)
//                                                     on every utterance, and the reply adds "translated":n.
//   {"cmd":"record-stop"}                          → {"event":"processing","id":1}
//                                                     {"id":1,"session":"…","jsonl":"…","audio":"…","utterances":n,"speakers":k}
//   {"cmd":"record-cancel"}                        → {"id":1,"error":"Recording cancelled."}
//   {"id":2,"cmd":"process","audio":"x.wav","place":"…","translate":true?} → same reply shape as record-stop
//   {"id":3,"cmd":"speak","text":"This is Maya…","voice":"ryan"} → {"event":"speaking",…} then {"id":3,"spoken":true,…}
//   {"cmd":"stop-speaking"}
// Emits {"event":"ready","stt":true,"diarize":true,"tts":false,"ttsLoading":bool}, then {"event":"ready",…,"tts":true},
// then {"event":"translate-ready","ms":…} once the translation model is preloaded (skipped with --no-translate 1,
// or if it isn't staged; it then loads on first use). {"event":"translate-unavailable","error":…} if it can't load.

struct ServeConfig { let outDir: URL; let audioDir: URL }

actor CaptureServer {
    let whisper: WhisperKit
    let speakers: SpeakerKit
    let config: ServeConfig
    var liveStreamer: SpeakerKitPro?
    var tts: TTSKit?
    var speakingTask: Task<Void, Never>?
    var stopSpeech = StopFlag(false)
    var stopFlag = StopFlag(false)
    var cancelFlag = StopFlag(false)
    var recording = false
    /// Multilingual Whisper for translation: preloaded after `ready` (unless --no-translate), else on first use.
    var multiLoad: Task<WhisperKit?, Never>?

    init(whisper: WhisperKit, speakers: SpeakerKit, config: ServeConfig) { self.whisper = whisper; self.speakers = speakers; self.config = config }
    func setTTS(_ engine: TTSKit) { tts = engine }
    func setLiveStreamer(_ s: SpeakerKitPro?) { liveStreamer = s }

    /// The translation model, loading it once if needed. nil if it can't load (event says why).
    func multilingual() async -> WhisperKit? {
        if multiLoad == nil {
            multiLoad = Task {
                let t0 = Date()
                do {
                    let m = try await loadWhisperMulti()
                    _ = try? await m.transcribe(audioArray: [Float](repeating: 0, count: 16000), decodeOptions: clipDecodeOptions(task: .translate, language: "fr"))
                    Out.send(["event": "translate-ready", "ms": Int(Date().timeIntervalSince(t0) * 1000)])
                    return m
                } catch {
                    Out.send(["event": "translate-unavailable", "error": error.localizedDescription])
                    return nil
                }
            }
        }
        return await multiLoad!.value
    }

    func handle(_ command: [String: Any]) async {
        let id = command["id"]
        switch command["cmd"] as? String {
            case "record-start":
                guard !recording else { Out.send(["id": id, "error": "Already recording."]); return }
                recording = true
                stopFlag = StopFlag(false); cancelFlag = StopFlag(false)
                let session = command["session"] as? String ?? sessionId()
                let place = command["place"] as? String
                let live = command["live"] as? Bool ?? true
                let simulate = command["simulate"] as? String
                let translate = command["translate"] as? Bool ?? false
                let outDir = (command["outDir"] as? String).map { URL(fileURLWithPath: $0) } ?? config.outDir
                let audioDir = (command["audioDir"] as? String).map { URL(fileURLWithPath: $0) } ?? config.audioDir
                Task { await self.record(id: id, session: session, place: place, live: live, simulate: simulate,
                                         translate: translate, outDir: outDir, audioDir: audioDir) }
            case "record-stop": stopFlag.set(true)
            case "record-cancel": cancelFlag.set(true)
            case "process":
                guard let path = command["audio"] as? String, FileManager.default.fileExists(atPath: path) else { Out.send(["id": id, "error": "Existing audio file is required."]); return }
                let session = command["session"] as? String ?? sessionId()
                let place = command["place"] as? String
                let translate = command["translate"] as? Bool ?? false
                Task { await self.processFile(id: id, path: path, session: session, place: place, translate: translate) }
            case "speak": speak(id: id, text: command["text"] as? String ?? "", voiceName: command["voice"] as? String,
                                language: command["language"] as? String, saveTo: command["saveTo"] as? String,
                                play: command["play"] as? Bool ?? true)
            case "stop-speaking": await stopSpeaking()
            default: Out.send(["id": id, "error": "Unknown command"])
        }
    }

    func reply(_ id: Any?, _ r: SessionResult) {
        var reply: [String: Any?] = ["id": id, "session": r.session, "jsonl": r.jsonl.path, "audio": r.audio, "utterances": r.utterances, "speakers": r.speakers]
        if let n = r.translated { reply["translated"] = n }
        Out.send(reply)
    }

    func processFile(id: Any?, path: String, session: String, place: String?, translate: Bool = false) async {
        do {
            let audio = try AudioProcessor.loadAudioAsFloatArray(fromPath: path)
            var multi: WhisperKit?
            if translate {
                multi = await multilingual()
                guard multi != nil else { throw Failure(message: "Translation model unavailable. Run `kindred-capture provision --only whisper-multi` once online.") }
            }
            reply(id, try await writeSession(audio: audio, audioPath: path, session: session, place: place, startedAt: Date(),
                                             outDir: config.outDir, whisper: whisper, speakers: speakers, multilingual: multi))
        } catch { Out.send(["id": id, "error": error.localizedDescription]) }
    }

    func record(id: Any?, session: String, place: String?, live: Bool, simulate: String? = nil, translate: Bool = false,
                outDir: URL, audioDir: URL) async {
        defer { recording = false }
        let started = Date()
        Out.send(["event": "recording", "id": id, "session": session])
        var liveSpeakers: LiveSpeakers?
        defer { liveSpeakers?.stop() }
        var translator: LiveTranslator?
        defer { translator?.cancel() }
        do {
            let mic = try await openMic(cancel: cancelFlag, simulate: simulate,
                                        onLive: { device in Out.send(["event": "mic-live", "id": id, "device": device, "ms": Int(Date().timeIntervalSince(started) * 1000)]) },
                                        onFallback: { from, to in Out.send(["event": "mic-fallback", "id": id, "from": from, "device": to]) })
            if live {
                let ls = LiveSpeakers(id: id, session: session, mic: mic, embedder: speakers)
                if let liveStreamer { ls.startPro(streamer: liveStreamer) } else { ls.startRolling() }
                Out.send(["event": "live", "id": id, "engine": liveStreamer == nil ? "pyannote-rolling" : "sortformer"])
                liveSpeakers = ls
            }
            if translate {
                // Chunks heard while the model finishes loading wait in the translator's queue.
                let t = LiveTranslator(id: id, whisper: { await self.multilingual() })
                mic.onIndexedChunk = { t.feed($0, at: $1) }
                translator = t
                Out.send(["event": "translating", "id": id, "model": env("KINDRED_WHISPER_MULTI_VARIANT") ?? defaultMultiVariant])
            }
            // Conversations are long: stop only on record-stop / record-cancel (or a 1-hour safety cap).
            while !stopFlag.get() && !cancelFlag.get() && !mic.finished.get() && Date().timeIntervalSince(started) < 3600 {
                try await Task.sleep(nanoseconds: 100_000_000)
                if !mic.live.get() && Date().timeIntervalSince(started) > 6 { _ = mic.stop(); throw Failure(message: "The microphone never started. Check the input device in System Settings › Sound.") }
            }
            if !cancelFlag.get() { try await Task.sleep(nanoseconds: 150_000_000) } // keep the last syllable
            liveSpeakers?.stop(); liveSpeakers = nil
            let audio = mic.stop()
            if cancelFlag.get() { Out.send(["id": id, "error": "Recording cancelled."]); return }
            // Translate the speech still in progress at stop, then free the model for the session file.
            await translator?.finish(); translator = nil
            guard mic.heardSpeech.get() else { Out.send(["id": id, "error": "No speech was heard.", "reason": "no-speech"]); return }
            Out.send(["event": "processing", "id": id, "audioMs": audio.count / 16])
            let wav = audioDir.appendingPathComponent("\(session).wav")
            try writeWAV(audio, sampleRate: 16000, to: wav)
            let multi = translate ? await multilingual() : nil
            reply(id, try await writeSession(audio: audio, audioPath: wav.path, session: session, place: place, startedAt: started,
                                             outDir: outDir, whisper: whisper, speakers: speakers, multilingual: multi))
        } catch {
            Out.send(["id": id, "error": error.localizedDescription])
        }
    }

    func stopSpeaking() async {
        stopSpeech.set(true)
        if let tts { await tts.audioOutput.stopPlayback(waitForCompletion: false) }
        speakingTask?.cancel()
        speakingTask = nil
    }

    /// `language`: BCP-47 code ("fr") for one of Qwen3-TTS's 10 languages (default English).
    /// `saveTo`: also write the audio as a 24 kHz WAV. `play: false`: generate only, no playback.
    func speak(id: Any?, text: String, voiceName: String?, language: String? = nil, saveTo: String? = nil, play: Bool = true) {
        let text = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(240))
        guard let tts, !text.isEmpty else { Out.send(["id": id, "error": tts == nil ? "Voice output is still loading." : "Nothing to say."]); return }
        guard let lang = ttsLanguage(language) else { Out.send(["id": id, "error": "Argmax voice can't speak \(language ?? "")."]); return }
        let speaker = voice(voiceName, for: lang)
        if !play {
            let started = Date()
            Task {
                do {
                    let result = try await tts.generate(text: text, voice: speaker.rawValue, language: lang.rawValue, options: whisperLineOptions(chars: text.count, language: lang))
                    if let saveTo { try writeWAV(result.audio, sampleRate: 24000, to: URL(fileURLWithPath: saveTo)) }
                    Out.send(["id": id, "spoken": false, "saved": saveTo, "language": lang.rawValue, "voice": speaker.rawValue,
                              "audioMs": result.audio.count * 1000 / 24000, "totalMs": Int(Date().timeIntervalSince(started) * 1000)])
                } catch { Out.send(["id": id, "error": error.localizedDescription]) }
            }
            return
        }
        speakingTask?.cancel()
        let stop = StopFlag(false)
        stopSpeech = stop
        let started = Date()
        let firstChunk = Locked<Int?>(nil)
        speakingTask = Task {
            do {
                let result = try await tts.play(text: text, speaker: speaker, language: lang,
                                                options: whisperLineOptions(chars: text.count, language: lang),
                                                callback: { _ in
                                                    if firstChunk.get() == nil {
                                                        firstChunk.set(Int(Date().timeIntervalSince(started) * 1000))
                                                        Out.send(["event": "speaking", "id": id, "device": defaultOutputDeviceName()])
                                                    }
                                                    return stop.get() ? false : nil })
                if let saveTo { try? writeWAV(result.audio, sampleRate: 24000, to: URL(fileURLWithPath: saveTo)) }
                Out.send(["id": id, "spoken": !stop.get(), "language": lang.rawValue, "voice": speaker.rawValue, "device": defaultOutputDeviceName(), "firstChunkMs": firstChunk.get() ?? -1,
                          "audioMs": result.audio.count * 1000 / 24000, "totalMs": Int(Date().timeIntervalSince(started) * 1000)])
            } catch {
                Out.send(["id": id, "error": stop.get() ? "Stopped." : error.localizedDescription])
            }
        }
    }
}

func serve(_ args: Args) async throws {
    // --no-translate 1: don't preload the translation model (loads on the first translate request instead).
    let config = ServeConfig(outDir: URL(fileURLWithPath: args.flags["out"] ?? "data/inbox"),
                             audioDir: URL(fileURLWithPath: args.flags["audio-dir"] ?? "data/audio"))
    async let w = loadWhisper()
    async let s = loadSpeakerKit()
    let (whisper, speakers) = try await (w, s)
    // Warm the encoder/decoder once so the first real request is fast.
    _ = try? await whisper.transcribe(audioArray: [Float](repeating: 0, count: 16000), decodeOptions: sessionDecodeOptions)
    let server = CaptureServer(whisper: whisper, speakers: speakers, config: config)
    await server.setLiveStreamer(await loadLiveStreamer())
    let wantsTTS = args.flags["no-tts"] == nil
    Out.send(["event": "ready", "stt": true, "diarize": true, "tts": false, "ttsLoading": wantsTTS])
    let preloadTranslate = args.flags["no-translate"] == nil
    Task {
        if wantsTTS {
            do {
                await server.setTTS(try await loadTTS())
                Out.send(["event": "ready", "stt": true, "diarize": true, "tts": true])
            } catch {
                Out.send(["event": "tts-unavailable", "error": error.localizedDescription])
            }
        }
        // After TTS, so it never delays the first spoken line. Only if staged: never download in the background.
        if preloadTranslate, modelPath("KINDRED_WHISPER_MULTI_MODEL", "whisper-multi-model") != nil { _ = await server.multilingual() }
    }
    for try await line in FileHandle.standardInput.bytes.lines {
        guard let data = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        await server.handle(command)
    }
}
