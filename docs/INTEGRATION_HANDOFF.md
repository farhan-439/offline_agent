# Kindred integration handoff

The combined checkout is `Projects/Kindred-Integration`. The Argmax capture code, Bonsai memory engine, and Electron app are on `main`. The app uses one local Bonsai 4B server for chat, vision, tool calls, and 2,560-dimensional embeddings. Argmax Pro supplies transcription, speaker detection, voiceprints, and speech output.

## Run locally

1. `memory/scripts/start-bonsai.sh` starts Bonsai 4B on `127.0.0.1:8080`. Set `BONSAI_DEMO_DIR` if `bonsai-demo` is in another checkout. The launcher uses embeddings and vision; do not start 9B for this app.
2. `cd capture && swift build -c release` builds `kindred-capture`. The private Argmax registry needs a registry login; the runtime Pro API key belongs in the ignored root `.env` as `ARGMAX_API_KEY`. Neither credential belongs in Git. Run `kindred-capture provision` once online to stage Whisper, SpeakerKit, TTS, and Sortformer under `~/Library/Caches/Kindred`.
3. `cd memory && npm run server` starts the memory API on `127.0.0.1:8787`, using ignored `data/kindred.sqlite` by default.
4. `cd app && npm ci && npm start` opens the hub, orb, and hidden chat window. Click the orb to open chat. Type a question or tap **Talk to Kindred**, speak, and tap **Done speaking**. Argmax transcribes, Bonsai retrieves and answers with citations, and Argmax speaks the answer. Follow-up questions can be asked from the same panel.

The orb chat uses a separate fixed-size window because a dynamically resized transparent Electron window did not reliably redraw on this Mac. The voice-question audio and JSONL go to ignored `data/ask-tmp`, outside the conversation inbox. They are deleted after transcription; stale files from an interrupted run are removed at the next app start. Voice questions are never sent to `/ingest`.

## Verification completed

- Swift release build succeeded with Argmax Pro 3.1.8. Pro license activation succeeded. Whisper, SpeakerKit, TTS, and Sortformer were provisioned and loaded. A direct Argmax TTS call completed.
- A 5.6-second synthesized spoken question produced three Argmax utterances. The app's full voice-question path transcribed the question, queried Bonsai 4B, answered the saved key-location fact, and cited `N1`. The temporary question files were removed.
- The desktop orb was inspected on screen. Its chat panel was visible, accepted a typed question, showed a sourced answer, and displayed the speaking state. The local memory API reported `hybrid-rerank`, Bonsai 4B, and embeddings enabled.
- Tests: memory 45/45, capture bridge 17/17, desktop 21/21. Tests use scripted models except for the real smoke checks above.
- The ignored local `data/kindred.sqlite` was assembled from earlier test data: 53 typed inputs, 10 extracted facts, and 19 utterances; SQLite integrity check passed. This data is local and is not pushed. The previous input-lab snapshot is kept in ignored `data/input-lab-snapshot.sqlite`.

## Remaining real-world checks

- Calibrate speaker matching with real people and microphones; prior synthetic-voice tests showed occasional oversegmentation. The real mic and live Sortformer identity loop were not validated in this integration run.
- The Argmax Pro build emits duplicate Objective-C class warnings from the vendor's dynamic OSS library and the executable's OSS linkage. No crash appeared during the build, license, transcription, provision, TTS, or app smoke checks, but this packaging warning remains.
- The server processes and local credentials are machine state, not Git state. Start the services above after a restart. Never commit `.env`, `data/`, `.build/`, model weights, or registry credentials.
