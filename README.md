# Kindred — an offline memory for the people in your life

> Clip it on, tap record, live your day. Kindred hears who you talk to (Argmax), remembers what matters about each person (Bonsai), and when someone walks up it quietly tells you who they are and what you promised them. Wi-Fi off. Nothing ever leaves the device.

**Local AI Hackathon (Cornell Commons) — theme: _Recreate_.** We recreate wearable AI memory pendants such as [Omi](https://www.omi.me), fully on-device, and specialise them for people with memory loss and their caregivers.

---

## 1. Hackathon requirements (do not break these)

| Rule | What it means for us |
|---|---|
| Must use **Bonsai-2 (2B / 4B / 9B only)** | Bonsai is the *only* language model. We use `bonsai-4b` via a local llama.cpp server. |
| Must use **Argmax** | Speech-to-text (WhisperKit), speaker diarization + voiceprints (SpeakerKit / Argmax Pro), speech (TTSKit). Swift on Apple Silicon. We have a **Pro API key** — keep it in an env var, never commit it. |
| Must run on a **Mac with Wi-Fi off** | All model weights downloaded ahead of time. Test the whole demo with Wi-Fi off, including the Pro license check. |
| Judging | 1) use of Bonsai/Argmax 2) creativity 3) wow factor 4) technical impressiveness |
| Submission — **noon, Sun 11/15**, `#submissions` | Names, one-sentence description, GitHub link, **video < 2 min**. Finalists: 4-minute live demo. |
| Teams | Max 2 people. |
| Extra tracks | Accessibility (LM Studio) — our memory-loss focus fits. Sustainability — our batch "dock" design fits. |

**Equal sponsor use is a design rule.** Every feature must need both: Argmax for *who/what was heard/how it's said*, Bonsai for *what it means/what to remember/how to answer*.

## 2. Product

**Who it's for:** an older adult with memory loss (and their caregiver), while remaining useful to anyone who needs a private memory of conversations.

**Three moments**

1. **Capture (out in the world).** One button. Argmax transcribes, separates speakers, and computes a voiceprint per speaker — cheap, always-on, on-device.
2. **Dock (back home).** Bonsai processes the day in one batch: names people from what was said, extracts facts/promises/appointments/allergies, links them to people, writes a short "core memory" card per person.
3. **Recall.**
   - **Live whisper:** a known voice starts talking → *"This is Maya, your neighbour. You promised to water her tomatoes."* (Argmax voiceprint → Bonsai memory → Argmax TTS)
   - **Ask:** *"What did the doctor change about my medication?"* → spoken answer + the original audio clip as proof.

Kindred is meant to remember ordinary conversations, family and doctor calls, appointments, promises, and directions. For travel, the planned Argmax capture flow can pair speech in the original language with a translation. Memory keeps both and cites the original audio; Bonsai can answer a later question such as *"How do we get back to the station?"* and Argmax can speak the answer. The live translation flow is being built in `capture/`.

**Planned photo memory:** add a photo locally, let Bonsai vision extract searchable details with the photo as evidence, then ask about it later. This is a product plan, not an implemented upload or retrieval path. See [current status and build plan](docs/MEMORY_STATUS.md).

### Why not just use Omi?

| | Omi | Kindred |
|---|---|---|
| Where it thinks | Cloud by default; offline only records and syncs later | **Fully on-device, Wi-Fi off** |
| Who said what | Paid tier; reviews report generic "Speaker 1/2" labels | **Core feature**: voiceprints + Bonsai names people from context |
| Memory model | Per-conversation summaries, to-dos | **People graph** across all conversations, with layered memory |
| Trust | Summaries | **Every answer cites the exact utterances + audio clip**; uncited facts are rejected |
| Cost | Subscription, query caps | None |

Specialisation: Omi answers *"what did we talk about?"*. Kindred answers *"who is this, and what do I need to remember about them?"* — the question a person with memory loss actually has, for conversations too private for the cloud (medical, family).

## 3. Architecture

```
            ┌──────────── capture/ (Swift · Argmax) ─────────────┐        ┌──────────── memory/ (Node · Bonsai) ────────────────┐
 mic ──▶ WhisperKit ─▶ words+timestamps ┐                          │        │                                                    │
        SpeakerKit ─▶ speaker per word  ├─▶ session.jsonl ─────────┼──dock──▶ L0 raw log (SQLite + FTS5)                         │
        Pro        ─▶ voiceprint/cluster┘   (docs/CONTRACT.md)     │        │   │ stage 1: filler filter + topic segmentation   │
                                                                   │        │   ▼ stage 2: Bonsai extraction (JSON schema)      │
        live: voiceprint ───────────────── identify ───────────────┼───────▶│ L1 episodes · L2 grounded facts · people graph    │
        TTSKit ◀──────────────────────── whisper line ◀────────────┼────────│   ▼ sleep-time: Bonsai rewrites L3 core memory    │
        TTSKit ◀──────────────────────── answer + clips ◀──────────┼────────│ recall: Bonsai pages memory in from disk (MemGPT)  │
            └──────────────────────────────────────────────────────┘        └────────────────────────────────────────────────────┘
```

### Memory design (the technical core)

Bonsai has a small context window and the memory grows forever, so **the prompt never holds the memory — the disk does, and Bonsai decides what to page in.**

| Layer | What | Who writes it | Research idea |
|---|---|---|---|
| **L0 raw** | Every utterance + speaker + audio offsets, FTS5-indexed | capture → ingest | MemGPT *recall storage* |
| **L1 episodes** | Topic segments with a Bonsai summary | dock stage 2 | LightMem short-term → summarised segments |
| **L2 facts** | `person · kind · text · when · evidence[utterance ids]` | dock stage 2 | LightMem long-term; grounded extraction |
| **L3 core** | ≤50-word card per person, always in Bonsai's prompt | dock sleep-time step | MemGPT *core memory*; LightMem *sleep-time update* |
| **People graph** | people, relations, voice centroids | dock (Bonsai names + Argmax voiceprints) | — our contribution: voice identity ⇄ semantic memory |

Key mechanisms:
- **LightMem-style pre-compression (stage 1, no LLM):** filler like "um, yeah" is dropped and the stream is cut into topic segments by silence gaps / size before Bonsai sees anything → fewer, smaller Bonsai calls.
- **Grounded extraction:** every fact must cite utterance ids that exist in the segment, otherwise it is rejected. Small model + memory-loss users = no hallucinated memories.
- **Voice ⇄ name binding, gated by evidence:** a name is validated first (placeholders, the owner, pronouns and forms of address like "Mom" are rejected; relations must be nouns such as `neighbour` or `granddaughter`). A voiceprint is enrolled only when the speaker introduced themselves ("Hi, it's Maya from next door", "Hey Mom, it's Sam") or said the name, so a hallucinated name cannot poison identity. Next time that voice appears, she is recognised instantly without the LLM.
- **Multi-person facts:** `fact_people` links a fact to everyone it concerns, so "Sam is coming with Lily" is found from either person's partition. Duplicate facts are skipped, and a changed number (5 mg → 10 mg) supersedes the older fact.
- **Sleep-time consolidation:** at dock, Bonsai selects the most useful facts for each core card and flags older facts superseded by newer ones. The card is assembled from source facts to prevent new prose from inventing details.
- **MemGPT-style recall:** Bonsai sees core memory + a working context with a hard budget (2,400 chars). It uses native tool calls to `search`, `open_episode`, or `answer`. Old pages are evicted when the budget overflows. Bonsai plans subqueries, makes embeddings for a vector + BM25 shortlist, then semantically selects up to six pages before paging begins.
- **Citations are verified:** an answer may only cite pages it actually loaded, including the always-visible core cards. Cited pages map back to utterance ids → audio clips (or to a photo).
- **Retrieval modes, with a real capability probe:** `hybrid-rerank` (default), `hybrid` and `bm25`. Embedding support is probed once against the server; if `/v1/embeddings` answers 501, dock and ask keep working in BM25 mode and `/health` says so. This is what makes the app safe to start without the embedding flag.
- **Photo memory:** a local image is copied into `data/photos/`, Bonsai vision extracts grounded observations, they are indexed with Bonsai embeddings + FTS5, and answers cite the original photo. The proposed capture handoff is in [docs/PHOTO_HANDOFF.md](docs/PHOTO_HANDOFF.md); the shared contract is unchanged.
- **Local actions with confirmation:** `play_original_clip` is read-only; `set_reminder`, `correct_memory` and `forget_memory` are two-phase — Bonsai proposes, the user confirms, then memory changes.
- **Grammar-constrained output:** every Bonsai call sends a JSON schema to llama.cpp, so output is always parseable.

## 4. Repository layout

```
docs/CONTRACT.md          the ONLY interface between the two halves — read this first
docs/PHOTO_HANDOFF.md     proposed image handoff for capture (not yet in the contract)
docs/MEMORY_STATUS.md     current memory status, retrieval modes and measurements
contract/fixtures/*.jsonl hand-written sessions (Maya, Dr. Patel, Sam) with fake voiceprints
capture/                  Swift · Argmax  → owner: Partner (Argmax lead)
memory/                   Node 24 · Bonsai → owner: Farhan (memory/retrieval lead)
bonsai-demo/              local PrismML checkout + 4B GGUF (git-ignored)
data/                     runtime: inbox/, audio/, photos/, kindred.sqlite (git-ignored)
```

## 5. Division of work

We split along the contract, so each person can build and demo their half alone using the fixtures, then plug together.

### Farhan — `memory/` (Bonsai: memory + retrieval)

**Status:** items 1–5 below are implemented on `bionic/bonsai-memory`; the memory visualisation
data (people graph + recall traces) is exposed over HTTP, the UI itself is still open. See
[docs/MEMORY_STATUS.md](docs/MEMORY_STATUS.md) for the current state and real-model numbers.
1. **Extraction quality on real Bonsai 4B** (see Status for failures seen): speakers named from self-introductions ("it's Sam") not put in `mentioned`; reject placeholder names (`?`, `owner`, `Mom` as a person when it's the owner); relation as a noun (`neighbour`, not `next door`); first-person facts rewritten to third person.
2. **Core memory prompt:** owner's card hallucinated ("your partner…"). Separate prompt for the owner vs. other people; only use facts given.
3. **Recall quality:** answer combined questions (Sam's visit *and* Lily's allergy), resolve relative dates ("this Sunday" relative to recording date), prefer facts over raw utterances.
4. **Make it measurable:** a tiny eval (10–15 questions over the fixtures, scored for correct + grounded). Show judges numbers, not vibes.
5. **Long-running memory server:** wrap `who` / `ask` / `dock` in a local HTTP or stdin JSON server so capture/UI don't spawn Node per call.
6. **Memory visualisation (stretch):** people graph + the recall trace (what Bonsai paged in/out) — this is the "technical wow" screen.

### Partner — `capture/` (Argmax: hearing, identity, voice)
1. **Get `process` working offline:** download WhisperKit / SpeakerKit / TTSKit models once, point `KINDRED_*_MODEL` env vars at them, verify with Wi-Fi off.
2. **Voiceprints (critical path):** open-source SpeakerKit does **not** expose speaker embeddings. Use the **Argmax Pro SDK** to get a per-cluster embedding and write it into `speaker.voiceprint`. Without this, live recognition doesn't work.
3. **Live capture:** `record` command — mic → rolling buffer → streaming transcription; emit `speaker` events with `final:false` as soon as a cluster is stable (for the live whisper).
4. **Whisper loop:** on a new stable speaker, call memory `who` → speak the line with TTSKit (quiet, short, interruptible).
5. **Audio clips:** save session audio to `data/audio/` so recall can replay evidence.
6. **App shell / UI (with Farhan):** one record button, live transcript with speaker colours, "dock" button, ask box/mic. Simple is fine.

### Together
- **Integration checkpoint:** a real recorded session goes capture → dock → ask, Wi-Fi off.
- **Demo script + video** (< 2 min), README polish, submission.

### Suggested timeline (to noon Sunday)
| By | Farhan (memory) | Partner (capture) |
|---|---|---|
| Sat 9 pm | extraction + core prompt fixes, eval set | offline models, `process` on a real WAV, Pro SDK voiceprints |
| Sun 2 am | recall fixes, memory server | live `record` + `who` → TTS whisper |
| Sun 8 am | graph/trace view | UI shell, audio clips |
| Sun 10 am | **integration, Wi-Fi-off run, record demo video** | ← same |
| Sun 12 pm | **submit** | |

## 6. Status

See [current status and build plan](docs/MEMORY_STATUS.md) for completed code, measured results, remaining risks, and planned features. The working local model is Bonsai 2 4B. The photo memory path and additional action tools are planned, not built.

## 7. Running it

**Bonsai server** (the local PrismML Bonsai demo checkout is in `bonsai-demo/`, ignored by this repo):
```sh
cd bonsai-demo
BONSAI_FAMILY=bonsai2 BONSAI_MODEL=4B BONSAI_CTX=8192 BONSAI_THINKING=0 BONSAI_NGL=99 BONSAI_HOST=127.0.0.1 \
  ./scripts/start_llama_server.sh -np 1 --alias bonsai-4b --embeddings --pooling mean
```

**Memory** (Node 24+, no dependencies):
```sh
cd memory
npm test                 # scripted model, no server needed
npm run demo             # full fixture day against the real Bonsai server
npm run kindred -- ingest ../data/inbox/*.jsonl
npm run kindred -- dock
npm run kindred -- ask "What did Maya ask me to do?"
npm run kindred -- people
```
Env: `BONSAI_URL` (default `http://127.0.0.1:8080/v1`), `BONSAI_MODEL` (`bonsai-4b`), `KINDRED_DB` (`data/kindred.sqlite`).

**Capture** (Apple Silicon, Xcode 16+):
```sh
cd capture
swift build -c release
.build/release/kindred-capture process ~/some-conversation.wav --place "kitchen" --out ../data/inbox
.build/release/kindred-capture speak "This is Maya, your neighbour."
```
Env: `KINDRED_WHISPER_MODEL`, `KINDRED_TTS_MODEL` (local model folders, required for Wi-Fi-off), `KINDRED_VOICE` (`ryan`).

## 8. Privacy and consent
Recording people has legal and ethical limits. Kindred shows a visible recording state, keeps everything on the device, and will support "forget this conversation/person" (delete L0–L3 rows + audio). Mention this in the demo.
