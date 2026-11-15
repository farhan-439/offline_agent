# capture/ — Argmax side (owner: Partner)

Turns sound into the session files described in [`../docs/CONTRACT.md`](../docs/CONTRACT.md), and speaks lines from memory.
Mic capture, offline model staging, the serve loop, and TTS tuning were ported from the Second Nature speech helper (`local_ai/speech-helper`).

## Build

Needs Swift 6.3+ (Command Line Tools for Xcode 27.2 work) and macOS 15+. If manifests fail to link with an undefined `PackageDescription.Package.__allocating_init`, stale `*.private.swiftinterface` files from an old install are shadowing the new ones in `/Library/Developer/CommandLineTools/usr/lib/swift/pm/{ManifestAPI,PluginAPI}`. Move them aside.

```sh
npm run build                                    # swift build -c release
.build/release/kindred-capture provision         # once, Wi-Fi on: downloads every model (~1.3 GB)
npm test                                         # bridge + live-loop tests (fakes + Farhan's real memory handler)
```

## Commands

| Command | What it does |
|---|---|
| `kindred-capture process <audio.wav> [--session ID] [--place TEXT] [--out DIR]` | WhisperKit (word timestamps) + SpeakerKit diarization → contract JSONL. Non-speech tags (`[BLANK_AUDIO]`, `(music)`) are stripped. |
| `kindred-capture record [--place TEXT] [--out DIR] [--audio-dir DIR] [--seconds N]` | Mic → 16 kHz WAV in `data/audio/<session>.wav` until Enter (or N s), then `process`. Falls back to the built-in mic if AirPods/Bluetooth send only silence. |
| `kindred-capture speak "<text>"` | TTSKit Qwen3-TTS, voice `ryan` (`KINDRED_VOICE=aiden` for the other native-English voice). |
| `kindred-capture serve [--out DIR] [--audio-dir DIR] [--no-tts 1]` | Long-lived JSON-lines server: models load **once**. Protocol in `Sources/KindredCapture/Server.swift`. |
| `kindred-capture provision` | Run once with Wi-Fi on. Downloads all models into `~/Library/Caches/Kindred/hub` and links the folders below. |
| `kindred-capture license` | Argmax Pro license status as JSON (never prints the key). |

## Live whisper (`live.mjs`)

```sh
cd memory && npm run server          # terminal 1: Farhan's memory service on :8787
node capture/live.mjs --place porch  # terminal 2: record; Enter to stop (add --dock to dock right away)
```

While recording, `serve` detects who is talking (`Live.swift`). As soon as a voice has spoken for about 2.5 s, it emits `{"event":"speaker","speaker":"L1","voiceprint":[…],"final":false}`, then again with a better voiceprint after about 8 s. `live.mjs` (`LiveWhisper`) POSTs each one to memory `/identify`. On a match it speaks the returned line ("This is Maya, your neighbour…") through TTSKit, once per person per recording. The owner is never whispered, and unknown voices are retried on the refreshed voiceprint. When you stop, the session file goes to memory `/ingest`.

- **Engine:** with a Pro license, SpeakerKitPro **Sortformer streaming** notices speaker turns within about a second (`KINDRED_SORTFORMER_MODEL` for an offline model folder). Without Pro, or if Sortformer fails to load, it re-runs Pyannote on the last 8 s every 3 s. Either way, the voiceprint is a Pyannote centroid computed on that speaker's own audio, the same kind memory enrolls at dock.
- Live labels (`L1`, `L2`…) only last for one recording. They are not the final `S0`/`S1` labels in the session file, and live events go over stdout only, not into the JSONL.
- **Use earbuds.** A whisper played on the laptop speakers is heard by the mic, ends up in the transcript, and could be detected as another speaker.
- The match threshold is memory's `KINDRED_VOICE_THRESHOLD` (default 0.85). It still needs calibrating on real voices.
- Sortformer emits a fresh voiceprint at 2.5, 4, 5.5, 7, 8.5, 10, 12 and 15 s of a voice's speech, because short prints are weak. Set `KINDRED_LIVE_DEBUG=1` to log every Sortformer update.

**Test without a mic:** `node capture/live.mjs --simulate conversation.wav` (or `kindred-capture record --simulate x.wav`, or `"simulate"` in `record-start`) plays a WAV in as the mic, in real time (`KINDRED_SIM_SPEED` to change), and stops at its end.

**Measured with a simulated mic (11/14, two macOS voices, memory enrolled from the other conversation):**

| Playback | Owner | Maya |
|---|---|---|
| Garden chat (17.6 s), enrolled from porch, the real demo direction | under 2.5 s of speech, never checked (correct) | **recognized at 6.3 s (0.864); reminder audio at 7.1 s**, right after her first sentence |
| Porch chat (36 s), enrolled from garden | recognized at 13.5 s (0.910), silent | **not recognized**: 0.74 → 0.82 by 7 s of speech. After ~18 s, Sortformer gave her later lines to the owner's label, so her speech capped at 7.3 s |

So live recognition currently needs about 5–7 s of someone's speech, and is borderline on these voices. For the demo, have the person say a couple of sentences first. Synthetic voices aren't real people, so calibrate on real voices.

`bridge.mjs` (`CaptureBridge`) drives `serve` from Node: `startRecording()` / `stopRecording()` → `{jsonl, audio, utterances, speakers}`, `processFile()`, `speak()` (falls back to macOS `say`), `stopSpeaking()`.

## Offline models (Wi-Fi off)

Each model loads from a local folder. Defaults are under `~/Library/Caches/Kindred/`; override with env vars:

| Env var | Default folder | Contents |
|---|---|---|
| `KINDRED_WHISPER_MODEL` | `whisper-model` | `argmaxinc/whisperkit-coreml` variant folder, e.g. `openai_whisper-base.en` (MelSpectrogram/AudioEncoder/TextDecoder) |
| `KINDRED_WHISPER_TOKENIZER` | `whisper-tokenizer` | `tokenizer.json` + `tokenizer_config.json` from `openai/whisper-base.en` |
| `KINDRED_SPEAKER_MODEL` | `speaker-model` | `argmaxinc/speakerkit-coreml` |
| `KINDRED_TTS_MODEL` | `tts-model` | `argmaxinc/ttskit-coreml` Qwen3-TTS 0.6B |
| `KINDRED_TTS_TOKENIZER` | `tts-tokenizer` | `Qwen/Qwen3-0.6B` tokenizer. TTSKit downloads it to `~/Documents/huggingface`, and `provision` copies it here. |
| `KINDRED_SORTFORMER_MODEL` | `sortformer-model` | `argmaxinc/speakerkit-pro` (Pro, live detection) |

`provision` sets all of these up. If a folder is missing, the loader downloads instead and warns on stderr. Whisper is staged at a stable path (`whisper-staged`) so Core ML reuses its compiled cache.

**Verified offline (11/14):** all network was blocked with `sandbox-exec` except localhost. `license` still returned `proAccess: true` (cached token valid until 2026-12-14), `process` worked, and `serve` loaded Whisper, SpeakerKit Pro, Sortformer and TTS in 2.3 s and spoke a line (first audio at 0.65 s). This has not been tested with real Wi-Fi off, or after the 30-minute access token expires.

## Voiceprints

256-dim Pyannote embeddings, L2-normalised, written as `speaker.voiceprint`. By default (`KINDRED_VOICEPRINT=own`), each one comes from Pyannote run on **that speaker's own audio** (up to 20 s). Live detection uses the same `ownVoiceprint()`, so the print memory enrolls at dock matches what `/identify` gets live. `KINDRED_VOICEPRINT=centroid` uses the whole-session cluster centroid instead.

**Measured (11/14, two macOS voices, a 36 s porch chat and a 17.6 s follow-up):**

| | same person across sessions | different people |
|---|---|---|
| whole-session centroid | 0.32 – 0.54 (main clusters) | 0.13 – 0.67 |
| own-audio (default) | **0.89 – 0.97** (main clusters) | 0.67 – 0.80 |

With memory's default threshold of 0.85, the follow-up session identified the owner (0.892, silent) and Maya (0.970). Maya's reminder was spoken by TTSKit in 0.67 s to first audio, and `/identify` took 5–32 ms. These are synthetic voices, so real people will be noisier; recalibrate `KINDRED_VOICE_THRESHOLD` on real recordings.

**Known issue:** the 36 s porch chat was split into **4 clusters for 2 people**, each person split early vs. late. The split voiceprints are weaker (one Maya fragment only 0.75), and the fragments look like separate unnamed speakers to memory. Forcing the count (`KINDRED_SPEAKERS=2`) mislabels lines and the cluster threshold (`KINDRED_CLUSTER_THRESHOLD`) didn't help, so the defaults stay. Transcription was near-perfect ("crushes" for "crutches").

## Argmax Pro SDK

Pro **3.1.8** is a dependency (`argmaxinc.argmax-sdk-swift`, pinned with OSS 1.1.1). It needs Swift 6.3+ (Command Line Tools for Xcode 27.2 work) and macOS 15+.

There are two different credentials:
- **Registry token (`axst_…`)** downloads the package. Log in once with `swift package-registry login https://api.argmaxinc.com/v1/sdk/login --token …`, which stores it in the Keychain.
- **Runtime API key (`ax_…`, from the Argmax dashboard)** goes in `ARGMAX_API_KEY`, either in the environment or the gitignored root `.env`. `Pro.swift` passes it to `ArgmaxSDK.with(ArgmaxConfig(apiKey:))`. Handing `ArgmaxConfig` an `axst_` token traps the process, so the code checks the prefix first.

If there is no valid key, or `KINDRED_NO_PRO=1` is set, everything falls back to the open-source SDK. When Pro is on, diarization runs through `SpeakerKitPro` with the Pyannote engine, which keeps the centroid voiceprints.

**Wi-Fi off:** run `kindred-capture license` once online, check `proAccess: true`, and note `licenseTokenExpiresAt`. On test audio, whole-session diarization gave identical results with Pro and with `KINDRED_NO_PRO=1`. Pro's practical gain here is Sortformer live detection.

Pro also offers streaming diarization (`SpeakerKitPro.makeStreamSession` / `makeDiarizeStreamSession`), Sortformer and `LiveTranscriber`. That's the path to live `speaker` events. It has no public embedding API beyond the OSS centroids.

## Still to do

Task list: see "Partner" in the root README §5.
- Live recording with the mic and real people: Sortformer streaming output has not been seen yet. Calibrate `KINDRED_VOICE_THRESHOLD` on real voices.
- Over-segmentation: try merging same-session clusters whose own-audio voiceprints match.
- Translation (`language` + `translation` on utterances; memory already accepts them). Agree the contract change with Farhan.

Validate output against the fixtures: `cd ../memory && npm run kindred -- ingest <your.jsonl> && npm run kindred -- dock`.
