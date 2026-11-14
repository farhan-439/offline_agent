# Kindred memory: current status and build plan

Updated 2026-11-14 on branch `bionic/bonsai-memory`. This is the status for Farhan's `memory/`
side. The teammate owns `capture/` and Argmax; `docs/CONTRACT.md` is unchanged. The desktop
handover gives the hackathon background and paper notes; `docs/PHOTO_HANDOFF.md` holds the
proposed image event for capture.

## Product and model boundary

Kindred is an all-purpose, local memory assistant with an initial focus on older adults. Argmax
handles captured speech, speaker identity and spoken output. Bonsai handles extraction, memory
selection, retrieval decisions and grounded answers. The product must run with Wi-Fi off; Bonsai is
the only text-generating model and also produces every embedding. Bionic cloud models are for
development only and are not part of the submitted app.

One process serves everything: `memory/scripts/start-bonsai.sh` starts Bonsai 2 **4B** with
`--embeddings --pooling mean`, the vision projector and tools enabled. On this machine that is
~2.1 GB RSS and 2,560-dim vectors. **No 9B workload was run**; the earlier 9B exploration stays
closed unless Farhan asks for it.

## Implemented in `memory/`

- **Capability probe and three retrieval modes.** `POST /v1/embeddings` is probed once and cached.
  Modes are `hybrid-rerank` (default), `hybrid` and `bm25`, overridable with
  `KINDRED_RETRIEVAL`. A 501 from the server now degrades dock and ask to BM25 instead of throwing;
  `/health` reports `retrievalMode`, `embeddings` and `degraded`. `KINDRED_EMBED=0` forces BM25.
- **Grounded identity.** Names are validated before anything is written: placeholders (`?`,
  `unknown`), the owner, pronouns, forms of address (`Mom`, `doctor`) and phrases (`daughter of S1`)
  are rejected; titles canonicalise (`Doctor Patel` → `Dr. Patel`); relations normalise to a noun
  relative to the owner. A per-session deterministic pre-pass finds self-introductions and binds
  that cluster's voiceprint before Bonsai runs; Bonsai's names are accepted only when the speaker
  or the session actually says them. A relation guessed from a rejected name ("Mom" → mother) is
  discarded. One wrong guess can no longer poison a voice centroid.
- **Multi-person facts.** `fact_people(fact, person, role)`; person-scoped search unions primary and
  linked people, so "Sam is coming with Lily" is found from Lily's partition.
- **Dedupe and supersede.** Deterministic token overlap skips repeated facts; a near-identical fact
  that changes a number or an ordinal supersedes the older one. Numbers and ordinals are compared
  separately, so "5 mg" vs "10 mg" and "December third" vs "December tenth" are contradictions,
  while an added clause is not.
- **Dates.** Weekday/this/next, today/tomorrow/yesterday, month-day, day-month, ISO, `11/15` and
  `the 3rd` all resolve against the recording date.
- **Compound questions.** Queries are planned per clause; retrieval keeps the best two pages per
  subquestion across both modalities (BM25 and Bonsai vectors) and re-adds anything the 4B reranker
  dropped.
- **Core cards.** Assembled from selected source facts only, ≤50 words. Cards are now citeable
  pages (`P:<person>`), so an answer that comes from a card still carries utterance evidence. The
  owner's card is rendered in the second person ("the owner's" → "your").
- **Photo memory.** Local image → `data/photos/` with SHA-256 dedupe → Bonsai vision caption +
  observations (empty or <0.3 confidence dropped) → FTS5 + Bonsai embeddings → answers cite `O<n>`
  and return the original photo. Endpoint: `POST /ingest-photo`.
- **Local actions.** `play_original_clip` is read-only; `set_reminder`, `correct_memory` and
  `forget_memory` are two-phase. Recall returns a proposal and a confirmation question and writes
  nothing; `POST /action {"id":…,"confirm":true}` applies it. Forgetting retracts facts and clears
  the core card; corrections supersede and re-index. Pending proposals are listed on `GET /actions`.
- **Demo-view data.** `GET /people` returns people, relations, fact counts and voice samples;
  `GET /traces` returns stored recall traces (mode, plan, pages loaded, evictions, citations).
- **Language receiver.** `language`/`translation` on utterances stay supported and indexed; the
  original text/audio remains the evidence. Still an internal receiver extension, not in the shared
  contract.
- **Tests.** `npm test` is 30/30 scripted-model tests: plumbing and policy, not Bonsai accuracy.

## Measured with the real Bonsai 4B

Protocol: the 10 fixture questions in `memory/eval/run.mjs`, **3 repetitions per mode**, a fresh
in-memory database per run so docking and extraction variance are included. A refusal never counts
as a correct answer even if it contains the expected keywords; "evidence" means the cited clips
include every expected utterance id.

The final table is generated from `memory/eval/results/compare-<timestamp>.json` with
`npm run summarize` after the 3×3 matrix finishes; fill it in here. Interim from the run in
progress: bm25 29/30 answer, 23/30 evidence (~3.0 s median); hybrid 18/20 answer, 16/20 evidence
(~6.2 s median); hybrid-rerank pending. An earlier pre-fix matrix scored bm25 30/30 & 20/30,
hybrid 28/30 & 25/30, hybrid-rerank 28/30 & 23/30 — superseded, do not quote as final.

```
mode            answer  evidence  both   refusals  median ms
(replace with `npm run summarize` output)
```

How to read it: the keyword answer check is lenient (a fluent sentence often contains the words),
so **evidence accuracy is the honest signal**. Dock takes ~40 s per run (3 sessions, 3 extraction
calls, 6 core-card calls, 20 embeddings) and dominates the total.

## Known limitations and open failures

- The compound Sam/Lily question is the hardest case. Answers now usually include both halves, but
  the 4B reranker sometimes keeps the clinic's potassium advice instead of the peanut allergy, so
  that run fails the evidence check.
- Extraction still varies between runs: relations are occasionally wrong (Lily labelled "friend"),
  and a fact can be attached to the owner when the speaker was ambiguous.
- Paraphrased retrieval ("did anyone need help with their garden?") occasionally still misses,
  usually with a slow multi-step path.
- Keyword answer scoring flatters every mode; only the evidence column should be quoted as accuracy.
- The 8-memory embedding probe (keyword 3/10 vs Bonsai 8/10) remains a probe, not app accuracy.

## Next

1. Wire the people graph and recall trace into the UI (data endpoints exist; rendering does not).
2. Argmax side: real voiceprints in `speaker.voiceprint` — live identity is blocked on `null`
   voiceprints from capture, not on memory.
3. Agree the photo event in `docs/PHOTO_HANDOFF.md` with the teammate, then ingest from capture.
4. Run the whole demo with Wi-Fi off, including the Argmax Pro licence check, and record the video.
