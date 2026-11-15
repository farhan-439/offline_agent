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
| `kindred-capture process <audio.wav> [--session ID] [--place TEXT] [--out DIR] [--translate]` | WhisperKit (word timestamps) + SpeakerKit diarization → contract JSONL. Non-speech tags (`[BLANK_AUDIO]`, `(music)`) are stripped. |
| `kindred-capture record [--place TEXT] [--out DIR] [--audio-dir DIR] [--seconds N]` | Mic → 16 kHz WAV in `data/audio/<session>.wav` until Enter (or N s), then `process`. Falls back to the built-in mic if AirPods/Bluetooth send only silence. |
| `kindred-capture speak "<text>" [--language fr] [--voice NAME] [--out file.wav]` | Argmax TTSKit (Qwen3-TTS 0.6B). English voice `aiden` (`KINDRED_VOICE=ryan` for the other). `--language` takes any of Qwen3-TTS's 10: en, es, fr, de, it, pt, ru, zh, ja, ko; zh/ja/ko use the native voices vivian / ono-anna / sohee, the rest use the default voice. `--out` writes a 24 kHz WAV instead of playing. `serve`'s `speak` command takes the same `language`, plus `saveTo` and `play:false`. |
| `kindred-capture serve [--out DIR] [--audio-dir DIR] [--no-tts 1] [--no-translate 1]` | Long-lived JSON-lines server: models load **once**. Protocol in `Sources/KindredCapture/Server.swift`. |
| `kindred-capture provision [--only whisper-multi]` | Run once with Wi-Fi on. Downloads all models into `~/Library/Caches/Kindred/hub` and links the folders below. |
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
| `KINDRED_WHISPER_MULTI_MODEL` | `whisper-multi-model` | multilingual `openai_whisper-small` for translation (see below) |
| `KINDRED_WHISPER_MULTI_TOKENIZER` | `whisper-multi-tokenizer` | `openai/whisper-small` tokenizer |

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

## Translation

For travel: someone speaks French, Spanish, Japanese…, and Kindred shows (and the app can speak) the English while they talk, then remembers both. Code: `Sources/KindredCapture/Translate.swift`.

**Model.** `openai_whisper-small` (multilingual, 486 MB on disk), staged as `whisper-multi-model` + `whisper-multi-tokenizer` (`kindred-capture provision --only whisper-multi`, or as step 5/5 of a full `provision`). It is loaded with `download: false` from the local folder, and verified with all network blocked (`sandbox-exec`, 11/14). `base.en` stays the model for normal English recording: it can't detect languages or translate, and the plain path is untouched. Why small: tiny/base multilingual translate poorly; `large-v3-v20240930` ("turbo") was trained without the translate task; medium is 1.5 GB with a 24-layer decoder. `KINDRED_WHISPER_MULTI_VARIANT` picks another variant at provision time. Comparison measured on this M2: see the table below.

**How.** Whisper's own language detection per chunk, then two decodes of the same clip run in parallel: `task: .transcribe` in the detected language (the original `text`) and `task: .translate` (English). English chunks only pay for the detection (~0.1–0.2 s) and are skipped. Chunks come from an energy VAD (`SpeechChunker`): cut at ≥ 0.5 s of silence, or at the quietest point once a chunk reaches 7 s (`KINDRED_TRANSLATE_SILENCE_MS`, `KINDRED_TRANSLATE_MAX_S`). The mic callback only does arithmetic on 30 ms frames. Whisper runs on its own task, so the mic is never blocked. Nothing is spoken from Swift.

**Live events** (`record-start` with `"translate": true`, or `startRecording({ translate: true })`):

```jsonc
{"event":"translating","id":1,"model":"openai_whisper-small"}            // right after record-start
{"event":"translation","id":1,"seq":1,"language":"fr","text":"Bonjour, excusez-moi, la gare est à 10 minutes à pied. Prenez la deuxième rue à gauche.",
 "translation":"Hello, excuse me, the station is 10 minutes away, take the second left street.","start":4.54,"end":10.54,"final":false}
```

`start`/`end` are seconds into the recording (the same timeline as utterances in the session file). `final:false` means it is a live event and is not written to the file, like live `speaker` events. `seq` counts the translation events in one recording. English is never emitted. Live speaker detection (`Live.swift`) runs alongside, unchanged. `serve` preloads the model after TTS and emits `{"event":"translate-ready","ms":…}` (`--no-translate 1` skips the preload; it then loads on first use), or `translate-unavailable` with an error. Chunks heard while the model is still loading wait in a queue.

**Session file** (`process --translate`, `"translate": true` on `record-start`/`process`, `processFile(audio, { translate: true })`): every utterance gets `language` and, when it isn't English, `translation` (docs/CONTRACT.md's optional fields; memory indexes both). The reply adds `"translated": n`. Whisper over a whole recording picks one language per 30 s window and then drops or garbles the other language (on our mixed test it labelled everything `de` and lost the French and Spanish). So translate mode instead uses the live chunks, split where the diarized speaker changes. Each piece is its own utterance with its own language. Diarization and voiceprints are the same as without translation.

```jsonc
{"type":"utterance","id":"…#0002","speaker":"S0","start":4.53,"end":10.53,"language":"fr",
 "text":"Bonjour, excusez-moi, la gare est à 10 minutes à pied. Prenez la deuxième rue à gauche.",
 "translation":"Hello, excuse me, the station is at 10 minutes to the left. Take the second street to the left.", …}
{"type":"utterance","id":"…#0001","speaker":"S1","start":0,"end":3.6,"language":"en","text":"Thanks so much. Could you tell me where the train station is?", …}
```

**Measured (11/14, M2 16 GB, macOS `say` voices → 16 kHz WAV).** Live = `serve` + `record-start` with `simulate` at real-time speed, Sortformer live speaker detection running at the same time (its `speaker` events kept coming).

| Clip | Detected | Original (Whisper small) | Translation (small) |
|---|---|---|---|
| Thomas, fr | fr (1.00) | …la gare est à 10 minutes à pied. Prenez la deuxième rue à gauche. | Hello, excuse me, the station is 10 minutes away, take the second left street. |
| Thomas, fr | fr (1.00) | …le train pour Lyon par à 15h30, quai numéro 4. | …the train for Lyon-Pare at 5.30, quai number 4. (wrong time) |
| Mónica, es | es (1.00) | Hay un restaurante muy bueno al lado de la iglesia. | There is a very good restaurant next to the church. |
| Anna, de | de (0.99) | Die Apotheke ist gleich um die Ecke. Sie hat bis 8 Uhr abends geöffnet. | The pharmacy is around the corner. It opened until 8 o'clock in the evening. |
| Kyoko, ja | ja | すみません、駅はどこですか?… | Excuse me, where is the station? Please turn right to the second corner. |
| Alice, it | it | Il binario è cambiato, adesso è il numero 7. | The binary has changed, now it is number 7. |
| Samantha, en | en (1.00) | — skipped live; `language:"en"` in the file | — |

- **Live latency, speech end → `translation` event: 0.95–2.5 s** (11 chunks over 2 runs). Of that, Whisper takes 0.65–1.1 s (detect ~0.1–0.24 s, then parallel transcribe + translate 0.54–0.92 s). The rest is the VAD waiting for a 0.5 s pause, or a 7 s forced cut (`say` barely pauses between sentences). The queue never backed up.
- The mixed 33 s conversation (en → fr → es → de, 3 voices) gave 6 utterances with the right language each, 5 translated, and 3 speakers with voiceprints. Without translate, the same file still goes through `base.en` exactly as before (and garbles the foreign speech, as expected).
- `process --translate`: model load 0.7 s (the first load ever compiles Core ML: 24 s, once). It takes 1.9–2.9 s per 5–12 s clip, including model loading.
- **Model comparison** (same clips): `large-v2_949MB` translates noticeably better ("leaves at 3.30 pm, platform number 4", "The platform has changed"), but live it took 3.6–6 s per chunk to decode and fell behind (7–10 s latency). `small_216MB` (quantized) has similar quality to small, with some extra errors ("K-4"), and was no faster here. So `openai_whisper-small` is the default. For better session-file quality only, point `KINDRED_WHISPER_MULTI_MODEL` at large-v2 (this slows live events too).

**Limits.** Only tested with synthetic voices and a simulated mic, not with real people, noise or accents. Small mistranslates numbers and idioms ("15h30" → "5.30"), so treat translations as a gist. Language detection on chunks under about 1 s is unreliable (shorter than 0.4 s of speech is dropped). Within one chunk, code-switching gets one language. Translation goes into English only (Whisper's limit); English speech gets no reverse translation. A translation spoken on the laptop speakers is heard by the mic. It is English, so it's skipped live, but it ends up in the session file. Use earbuds. Utterances in translate mode are speech chunks (≤ 7 s), not the word-level segments of the English path.

## Still to do

Task list: see "Partner" in the root README §5.
- Live recording with the mic and real people: Sortformer streaming output has not been seen yet. Calibrate `KINDRED_VOICE_THRESHOLD` on real voices.
- Over-segmentation: try merging same-session clusters whose own-audio voiceprints match.
- Translation on a real mic with real people, background noise and accents (only `say` voices so far).

Validate output against the fixtures: `cd ../memory && npm run kindred -- ingest <your.jsonl> && npm run kindred -- dock`.

## Speaking other languages: measured 11/15

This was a feasibility test for two-way translation. 10 everyday English sentences (directions, an appointment, a dose, an allergy) were translated by Bonsai 4B into each of the 9 languages. Argmax TTSKit spoke each one (`play:false`, `saveTo`), then multilingual Whisper (`process --translate`) heard the audio and translated it back to English.
- **Language detection on Argmax's own speech:** 10/10 for es, de, pt, zh, ja, ko and ru; 9/10 for it; 8/10 for fr. Two French clips came out unintelligible with the English `ryan` voice.
- **Speed:** generation took about 1.0–1.25× the audio length. When playing, the first sound arrives in about 0.7 s.
- **Meaning survived the whole chain:** best in de (9/10) and zh (about 7/10); es and fr about 6/10 plus partial matches. It, pt, ja, ko and ru were weaker. The errors that matter most were allergens (peanuts → nuts or almonds), days (Thursday → Wednesday) and drug names. Some of these misses come from the back-translation step itself, not what a listener would hear.

## Two-way replies

During a `translate` recording:
- `{"cmd":"reply-start"}` → `{"replying":true}`, then `{"cmd":"reply-stop"}` → `{"text":"<English>","seconds":2.4,"transcribeMs":149}`; `reply-cancel` drops it.
- The reply is cut from the live mic buffer (no second recording) and transcribed with English Whisper.
- While a reply is being recorded, and while `speak` plays (+0.6 s echo tail), `LiveTranslator` skips chunks that are at least 40% inside those windows (`Muter` in `Translate.swift`). This keeps the owner's English and Kindred's own spoken French out of the live translations.
- **Verified 11/15 on a simulated French–English–French conversation:** both French lines were translated, the English reply was muted live and transcribed exactly in 0.15 s, and a French line captured during a reply was muted.
- Bridge: `replyStart()`, `replyStop()`, `replyCancel()`, `speakIn(text, language)`.

## Voice: aiden + calm sampling (default since 11/15)

Ryan sometimes laughed, made noises or kept going past the words. On 8 typical Kindred lines × 3 takes each, Whisper transcribed every clip, and a clip counted as bad if it ran more than 1.5× too long or lost or added words:

| Setting | Bad clips (of 24) | Median length vs needed | Words missing |
|---|---|---|---|
| ryan, temperature 0.9, top-K 50 (old default) | 9 (2 were pure noise) | 1.44× | 14% |
| ryan, 0.5 / 20 | 7 | 1.35× | 19% |
| ryan, 0.3 / 10 | 7 | 1.34× | 6% |
| **aiden, 0.5 / 20 (new default)** | **1** | **1.06×** | **4%** |

The defaults are now voice `aiden`, temperature 0.5, top-K 20, repetition penalty 1.1, and a token budget of 0.9 per character. You can override them with `KINDRED_VOICE`, `KINDRED_TTS_TEMPERATURE`, `KINDRED_TTS_TOPK`, `KINDRED_TTS_PENALTY` and `KINDRED_TTS_BUDGET`. Qwen3-TTS **1.7B** (TTSKit `.qwen3TTS_1_7b`) would also accept a style instruction ("calm, neutral"), but it is about 3× bigger and slower, so it isn't used.

## Kindred's own voice is never recorded as someone else

Every recording has a `Muter`. While `speak` plays through a **loudspeaker**, that stretch plus a 0.6 s echo tail is marked. Anything mostly inside it is dropped from:
- the saved session file (so memory never docks Kindred's own words)
- live voiceprints
- live translation

With earbuds (Bluetooth, or an output named headphones/AirPods/Buds) the mic can't hear Kindred, so nothing is dropped and no real speech is lost. `KINDRED_SELF_FILTER=always|never` overrides the detection.

**Verified 11/15:** the porch conversation was played in as the mic, and Kindred spoke a whisper out loud at about 10 s. The 5 segments the mic heard during that line were dropped; everything around them was kept.

**Reply languages with the new voice (11/15):** the same 40 Bonsai translations were spoken again and heard back by Whisper. French went from 8/10 to **10/10** clips heard as French; the two garbled clips with ryan were both clean with aiden. Audio was 15–30% shorter per character for es/fr/de (less rambling). zh is unchanged (it uses the native vivian voice). The remaining meaning errors come from Bonsai's translation or the back-translation, not the voice: "nuts" for peanuts (es), the drug name, "10 p.m." (zh).
