# memory/ — Bonsai side (owner: Farhan)

Layered people memory with Bonsai-managed paging. Design is described in the root README §3.

| File | Role |
|---|---|
| `src/db.mjs` | SQLite schema for L0–L3 + people graph (FTS5 indexes) |
| `src/ingest.mjs` | contract JSONL → L0 (idempotent) |
| `src/identity.mjs` | voiceprint cosine matching, voice centroids, owner enrolment |
| `src/dock.mjs` | stage 1 filter/segment → stage 2 Bonsai extraction (grounded) → sleep-time core memory |
| `src/retrieve.mjs` | two-stage retrieval (BM25 → rerank by relevance/recency/person) |
| `src/recall.mjs` | MemGPT-style ask loop with working-memory budget, eviction, verified citations |
| `src/whisper.mjs` | live "who is this?" line (template fallback if Bonsai is slow) |
| `src/bonsai.mjs` | llama.cpp client, JSON-schema constrained, call trace |
| `test/` | end-to-end tests with a scripted model (plumbing only, not accuracy) |

Task list: see "Farhan" in the root README §5.
