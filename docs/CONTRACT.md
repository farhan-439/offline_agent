# Capture ⇄ Memory contract

This is the only thing the two halves of Kindred share. If both sides respect it, `capture/` (Argmax, Swift) and `memory/` (Bonsai, Node) can be built, tested, and demoed independently.

## 1. Capture → Memory: session files (JSON Lines)

Every recording produces one file, `data/inbox/<session>.jsonl`, one JSON object per line. Memory picks it up on **dock**. Lines are processed in order; unknown `type`s are ignored so either side can add fields without breaking the other.

```jsonc
{"type":"session_start","session":"2026-11-14T16-02-11","startedAt":"2026-11-14T16:02:11Z","place":"optional free text"}

// One per diarized + transcribed segment.
{"type":"utterance","session":"2026-11-14T16-02-11","id":"2026-11-14T16-02-11#0007",
 "speaker":"S1",              // per-session cluster label from SpeakerKit
 "start":31.42,"end":36.10,   // seconds from session start
 "text":"My knee surgery got moved to Friday.",
 "audio":"data/audio/2026-11-14T16-02-11.wav"}   // clip = audio file + start/end

// One per speaker cluster in the saved session file, after recording stops.
{"type":"speaker","session":"2026-11-14T16-02-11","speaker":"S1",
 "voiceprint":[0.013,-0.207, ...],   // L2-normalised embedding (Argmax Pro). null if unavailable.
 "seconds":42.7,                      // total speech attributed to this cluster
 "final":true}

{"type":"session_end","session":"2026-11-14T16-02-11","endedAt":"2026-11-14T16:09:40Z"}
```

Rules:
- `id` must be unique and stable — memory cites it as evidence and the UI uses it to replay audio.
- `voiceprint` vectors from the same model must have the same length. Memory compares them with cosine similarity, so normalisation is preferred but not required.
- During recording, capture also emits provisional `speaker` events over its live stdout bridge with `final:false` and labels such as `L1`. Those are sent to `/identify`; they are not written to the session file. The final file uses its own `S1` labels.
- `language` and `translation` are optional utterance fields. Memory indexes both the original text and translation when supplied.
- The device owner is just another speaker. Memory recognises them via an enrolled voiceprint (`kindred enroll-me`).

## 2. Memory → Capture: live "who is this?" over local HTTP

During a live session, capture can ask memory to identify a cluster and gets back a short line to speak quietly.

```jsonc
// request
{"type":"identify","session":"...","speaker":"L1","voiceprint":[...]}
// response
{"type":"identity","speaker":"L1","personId":"p_maya","name":"Maya","score":0.91,
 "whisper":"This is Maya, your neighbour. On Tuesday she said her knee surgery moved to Friday."}
// unknown voice
{"type":"identity","speaker":"L1","personId":null,"score":0.42,"whisper":null}
```

Capture sends the live request to the local memory server's `POST /identify` endpoint. It speaks `whisper` with Argmax TTSKit. The CLI `kindred who` remains useful for manual checks.

## 3. Fixtures

`contract/fixtures/*.jsonl` are hand-written sessions that follow this contract exactly, with small 8-dimensional fake voiceprints. Memory develops against them; capture's output should be diffable against them.
