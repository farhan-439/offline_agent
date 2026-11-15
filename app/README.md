# app/ — Kindred desktop app (Electron)

One hub window with three screens, a floating orb, and a small chat window opened by the orb. Everything runs on this Mac with Wi-Fi off: system fonts, no CDN, local assets only.

| Screen | What it does |
|---|---|
| **Record** | One big button. While recording, a red banner, a red pulsing button and `● Recording` in the title make the recording state visible (privacy). Shows the mic in use (`mic-live`), each live voice as it's detected (`speaker`, `final:false`), and who it is once memory recognises it. On stop, the session file is sent to memory `/ingest`. |
| **People** | "Dock today's conversations" calls memory `/dock`, then lists people from `GET /people`: name, relation and core memory card. |
| **Ask** | Text box → memory `/ask`. The answer is shown and spoken (Argmax TTSKit, Mac voice as fallback). Cited memory text and photos are shown, and each cited clip has a ▶ Play button for its time range. |
| **Orb** | The one control for everything. Always-on-top bubble at the bottom of the screen; click it for a menu with three big choices: **Start recording**, **Ask a question** (type, or tap **Talk to Kindred** and speak), **Live translation**. While recording or translating, the card shows the timer, voices heard (with match %) or live translations, and one **Stop** button; the other choices are greyed out with the reason (they share the microphone). The orb stays an orb: recording adds a thin red ring and a pulsing red dot, translating a cyan ring and a 文A badge. Whispers ("This is Dr. Patel…") appear on the card over any view. Right-click for a menu. |

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
| `index.html`, `renderer.js`, `renderer.css`, `view.mjs` | Hub UI. 19px base type, 56px targets, focus rings, reduced motion. |
| `orb.html`, `orb.js`, `orb.css` | Floating orb. |

## Tests

```sh
npm test
```

`test/core.test.mjs` runs the real `CaptureBridge` against a fake `kindred-capture serve` script and the real `LiveWhisper` against a fake memory HTTP server. It covers: record → live voices → whisper → ingest; memory down; dock + people; ask + clip URLs; a crashed helper; and cancel. This proves the plumbing only, not real voice matching.

Voice questions use capture's existing short recording path and delete the temporary audio and JSONL after transcription. They are never sent to memory `/ingest`; only the question text goes to `/ask`.

## Your voice ("Teach Kindred my voice")

On the **People** screen, press **Teach Kindred my voice**, read the passage aloud (about 20 s, alone), then press **Done reading**. The app records with live detection off, takes the voiceprint of the voice that talked longest, and sends it to memory's `POST /enroll-owner`. The sample is then **deleted**; it is never stored or docked as a conversation. Afterwards your own voice is labelled "You" and is never whispered about. Recording again adds another sample to your voice (a running average), which helps in a different room or with another mic.

It refuses with a clear message if it heard less than 6 s of speech. If a second voice talked for more than 20% of the time, it still enrolls the main voice but tells you to record alone. Recording is capped at 40 s.

Measured on synthetic voices (11/14): an owner enrolled from 12 s of reading was recognised in a different conversation at **0.873** with 7.6 s of their speech. Fragments under about 2 s scored 0.70–0.73 (below the 0.85 threshold), and another person scored 0.35–0.68. Real voices still need checking.

## Live translation (orb → Live translation)

Starts a recording with `translate: true` (`KindredApp.startRecording({ mode: 'translate' })`). Capture sends live `{"event":"translation","seq","language","text","translation",…}` events. Each one is shown on the orb card (original in grey, English large; the latest four) and its English is spoken in order through Argmax TTS, so use earbuds. A repeated `seq` replaces the earlier line. On stop, the session is saved to memory like any conversation, with `language` and `translation` on each line, so later questions can be answered from it. The capture side is in `capture/` (see its README).

## Two-way: Reply (German, Chinese, Spanish, French)

During **Live translation**, once Kindred has heard one of these four languages, a **🎙 Reply in French** button appears (or German, Chinese, Spanish). Press it, say your reply in English, then press **Done**.
1. Capture cuts your reply out of the live recording (`reply-start` / `reply-stop`) and transcribes it with English Whisper.
2. Bonsai 4B translates it (`app/translate.mjs`, a strict interpreter prompt with one worked example, temperature 0).
3. Argmax TTSKit says it **out loud** in that language (`speak` with `language`).

The card shows "You: …" and what they heard. The reply targets the most recent supported language Kindred heard.
- **No echo:** live translation ignores the mic while you reply and while Kindred speaks (+0.6 s), so Kindred never translates its own French back to you.
- **Use the laptop speaker for two-way.** The other person has to hear the reply, and macOS plays through one output device at a time.
- **Why only these four languages:** in the 11/15 feasibility test, Italian, Portuguese, Japanese, Korean and Russian too often got allergens, days, or "who is speaking" wrong. See `capture/README.md`.
- **Measured end to end (11/15, simulated mic, real models):** your English transcribed in 0.15–0.5 s; Bonsai translated in 1.1–2.4 s; Argmax's first sound comes about 0.7 s after generation starts, so expect about 3–4 s from **Done** to hearing it.
- **Beta:** a small model translates, so double-check anything medical (allergies, doses).
