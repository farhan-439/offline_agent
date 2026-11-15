# Pebble — a private memory that can act

Pebble is a desktop companion that hears a conversation, remembers the people and details that matter, finds the original evidence when you ask, and helps turn a remembered promise into a reviewed action. Speech, language-model inference, and memory run on an Apple Silicon Mac. The repository and launcher are named **Kindred**; **Pebble** is the app you use.

> Record a conversation with Maya. Later ask, “What did I promise her?” Pebble finds the memory, shows the words it came from, and can play the original clip. If that promise belongs in Reminders, Pebble prepares a draft for you to check before adding it.

Pebble is motivated by the needs of people with memory loss and their caregivers, and is useful to anyone who wants a private memory of conversations. A small model cannot hold a life of conversations in its context window, while a generic summary can lose who said what. Pebble keeps the long record on disk, retrieves only relevant pieces, and ties answers and actions back to sources.

## What Pebble does

- **Record and remember.** Argmax WhisperKit transcribes speech; SpeakerKit separates speakers and produces voiceprints. **Dock today** uses Bonsai 2 4B to extract people, facts, dates, promises, episodes, and short memory cards.
- **Recognize someone returning.** With a usable voiceprint, Pebble can identify a familiar speaker and speak a short reminder through Argmax TTSKit. You can enroll your own voice so it is not treated as a visitor's.
- **Ask with evidence.** Ask by voice or text. Pebble searches conversations, notes, and photos, and shows citations with available audio clips or images. You can attach a photo or text file to a question, or add a photo to memory.
- **Translate and reply.** Translate mode shows the original speech and an English translation, and speaks the English. Reply in English by voice or text; Bonsai translates the reply into Spanish, French, German, or Chinese, and Argmax TTSKit speaks it in that language.
- **Review actions.** Bonsai drafts Calendar events, Reminders, Notes, and birthday updates from saved facts. You inspect the source, edit a draft, queue it, review the run, and explicitly choose **Run actions** before a Mac app is changed.
- **Inspect memory.** The Memory screen offers a map of the pipeline and people over time, and a shelf for facts, recall traces, and sources.

The hackathon's Technical Details permit Bonsai 2B, 4B, or 9B as the language model and require Argmax for on-device speech. This project uses **Bonsai 2 4B as its only language model** for extraction, recall, photo understanding, action drafting, and reply translation. The tested 4B GGUF is about 1.1 GB plus a roughly 350 MB vision projector; actual RAM use rises with context and the other loaded models.

## Requirements

This desktop build targets an **Apple Silicon Mac (M1 or newer) with macOS 15 or newer**. Prepare these while online:

1. **Node.js 24 or newer** and npm.
2. **Swift 6.3 or newer** and Xcode Command Line Tools. Check with `swift --version` and `xcode-select -p`.
3. Free disk space for Bonsai, roughly 1.3 GB of Argmax speech models, Electron, and your recordings.
4. A microphone. Earbuds help keep spoken reminders out of the recording; for two-way replies, choose an output the other person can hear.
5. An **Argmax Pro API key** for Sortformer live speaker detection. Without Pro, the open-source rolling speaker fallback remains available.

The event brief also mentions recent Snapdragon/Qualcomm devices, but this repository's Electron and Swift launcher is for macOS. The commands below do not set up Android, Windows, or Linux.

## Install on another Mac

Run these while connected to the internet. The model checkout, weights, local database, recordings, and `.env` are ignored by Git, so cloning this repository alone does not bring them along.

```sh
git clone https://github.com/farhan-439/offline_agent.git
cd offline_agent

git clone https://github.com/PrismML-Eng/Bonsai-demo.git bonsai-demo
cd bonsai-demo
BONSAI_FAMILY=bonsai2 BONSAI_MODEL=4B BONSAI_OPENWEBUI=0 BONSAI_CODE_INTERPRETER=0 ./setup.sh
cd ..

cd capture
npm run build
.build/release/kindred-capture provision
cd ..

cd app
npm ci
cd ..
```

The Bonsai setup downloads the **4B** checkpoint and matching llama.cpp binary. Keep `BONSAI_MODEL=4B`: the upstream demo defaults to 27B, outside this project's event constraint. Argmax `provision` stages WhisperKit, SpeakerKit, TTSKit, live-detection, and multilingual models under `~/Library/Caches/Kindred/`. Finish it before going offline.

For Argmax Pro, store the runtime key in the ignored root `.env` file as `ARGMAX_API_KEY=ax_...`, or export it in your shell. The `axst_...` package-registry credential and `ax_...` runtime key are different. See [Argmax setup and licensing](capture/README.md#argmax-pro-sdk) if the Swift package cannot be fetched or Pro is unavailable. Never commit either credential.

```sh
./kindred --check
```

The preflight checks Node, the Swift binary, Electron, staged models, Pro status, and local services. A warning that Bonsai is not running is expected; `./kindred` starts it. Fix missing binaries or models before trying an offline demo.

## Start and use Pebble

```sh
./kindred
```

The launcher starts the local Bonsai server on `127.0.0.1:8080` if needed and opens the Electron app. The app starts and supervises the memory service on `127.0.0.1:8787`. Normal memory lives in `data/kindred.sqlite`; recordings, photos, and logs are under `data/`. Quitting the app stops the memory service it started. Bonsai can remain running for the next launch.

1. Open **Capture → Record**, press the stone, have a conversation, then stop.
2. Open **Memory → Dock today**. Bonsai turns the saved session into searchable people, episodes, and facts.
3. Open **Capture → Ask**. Type or speak a question, inspect the cited source, and play its audio if available.
4. In **Memory**, use **Map** to follow speech through the memory pipeline, or **Shelf** to inspect records and recall. **My voice** enrolls your voice for live recognition.
5. In **Actions**, choose **Compile**, review a proposal and source, edit its details, queue it, inspect **Run reviewed**, then choose **Run actions**. macOS may ask Pebble Actions for Calendar, Reminders, or Contacts permission.

For travel, use **Capture → Translate**. The live transcript shows the other person's language and English. Use **Speak reply** or type an English reply; choose Auto or one of the four supported reply languages. Pebble suppresses its own playback and your reply from live translation so it does not translate itself back as another speaker. Check names, dates, doses, and allergens with the person directly.

### Sample memory

To explore recall before recording anyone, start Bonsai and build the demo database:

```sh
memory/scripts/start-bonsai.sh
```

Keep that terminal open until the server is ready. In a second terminal at the repository root:

```sh
node scripts/demo-db.mjs
./kindred --demo
```

The sample conversations are about Maya, Dr. Patel, Sam, and Lily. Their fixture voiceprints are placeholders; a live whisper needs a real recording and enrollment. `scripts/demo-db.mjs` rebuilds `data/demo.sqlite`; your own conversations use `data/kindred.sqlite`. If Bonsai is already running, skip the manual server command. An existing memory server on port 8787 keeps its current database, so stop it before switching to `--demo`.

## How it works

```text
Mic / photo / note
  → Argmax WhisperKit: words, language, translation
  → Argmax SpeakerKit / Pro: speakers and voiceprints
  → saved audio, photo, timestamps, and source IDs
  → Bonsai 2 4B: filter, extract, ground, consolidate
  → SQLite: raw lines → episodes → facts → core cards
  → keyword + vector search → Bonsai selection → cited answer
  → Argmax TTSKit speaks; reviewed drafts can become Mac actions
```

The long record stays **on disk**. Bonsai produces short episodes and evidence-linked facts, then keeps small core cards close. Recall searches and pages in relevant evidence instead of packing every conversation into the prompt. Facts without valid source IDs are rejected; answers may cite only material the system loaded. Search combines embeddings and keyword search when available and falls back to keyword search if embeddings are unavailable.

**Argmax handles hearing, speaker identity, and speech output; Bonsai handles meaning, memory, retrieval, and translation of your reply.** `capture/` is Swift, `memory/` is Node and SQLite, and `app/` is Electron. Their session format is in [docs/CONTRACT.md](docs/CONTRACT.md).

## Privacy and known limits

- Inference and stored memory are local after provisioning. Setup downloads models; Argmax Pro may require an online license check or a valid cached token. A connected Mac's Calendar, Contacts, or Notes account can sync independently of Pebble. Use **On My Mac** destinations for the most private action flow; see [the app guide](app/README.md#actions-from-recordings-to-reviewed-drafts).
- Recording other people requires their consent where applicable. Source audio and photos remain under local `data/`; protect the Mac account and disk as you would any personal archive.
- Live voice recognition was measured mainly with synthetic voices and simulated microphone input. Noise, accents, short turns, and overlapping speakers can lower accuracy. A person may need several seconds of speech before recognition is possible.
- Translation can mishear or mistranslate numbers, names, medical details, or code-switched speech. Two-way replies are limited to Spanish, French, German, and Chinese based on the project's feasibility checks.
- The launcher uses Bonsai 2 4B with an 8,192-token server context and one server slot. Speed and RAM use depend on the Mac and session length; identical timing on every laptop is not guaranteed.

## Tests and troubleshooting

```sh
cd memory && npm test
cd ../capture && npm test
cd ../app && npm test
```

These tests cover memory rules and app/capture plumbing, with fakes in several paths. For an end-to-end check, provision while online, then record and dock a real conversation, ask a sourced question, try translation, and repeat with Wi-Fi disabled.

| Symptom | Check |
|---|---|
| Missing Argmax models | Re-run `capture/.build/release/kindred-capture provision` while online. |
| Bonsai does not start | Read `data/logs/bonsai.log`; confirm `bonsai-demo/bin/mac/llama-server` and the 4B GGUF exist. Paths can be overridden with `BONSAI_DEMO_DIR`, `BONSAI_BIN`, `BONSAI_GGUF`, and `BONSAI_MMPROJ`. |
| The app opens but cannot answer | Read `data/logs/memory.log` and check ports 8080 and 8787. |
| Pro live detection is unavailable | Run `capture/.build/release/kindred-capture license`; check the `ax_...` key and cached license. |
| A Mac action cannot be added | Review required dates and times, grant macOS permission, and create an **On My Mac** calendar or list if needed. |

Implementation guides: [capture](capture/README.md), [memory](memory/README.md), [app](app/README.md). Startup logic: [scripts/kindred.mjs](scripts/kindred.mjs). Demo data builder: [scripts/demo-db.mjs](scripts/demo-db.mjs).
