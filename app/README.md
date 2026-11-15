# app/ — Pebble desktop app (Electron)

One hub window with three screens, a floating mark, and a small chat window opened by the mark. Everything runs on this Mac with Wi-Fi off: system fonts, no CDN, local assets only.

| Screen | What it does |
|---|---|
| **Capture** (main page) ⬅ the stone | The mark is the button. A switch above it sets what a tap does — **Record** (the room, out loud), **Ask** (type or speak a question), **Translate** (their language → English). Labels say which one is running and why the others are unavailable while the microphone is busy. On stop, the session file is sent to memory `/ingest`. |
| **Chat** | Questions and answers from memory `/ask`. Answers are spoken (Argmax TTSKit, Mac voice fallback) and carry a **N sources** chip that expands to the cited memories and their audio. |
| **Memory** | Four areas, all reading real endpoints — see below. Keeps **Dock today** and **My voice**. |
| **The mark** | The five-bar mark is the button on Capture. The always-on-top floating version is **switched off for now** (`createOrb()` / `createChat()` still exist in `main.cjs`, but nothing is drawn outside the window). |

## Capture: the three modes and the live transcript

Three words, one control: **Record · Ask · Translate**, with the selected one lifted on a quiet track. The line under the stone reports state (`Tap to record`, `Recording · 0:14`, `Translating · 0:47`, `Saving…`). While the microphone is busy the other modes are disabled **with a line explaining why** ("Recording — tap the stone to stop"). A recording started elsewhere (the shortcut) claims the switch until it ends. There is no ring around the stone while it records — the timer and the moving bars carry that.

In **Translate**, the page shows a live transcript under the stone: each heard line as `French: "…"` with its English underneath, and your own replies as `You replied` in the language Pebble spoke. States are named (`Listening`, `Translating`, `Listening to you`, `Speaking your reply`, `Saving`, `Saved`). Rows are keyed by translation `seq`, so a line that arrives twice with better text **replaces** rather than duplicates, and the last session stays on screen after **Stop** until a new session begins.

**Record** shows only the real recording state. It does not invent a transcript, because capture does not stream text for ordinary recordings.

## Memory workspace (three regions)

The layout is table-first, the way a CRM record works: a list you scan, a list you search, and one big record panel that says everything about what you picked. Not four cards of prose.

| Region | Reads | Shows |
|---|---|---|
| **People** (top left) | `GET /people` | A table — name (with the core memory as a subtitle), relation, fact count, voice-known dot. Selecting a row filters the layers and opens the person in the record panel. |
| **Memory layers** (bottom left) | `GET /inputs`, `GET /memories` | Four tabs — **Inputs**, **Evidence**, **Facts**, **Core** — as a table with `Ref · Content · Person`, colour-coded kind tags, inline search and person/type filters. |
| **Memory map** (right, full height) | the chosen fact + `GET /traces` | A diagram in two modes. **Fact**: the person above, the fact in the middle with that person's other facts beside it, and the conversation it was heard in below — labelled `WHO / WHAT IT KNOWS / WHERE IT WAS HEARD`. **Recalls**: the question, the refs Bonsai retrieved (cited ones in moss, retrieved-only in grey), the answer, and ‹ › to step through recent recalls. The footer carries the fact's ref, date, scope, uses, the original quote and **Play**. |

Read-only IPC backs these panels: `memory:people`, `memory:memories`, `memory:inputs`, `memory:traces`. `core.mjs` turns each memory's repo-relative quote audio into a `file://` URL only when the file still exists, so **Play the moment** is never offered for missing audio.

## Start everything with one command

From the repo root:
```sh
./kindred              # preflight → Bonsai (started if needed) → the app, which starts memory itself
./kindred --demo       # with the demo memory (build it first: node scripts/demo-db.mjs)
./kindred --check      # preflight only
```
- **The app supervises memory** (`memory-supervisor.mjs`). It starts `memory/src/server.mjs` with Electron's own Node 24 (`ELECTRON_RUN_AS_NODE`), restarts it if it dies (backoff 1 s → 15 s), and stops it on quit. It leaves alone a memory server that's already running. Logs go to `data/logs/memory.log`. `KINDRED_SUPERVISE_MEMORY=0` turns this off.
- **The run log** (`run-log.mjs`) writes recognition scores, whispers, translations, replies, questions and errors to `data/logs/run-<date>.jsonl`, never voiceprints. Summarise it with `node scripts/analyze-run.mjs`, and turn it off with `KINDRED_LOG=0`.

## Run

```sh
cd memory && npm run server        # terminal 1: memory on :8787 (needs Bonsai on :8080 for dock/ask)
cd app && npm install && npm start # terminal 2
```

The capture binary must be built (`cd capture && npm run build`), and models must be in `~/Library/Caches/Kindred`. If memory isn't running, the app shows a "Memory server not running: `cd memory && npm run server`" banner and keeps working. Recording still works; whispers, dock and ask wait until memory is back (it re-checks every 5 s). If the capture helper crashes, its last `error:` line is shown in the top-right status.

Env: `KINDRED_MEMORY_URL` (default `http://127.0.0.1:8787`), `KINDRED_CAPTURE_BIN`, `KINDRED_VOICE`, `KINDRED_TTS=system`. The capture helper finds the Argmax key in the root `.env` itself; the app never reads it.

## Code

| File | Role |
|---|---|
| `core.mjs` | All main-process logic (`KindredApp`): drives `CaptureBridge` (`../capture/bridge.mjs`) and `LiveWhisper` (`../capture/live.mjs`), talks to memory over HTTP. No Electron, so it can be tested. |
| `main.cjs`, `preload.cjs` | Electron shell: window, orb, `⌘⇧K` shortcut, IPC. Adapted from local_ai (Second Nature). Windows are sandboxed, navigation and permission requests are denied, and the CSP blocks network access from the page. |
| `index.html`, `renderer.js`, `renderer.css`, `view.mjs` | Hub UI: capture modes, chat, memory workspace. Focus rings, screen-reader labels, reduced motion, and a single-column layout under 1040px. |
| `orb.html`, `orb.js`, `orb.css` | The floating mark and its sub-button island. |
| `mark.mjs`, `mark.css` | The mark: one geometry source (five sage bars) and its motion — still at rest, the voice wave while listening, recording or translating. |

## Tests

```sh
npm test
```

`test/core.test.mjs` runs the real `CaptureBridge` against a fake `kindred-capture serve` script and the real `LiveWhisper` against a fake memory HTTP server. It covers: record → live voices → whisper → ingest; memory down; dock + people; ask + clip URLs; a crashed helper; and cancel. This proves the plumbing only, not real voice matching.

Voice questions use capture's existing short recording path and delete the temporary audio and JSONL after transcription. They are never sent to memory `/ingest`; only the question text goes to `/ask`.

## Your voice ("Teach Kindred my voice")

On the **Memory** screen, press **My voice**, read the passage aloud (about 20 s, alone), then press **Done reading**. The app records with live detection off, takes the voiceprint of the voice that talked longest, and sends it to memory's `POST /enroll-owner`. The sample is then **deleted**; it is never stored or docked as a conversation. Afterwards your own voice is labelled "You" and is never whispered about. Recording again adds another sample to your voice (a running average), which helps in a different room or with another mic.

It refuses with a clear message if it heard less than 6 s of speech. If a second voice talked for more than 20% of the time, it still enrolls the main voice but tells you to record alone. Recording is capped at 40 s.

Measured on synthetic voices (11/14): an owner enrolled from 12 s of reading was recognised in a different conversation at **0.873** with 7.6 s of their speech. Fragments under about 2 s scored 0.70–0.73 (below the 0.85 threshold), and another person scored 0.35–0.68. Real voices still need checking.

## Live translation (Capture → Translate)

Starts a recording with `translate: true` (`KindredApp.startRecording({ mode: 'translate' })`). Capture sends live `{"event":"translation","seq","language","text","translation",…}` events. Each one appears in the **Capture** transcript (original in grey, English large) and on the floating mark's island, and its English is spoken in order through Argmax TTS, so use earbuds. A repeated `seq` replaces the earlier line. On stop, the session is saved to memory like any conversation, with `language` and `translation` on each line, so later questions can be answered from it. The capture side is in `capture/` (see its README).

## Two-way: Reply (German, Chinese, Spanish, French)

During **Live translation**, once Kindred has heard one of these four languages, a **🎙 Reply in French** button appears (or German, Chinese, Spanish). Press it, say your reply in English, then press **Done**.
1. Capture cuts your reply out of the live recording (`reply-start` / `reply-stop`) and transcribes it with English Whisper.
2. Bonsai 4B translates it (`app/translate.mjs`, a strict interpreter prompt with one worked example, temperature 0).
3. Argmax TTSKit says it **out loud** in that language (`speak` with `language`).

The reply appears in the Capture transcript as **You replied** with what was actually spoken. It targets the most recent supported language Kindred heard.
- **No echo:** live translation ignores the mic while you reply and while Kindred speaks (+0.6 s), so Kindred never translates its own French back to you.
- **Use the laptop speaker for two-way.** The other person has to hear the reply, and macOS plays through one output device at a time.
- **Why only these four languages:** in the 11/15 feasibility test, Italian, Portuguese, Japanese, Korean and Russian too often got allergens, days, or "who is speaking" wrong. See `capture/README.md`.
- **Measured end to end (11/15, simulated mic, real models):** your English transcribed in 0.15–0.5 s; Bonsai translated in 1.1–2.4 s; Argmax's first sound comes about 0.7 s after generation starts, so expect about 3–4 s from **Done** to hearing it.
- **Beta:** a small model translates, so double-check anything medical (allergies, doses).
