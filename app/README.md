# app/ — Kindred desktop app (Electron)

One hub window with three screens, a floating orb, and a small chat window opened by the orb. Everything runs on this Mac with Wi-Fi off: system fonts, no CDN, local assets only.

| Screen | What it does |
|---|---|
| **Record** | One big button. While recording, a red banner, a red pulsing button and `● Recording` in the title make the recording state visible (privacy). Shows the mic in use (`mic-live`), each live voice as it's detected (`speaker`, `final:false`), and who it is once memory recognises it. On stop, the session file is sent to memory `/ingest`. |
| **People** | "Dock today's conversations" calls memory `/dock`, then lists people from `GET /people`: name, relation and core memory card. |
| **Ask** | Text box → memory `/ask`. The answer is shown and spoken (Argmax TTSKit, Mac voice as fallback). Cited memory text and photos are shown, and each cited clip has a ▶ Play button for its time range. |
| **Orb** | Always-on-top bubble at the bottom of the screen. Click it to open a conversation panel: type a question or tap **Talk to Kindred**, speak, then tap **Done speaking**. Argmax transcribes the question, Bonsai retrieves the answer, and Argmax speaks it. The temporary question recording is deleted. The orb also shows live identity whispers during conversation recording. Right-click for a menu. |

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
