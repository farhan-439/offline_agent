# capture/ — Argmax side (owner: Partner)

Turns sound into the session files described in [`../docs/CONTRACT.md`](../docs/CONTRACT.md), and speaks lines from memory.

Current commands (`swift build -c release`):
- `kindred-capture process <audio.wav> [--session ID] [--place TEXT] [--out DIR]` — WhisperKit (word timestamps) + SpeakerKit diarization merged via `DiarizationResult.addSpeakerInfo`, written as contract JSONL. `voiceprint` is currently `null`.
- `kindred-capture speak "<text>"` — TTSKit Qwen3-TTS, voice `ryan` (`KINDRED_VOICE=aiden` for the other English voice).

Task list: see "Partner" in the root README §5. Critical path is **voiceprints via Argmax Pro** — the open-source SpeakerKit (0.18.0) computes speaker embeddings internally but does not expose them publicly.

Validate your output against the fixtures: `cd ../memory && npm run kindred -- ingest <your.jsonl> && npm run kindred -- dock`.
