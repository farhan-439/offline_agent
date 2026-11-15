# Handoff: Bonsai memory work (branch `bionic/bonsai-memory`)

Written 2026-11-14 for whoever picks this up next. Everything below is on the branch, not `main`.
`docs/CONTRACT.md` and `capture/` are untouched.

## Where things stand

- **Repo:** `~/Projects/Bionic-Test`, branch `bionic/bonsai-memory`, remote `origin`
  (`github.com/farhan-439/offline_agent`). Base commit was `373694c`.
- **Model server:** Bonsai 2 **4B** on `http://127.0.0.1:8080/v1`, started with
  `memory/scripts/start-bonsai.sh`. It serves chat, tools, vision and `/v1/embeddings` from one
  process (2,560-dim, ~2.1 GB RSS). Verified: `/v1/embeddings` → 200, `/v1/chat/completions` → 200.
  PID and log are transient (`/tmp/llama-8080.log`); restart with the script, not by hand.
- **Tests:** `cd memory && npm test` → **31/31 passing**, ~4 s, scripted model (plumbing/policy,
  not accuracy).
- **Benchmark:** the real-model matrix was still running when this was written. See below.

## What is implemented (details in `docs/MEMORY_STATUS.md`, `memory/README.md`)

1. **Embedding capability probe + graceful degradation.** `POST /v1/embeddings` is probed once and
   cached. Modes `bm25` / `hybrid` / `hybrid-rerank`, default `hybrid-rerank`, override with
   `KINDRED_RETRIEVAL`. A 501 no longer kills `dock` or `ask`. `/health` reports
   `retrievalMode`, `embeddings`, `degraded`.
2. **Grounded identity.** Name/relation validation (`src/names.mjs`), deterministic
   self-introduction detection, voice enrolment only with evidence, title canonicalisation,
   owner-relative relation nouns, no phantom people, no relation inferred from "Mom".
3. **Multi-person facts** (`fact_people`), person-partition search, duplicate skip, number/ordinal
   supersede, ISO/numeric/ordinal dates, compound-question coverage across BM25 + vectors.
4. **Core cards are citeable** (`P:<person>`), so answers from a card still carry utterance
   evidence; owner cards render in the second person.
5. **Photo memory** (`src/photos.mjs`): local ingest, SHA-256 dedupe, Bonsai vision observations,
   FTS5 + Bonsai vectors, `photo_people` links, answers cite `O<n>` and return the photo.
   Proposed capture handoff: `docs/PHOTO_HANDOFF.md` (not in the contract yet).
6. **Local actions** (`src/actions.mjs`): `play_original_clip` read-only; `set_reminder`,
   `correct_memory`, `forget_memory` are two-phase (propose → confirm) and logged.
7. **Demo-view data:** `GET /people`, `GET /traces`, `GET /actions`; `/ask` returns the trace,
   clips and photos.
8. **Ledger data + explicit save:** `GET /memories` returns each fact with its statement, source
   quote, `origin` (`user` vs `extracted`), `scope`, real `uses`/`lastUsed` counters and status;
   `POST /memory` saves a user-authored memory. `docs/UI_BACKEND_CONTRACT.md` is the adapter
   contract for the UI agent (real shapes plus the gaps it must not fake).

## The benchmark (must be finished)

`memory/eval/compare.mjs`: 10 fixture questions × 3 retrieval modes × 3 repetitions, fresh DB per
run (dock included, because extraction varies). Strict scoring: a refusal is never correct; evidence
means every expected utterance id was cited.

```sh
cd memory
npm run compare -- --repeats=3     # writes eval/results/compare-<timestamp>.json
npm run summarize                  # strict per-mode table + failing questions
```

**Status: one full 9-run matrix completed, then the code changed and the re-run was stopped.**

| mode | answer | evidence | both | refusals | median ms |
|---|---|---|---|---|---|
| bm25 | 29/30 | 23/30 | 23/30 | 0 | 2,796 |
| hybrid | 27/30 | 23/30 | 23/30 | 3 | 5,838 |
| hybrid-rerank | 24/30 | 22/30 | 22/30 | 3 | 6,113 |

That matrix predates the `final_answer` fallback (added afterwards to fix runs that refused while
the evidence was already in the prompt). A targeted re-run of the four previously failing questions
on the fixed code shows **0 refusals in both hybrid modes**; `hybrid` answers the compound Sam/Lily
question correctly, `hybrid-rerank` still picks medication advice instead of the allergy. The JSON
for the completed matrix was moved to `/tmp/pre-fallback-compare.json` during the (stopped) re-run,
so it is **not** in the repo — re-measure rather than quoting it.

**First job for the next agent:**

```sh
cd memory
npm run compare -- --repeats=3   # ~20 min on this Mac
npm run summarize                # strict table + failing questions
```

Then paste the result into `docs/MEMORY_STATUS.md`.

## Remaining work

1. **Re-measure after the empty-answer fix** (the 9-run table predates it), run
   `npm run summarize`, and update the measurement section in `docs/MEMORY_STATUS.md`.
2. **Real vision smoke test** (not yet run with the real model):
   ```sh
   cd memory
   KINDRED_DB=/tmp/photo.sqlite node src/cli.mjs photo ../bonsai-demo/assets/frontier.png "test photo"
   KINDRED_DB=/tmp/photo.sqlite node src/cli.mjs ask "What is in the photo?"
   ```
3. **Latency win, not yet done:** the llama.cpp log shows every recall step first attempts a
   native tool call that returns only ~3 tokens (no `tool_calls`), then falls back to the JSON
   schema call. Caching that miss (`bonsai.toolMisses`) and skipping the native attempt would cut
   roughly 40% of the model requests per question. No accuracy change; re-measure after.
4. **UI**: render `/people` and `/traces` (the data is there; nothing draws it).
5. **Capture side**: real voiceprints in `speaker.voiceprint` — live identity is blocked there.
6. **Wi-Fi-off demo run** end to end, then the <2 min video.

## Hard constraints (from Farhan)

- Offline product; **Bonsai only** as the text-generating model and the embedding source. No second
  embedding model.
- **Do not run 9B.** Do not edit `capture/`. Do not change `docs/CONTRACT.md` without the Argmax
  teammate.
- Never commit API keys. Argmax Pro key stays in an env var.
- `bonsai-demo/`, `KINDRED_HANDOVER.md` and `data/` are intentionally git-ignored.
- Don't overwrite ignored user data (`data/*.sqlite`, `data/photos/`) without reason.
