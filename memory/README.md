# memory/ — Bonsai side (owner: Farhan)

Layered people memory with Bonsai-managed paging. Design is described in the root README §3.

| File | Role |
|---|---|
| `src/db.mjs` | SQLite schema for L0–L3 + people graph (FTS5 indexes) |
| `src/ingest.mjs` | contract JSONL → L0 (idempotent) |
| `src/identity.mjs` | voiceprint cosine matching, voice centroids, owner enrolment |
| `src/dock.mjs` | stage 1 filter/segment → stage 2 Bonsai extraction (grounded) → sleep-time core memory |
| `src/embeddings.mjs` | incremental Bonsai vector index in SQLite |
| `src/retrieve.mjs` | BM25 + Bonsai vector shortlist with reciprocal-rank fusion |
| `src/recall.mjs` | MemGPT-style ask loop with working-memory budget, eviction, verified citations |
| `src/whisper.mjs` | live "who is this?" line (template fallback if Bonsai is slow) |
| `src/bonsai.mjs` | llama.cpp client, JSON-schema constrained, call trace |
| `src/capabilities.mjs` | real `/v1/embeddings` probe, cached; chooses bm25 vs hybrid vs hybrid-rerank |
| `src/names.mjs` | name/relation validation and self-introduction detection (grounded identity) |
| `src/text.mjs` | deterministic duplicate/contradiction detection |
| `src/photos.mjs` | local photo ingest, Bonsai vision observations, photo evidence |
| `src/actions.mjs` | reminders, clip playback, corrections and forgetting (two-phase confirmation) |
| `scripts/start-bonsai.sh` | launches the single 4B server with chat + vision + embeddings |
| `test/` | end-to-end tests with a scripted model (plumbing only, not accuracy) |

Task list: see "Farhan" in the root README §5.

## Bonsai memory retrieval

Start the **single** Bonsai 4B server with `--embeddings --pooling mean` added to the normal launcher flags. Both `/v1/embeddings` and `/v1/chat/completions` then use the same local model. `BONSAI_URL` defaults to `http://127.0.0.1:8080/v1`; `KINDRED_EMBED_URL` can override the embedding endpoint's `/v1` base URL.

At dock, Bonsai embeds facts, episode summaries, core cards and photo observations. The vectors are stored as float32 BLOBs with a content hash, so another `dock` indexes only changed memories. At ask, Bonsai plans up to three searches; each search combines BM25 and Bonsai vector results into a fixed shortlist. Bonsai selects up to six pages, then uses native tool calls to search, open an episode, or answer with citations. Exact-term BM25 remains useful for names and doses; there is no second embedding model.

### Retrieval modes and graceful degradation

| Mode | What runs | Use |
|---|---|---|
| `hybrid-rerank` (default) | Bonsai plans subqueries, hybrid shortlist, Bonsai selects pages, paged answer | normal operation |
| `hybrid` | one hybrid shortlist, then the paged answer | ablation without planning/selection calls |
| `bm25` | keyword-only retrieval, then the paged answer | ablation, and automatic fallback |

`KINDRED_RETRIEVAL=bm25|hybrid|hybrid-rerank` overrides the mode. Embedding capability is probed
once against the real server (`POST /v1/embeddings`) and cached on the client. If the server answers
501, both `dock` and `ask` keep working in `bm25` mode, and `GET /health` reports the mode actually
active (`retrievalMode`, `embeddings`, `degraded`). `KINDRED_EMBED=0` forces BM25 without probing.

Start the server with `memory/scripts/start-bonsai.sh`: chat, tools, vision and embeddings on one
4B process (~2 GB). Do not use the 9B weights.

`npm test` uses a scripted model and does not measure Bonsai's retrieval accuracy.

`npm run eval` runs ten fixture questions against real Bonsai and reports answer keywords, evidence ids, latency and the active mode. `npm run eval -- --mode=bm25` (or `--mode=hybrid`) runs an ablation with the same Bonsai generator. `npm run compare -- --repeats=3` runs all three modes repeatedly with a fresh database each time (dock included, because extraction varies) and writes `eval/results/compare-<timestamp>.json`. Repeat runs because sampling and extraction vary; the keyword checks are narrow and should be read next to the actual answers.

## Grounded identity

Names are validated before anything is written: placeholders (`?`, `unknown`), the owner, pronouns,
forms of address (`Mom`, `doctor`) and relation phrases (`daughter of S1`) are rejected. Relations
are normalised to a noun relative to the owner (`neighbour`, `son`, `granddaughter`), and titles
are canonicalised (`Doctor Patel` → `Dr. Patel`).

A voiceprint is enrolled only when the name is evidenced: a self-introduction from that speaker
("it's Maya from next door", "I'm Doctor Patel", "Hey Mom, it's Sam") or the speaker saying the
name. A hallucinated name can therefore not poison voice identity. Facts may involve several people
(`fact_people`), so "Sam is coming with Lily" is found from either person's partition. Facts are
third person, duplicate facts are skipped, and a changed number supersedes the older fact.

## Multilingual conversation memory

Memory accepts optional `language` (BCP 47 tag such as `fr`) and `translation` text on an utterance event. The original `text` and audio offsets remain the evidence; translation is indexed for English recall and shown alongside the original to Bonsai. Dock can extract `directions` and `travel` facts, and answers carry both original and translated text in their clips. These optional fields are an internal receiver capability until the capture team agrees on the shared contract.

## Local service

`npm run server` keeps memory loaded on `127.0.0.1:8787` (`KINDRED_PORT` overrides the port). POST JSON to `/ingest` with `{"file":"/path/to/session.jsonl"}` or `{"events":[...]}`, `/dock` with `{}`, `/ask` with `{"question":"..."}` (optional `"mode"`), and `/identify` with `{"speaker":"S1","voiceprint":[...]}`. `/identify` reads the docked card without waiting for a Bonsai generation call, keeping live recognition responsive. This service does not change the capture contract.

### Memory workspace

Start the local Bonsai 4B server, then `cd memory && npm run server` (captured data) or `npm run lab`
(isolated `data/input-lab.sqlite`) and open `http://127.0.0.1:8787/`. The page has three views:

- **Chat** — ask in your own words; every answer lists its sources as cards (Inputs `N`, Ledger
  facts `F`, person cards `P`, conversation clips, photos) and a collapsible *How Bonsai searched*
  panel built from the real `/ask` trace.
- **Ledger** — search and filter `/memories`, see the original quote, *Added by you* versus
  *Inferred*, and a use count that only increments when the fact shaped an answer. Correct, forget
  and reminder actions are two-phase: the server returns the consequence first, and nothing changes
  until you confirm.
- **People** — `/people`: relation, core card, fact count, whether a voiceprint is enrolled.

Typed **Inputs** are exact text with `N` ids; they are never silently converted into Ledger facts and
they expose no Ledger action controls. Photos can be added with the page's file picker
(`POST /upload-photo`); the stored original is served back through `GET /photo/:id` for thumbnails
and source cards. All requests stay on this Mac. To clear an isolated lab, stop the server and remove
the gitignored `data/input-lab.sqlite` file and its sidecars.

| Endpoint | Returns |
|---|---|
| `GET /health` | active retrieval mode, embedding capability, model |
| `GET /people` | people, relations, fact counts, voice samples |
| `GET /memories` | memory records for the Ledger: `q`, `person`, `status`, `limit`; each with source quote, origin (user/extracted), uses, last used |
| `POST /memory` | explicit save: `{"text":"…","person":"Me","kind":"preference"}` (origin `user`) |
| `GET /traces?limit=20` | stored recall traces: plan, pages loaded, evictions, citations |
| `GET /actions` | pending (unconfirmed) actions |
| `POST /ingest-photo` | `{"file":"/local/path.jpg","note":"...","takenAt":"...","people":["Maya"]}` |
| `POST /upload-photo` | raw browser upload (`Content-Type: image/*`, ≤12 MB, magic-byte sniffed, SHA-256 deduped) |
| `GET /photo/:id` | the stored image bytes (only paths inside `data/`) |
| `POST /ask-photo` | `{"id":"ph_...","question":"What does the sign say?"}` reopens the stored image with Bonsai vision |
| `POST /action` | `{"kind":"set_reminder",...}` proposes; `{"id":7,"confirm":true}` applies |

## Photo memory

A local image is copied into `data/photos/` (SHA-256 dedupe), Bonsai vision extracts a caption and
up to eight observations, empty or low-confidence observations are dropped, and the text is indexed
with Bonsai embeddings and FTS5. `ask` can cite a photo observation (`O12`) and the result carries
the original photo in `photos[]` as evidence. `docs/PHOTO_HANDOFF.md` holds the proposed image event
for the capture side; `docs/CONTRACT.md` is unchanged. For a question explicitly about the only
stored photo, `ask` reinspects the original image so details omitted from the first-pass observations
can still be answered. With multiple photos, use `/ask-photo` with an id when retrieval cannot
identify which image the user means.

## Local actions

`kindred memories [query]` lists records for the Ledger and `kindred remember <text>` saves one
explicitly. `docs/UI_BACKEND_CONTRACT.md` is the adapter contract for the UI (real shapes, and the
gaps it must not fake: no token streaming, no approval queue, no scope enforcement).

Bonsai can call `search_memory`, `open_episode`, `answer_memory`, `play_original_clip`,
`set_reminder`, `correct_memory` and `forget_memory`. Only `play_original_clip` is read-only. The
three state-changing actions are two-phase: recall returns a proposal and a spoken confirmation
question and writes nothing; the change is applied only through
`POST /action {"id":...,"confirm":true}`. The current `forget_memory` action retracts extracted
facts and clears the person's core card. **It is not full deletion:** original utterances, episode
summaries and audio remain available and may still be found. Its confirmation text states this.
Full conversation/person deletion across L0–L3 and audio remains planned. Corrections supersede
the old fact and re-index. A user correction does not inherit the old fact's audio citation, since
that recording may contradict the corrected text.

The primary [Zhang et al. LightMem paper](https://arxiv.org/abs/2604.07798) uses user-specific mid-term episodes and de-identified, user-agnostic long-term knowledge. Kindred adapts the retrieval design to private, person-specific facts; its `facts` table is **not** the paper's de-identified LTM. [Fang et al. LightMem](https://arxiv.org/abs/2510.18866) motivates filtering, topic segments, and dock-time updates; [MemGPT](https://arxiv.org/abs/2310.08560) motivates bounded working memory and paging.
