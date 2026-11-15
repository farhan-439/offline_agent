# app/ — Pebble desktop app (Electron)

One hub window with Capture, Memory, and Actions screens. Everything runs on this Mac with Wi-Fi off: system fonts, no CDN, local assets only.

| Screen | What it does |
|---|---|
| **Capture** (main page) ⬅ the stone | The mark switches between **Record**, **Translate**, and **Ask**. Translate shows the live transcript and reply controls; Ask shows the recognized question, answer, and sources below the stone. On stop, a Record or Translate session is sent to memory `/ingest`. |
| **Memory** | Two readings of the same store, switched in the header: **Map** (default, `atlas.mjs`) and **Shelf**. The map is the whole picture — the pipeline (heard → filtered → summarized → facts → people), every person over time with their facts, a trace from any fact back to the words and episode it came from, recall, what is coming up, and translations. The shelf is the detail — the fact browser, recall ring, questions with sources, what is on disk, the last two weeks. Both keep **Dock today**, **Add photo**, and **My voice**. |
| **Actions** | Bonsai proposes Calendar events, Reminders, Notes, and birthday updates from saved facts. Every proposal shows its source and needs a separate Add confirmation. |
| **The mark** | The five-bar mark is the button on Capture. The always-on-top floating version is **switched off for now** (`createOrb()` / `createChat()` still exist in `main.cjs`, but nothing is drawn outside the window). |

## Capture: Record, Translate, and the live transcript

The Capture switch has **Record · Translate · Ask**. In Ask, tap the stone to speak or type in the field below; the recognized words and answer appear on the same page. The line under the stone reports state (`Tap to record`, `Recording · 0:14`, `Translating · 0:47`, `Listening`, `Finding your answer…`). While the microphone is busy the other modes are disabled with a reason.

In **Translate**, the page shows a live transcript under the stone: each heard line as `French: "…"` with its English underneath, and your own replies as `You replied` in the language Pebble spoke. States are named (`Listening`, `Translating`, `Listening to you`, `Speaking your reply`, `Saving`, `Saved`). Rows are keyed by translation `seq`, so a line that arrives twice with better text **replaces** rather than duplicates, and the last session stays on screen after **Stop** until a new session begins.

**Record** shows only the real recording state. It does not invent a transcript, because capture does not stream text for ordinary recordings.

## Actions: from recordings to reviewed drafts

**Dock today** extracts evidence-linked facts from recordings and starts an Actions scan. **Compile actions** scans all unexamined saved facts in batches of eight, with a Stop control between batches. Bonsai returns grammar-locked drafts; the app derives dates and clock times only from saved evidence. An ambiguous time such as “at ten” is left blank for review. A medication frequency never becomes invented clock times or a duration.

The Actions screen lists proposed and added actions on the left. Selecting one shows the saved fact, original words, and a playable clip when audio exists. Edit the details, choose **Review before adding**, then **Queue for Run**. Pebble validates the required details before queueing. **Run reviewed** shows every queued item and destination together; only the final **Run actions** click writes to Mac apps. Results appear on the board, and added items have an **Open Calendar / Reminders / Notes / Contacts** button. The exported item includes the source fact, original words, and local clip path in its notes. A failed export needs fresh review; if tracking fails after a successful export, the draft stays locked to prevent duplicates.

Calendar and Reminders use EventKit. The first Add may trigger macOS permission. Both choose an **On My Mac** local calendar/list and show a setup error if one is unavailable. Notes uses the **On My Mac** account. Contacts requires one exact matching name and an actual birth year entered by the user. Contact account sync depends on where that existing card lives.

For the demo, use Leo's game for Calendar, a ladder return for Reminders, and a cough syrup schedule only after entering exact daily times, start date, and number of days. The graph and old shelf are no longer shown.

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
| `index.html`, `renderer.js`, `renderer.css`, `actions.mjs`, `actions.css`, `view.mjs` | Hub UI: capture modes, chat, and the Actions board. Focus rings, screen-reader labels, reduced motion, and a narrow-window layout. |
| `native-actions.mjs`, `native/` | Reviewed local export to EventKit and Contacts, plus Notes AppleScript. |
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

During **Live translation**, use the selector to choose Auto (the last supported language heard), Spanish, French, German, or Chinese. You can press **Speak reply**, say English, then press **Done speaking**; or type English and press **Translate & speak**. A spoken or typed reply can begin “Translate this to Spanish: …” to set the language for that reply. Saying only “Translate this to Spanish” switches the target for subsequent replies.
1. Capture cuts your reply out of the live recording (`reply-start` / `reply-stop`) and transcribes it with English Whisper.
2. Bonsai 4B translates it (`app/translate.mjs`, a strict interpreter prompt with one worked example, temperature 0).
3. Argmax TTSKit says it **out loud** in that language (`speak` with `language`).

The reply appears in the Capture transcript as **You replied**. The spoken foreign-language text and its English meaning are saved in the session file, then indexed for later recall.
- **No echo:** live translation ignores the mic while you reply and while Kindred speaks (+0.6 s), so Kindred never translates its own French back to you.
- **Use the laptop speaker for two-way.** The other person has to hear the reply, and macOS plays through one output device at a time.
- **Why only these four languages:** in the 11/15 feasibility test, Italian, Portuguese, Japanese, Korean and Russian too often got allergens, days, or "who is speaking" wrong. See `capture/README.md`.
- **Measured end to end (11/15, simulated mic, real models):** your English transcribed in 0.15–0.5 s; Bonsai translated in 1.1–2.4 s; Argmax's first sound comes about 0.7 s after generation starts, so expect about 3–4 s from **Done** to hearing it.
- **Beta:** a small model translates, so double-check anything medical (allergies, doses).
