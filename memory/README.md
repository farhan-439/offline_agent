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
| `test/` | end-to-end tests with a scripted model (plumbing only, not accuracy) |

Task list: see "Farhan" in the root README §5.

## Bonsai memory retrieval

Start the **single** Bonsai 4B server with `--embeddings --pooling mean` added to the normal launcher flags. Both `/v1/embeddings` and `/v1/chat/completions` then use the same local model. `BONSAI_URL` defaults to `http://127.0.0.1:8080/v1`; `KINDRED_EMBED_URL` can override the embedding endpoint's `/v1` base URL.

At dock, Bonsai embeds facts, episode summaries, and core cards. The vectors are stored as float32 BLOBs with a content hash, so another `dock` indexes only changed memories. At ask, Bonsai plans up to three searches; each search combines BM25 and Bonsai vector results into a fixed shortlist. Bonsai selects up to six pages, then uses native tool calls to search, open an episode, or answer with citations. Exact-term BM25 remains useful for names and doses; there is no second embedding model.

The currently running server must be restarted with the embedding flags before a real-model `dock` can index vectors. `npm test` uses a scripted model and does not measure Bonsai's retrieval accuracy.

`npm run eval` runs ten fixture questions against real Bonsai and reports answer keywords, evidence ids and latency. `npm run eval -- --bm25` runs the keyword retrieval ablation with the same Bonsai generator. Repeat runs because sampling and extraction vary. The keyword checks are intentionally narrow and should be reviewed alongside the actual answers.

## Multilingual conversation memory

Memory accepts optional `language` (BCP 47 tag such as `fr`) and `translation` text on an utterance event. The original `text` and audio offsets remain the evidence; translation is indexed for English recall and shown alongside the original to Bonsai. Dock can extract `directions` and `travel` facts, and answers carry both original and translated text in their clips. These optional fields are an internal receiver capability until the capture team agrees on the shared contract.

## Local service

`npm run server` keeps memory loaded on `127.0.0.1:8787` (`KINDRED_PORT` overrides the port). POST JSON to `/ingest` with `{"file":"/path/to/session.jsonl"}` or `{"events":[...]}`, `/dock` with `{}`, `/ask` with `{"question":"..."}`, and `/identify` with `{"speaker":"S1","voiceprint":[...]}`. `/identify` reads the docked card without waiting for a Bonsai generation call, keeping live recognition responsive. `GET /health` checks the service. This service does not change the capture contract.

The primary [Zhang et al. LightMem paper](https://arxiv.org/abs/2604.07798) uses user-specific mid-term episodes and de-identified, user-agnostic long-term knowledge. Kindred adapts the retrieval design to private, person-specific facts; its `facts` table is **not** the paper's de-identified LTM. [Fang et al. LightMem](https://arxiv.org/abs/2510.18866) motivates filtering, topic segments, and dock-time updates; [MemGPT](https://arxiv.org/abs/2310.08560) motivates bounded working memory and paging.
