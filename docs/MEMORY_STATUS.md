# Kindred memory: current status and build plan

Updated 2026-11-14. This is the status for Farhan's `memory/` side. The teammate owns `capture/` and Argmax; coordinate any change to `docs/CONTRACT.md` with them. The desktop handover gives the full hackathon background and paper notes.

## Product and model boundary

Kindred is an all-purpose, local memory assistant with an initial focus on older adults. It should remember conversations, doctor and family calls, appointments, promises, directions, and later photos. Argmax handles captured speech, speaker identity, and spoken output. Bonsai handles extraction, memory selection, retrieval decisions, and grounded answers. The product must run with Wi-Fi off; Bonsai is the only text-generating model. Bionic cloud models can assist development, but are not part of the submitted app or its offline runtime. Never commit API keys.

The active local server serves **Bonsai 2 4B** (`bonsai-4b`, 8,192-token configured context). Its GGUF has vision and tool-call capabilities, but photo ingestion is not yet wired into Kindred. We explored 9B on CPU: a tiny direct answer worked, but it was slower and a 208-document embedding probe was stopped at the user's request because the Mac fan became loud. Do not restart a 9B workload without explicit user authorization. The 4B model remains the working choice; the 9B comparison is incomplete.

## Implemented in `memory/`

- SQLite raw utterances, episodes, grounded facts, people and voice centroids, core cards, FTS5 indexes, and incremental Bonsai vector storage.
- Dock filtering/segmentation, Bonsai fact extraction, source-checked evidence, and source-assembled core cards selected by Bonsai. Core cards outside the always-visible roster can be retrieved.
- Hybrid BM25 + Bonsai embedding retrieval, Bonsai query planning and semantic selection, and bounded MemGPT-style paging. Working-memory budget defaults to 2,400 characters (`KINDRED_WORKING_CHARS`, maximum 20,000); retrieval loads up to six pages and the loop allows up to four steps.
- Bonsai native actions currently wired to memory: `search_memory`, `open_episode`, and `answer_memory`. Answers verify citations against loaded pages and return original utterance/audio references. Relative dates are resolved from recording dates.
- Optional `language` and `translation` on received utterances. The original text/audio stays as evidence; translation is indexed and shown to Bonsai. This receiver extension has not been added to the shared capture contract.
- Local HTTP server: `npm run server` in `memory/`, with `/health`, `/ingest`, `/dock`, `/ask`, and `/identify`. `npm test` last passed 17/17 scripted-model tests. Those tests verify plumbing, not real Bonsai accuracy.

## Measured and unmeasured

- On the 8-memory, 10-paraphrase probe, keyword matching ranked the right memory first 3/10 (MRR 0.48); Bonsai 4B embeddings ranked it first 8/10 (MRR 0.83). With 200 unrelated synthetic decoys added, 4B stayed at 8/10 (MRR 0.821), but one medication question's target fell to rank 194. This is a small probe, not product accuracy.
- A 9B small embedding probe ranked first 5/10 (MRR 0.696); its larger probe was interrupted. These numbers do not justify replacing 4B.
- A sampled 4B keyword-only answer evaluation over 10 fixture questions passed 6/10 strict answer keyword checks and found expected evidence ids for 8/10. Sampled results vary; this is not a hybrid result.
- A 10,000-fact structural stress test used synthetic vectors. It tested indexing and retrieval plumbing, not Bonsai semantic accuracy. A paraphrased garden question failed against the current keyword-only server.
- The running server at port 8080 has **not** enabled `/v1/embeddings` (currently returns 501). Restart the single Bonsai server with `--embeddings --pooling mean` before measuring full real-model hybrid recall. Chat and embeddings worked together in a separate probe. Do not claim a full hybrid evaluation until it is run.

## Next build order on Farhan's side

1. Start the single 4B server with embedding flags, run the fixture demo and full evaluation, and record BM25-only versus hybrid versus hybrid plus Bonsai selection. Keep BM25 alongside vectors for exact names, numbers, and medication terms. No separate embedding model is planned.
2. Improve real 4B extraction and multi-part answer reliability using failures observed in the fixture runs. Re-run the same evaluation after changes. Keep source citations strict.
3. Build **photo memory** in `memory/`: accept a local image reference, use Bonsai vision to extract compact searchable observations, keep the image as original evidence, index its text with Bonsai embeddings and FTS, then answer later questions with a photo reference. Settle the eventual image handoff in the shared contract with the Argmax teammate before changing `capture/`.
4. Consider Bonsai-directed local actions after retrieval is solid: `set_reminder`, `play_original_clip`, and `correct_memory`/`forget_memory`, with clear user confirmation for consequential changes. These actions are ideas, not current tools.
5. Build a trace/people view that shows Bonsai's retrieval decisions, loaded/evicted pages, evidence, and latency. Integrate with the teammate's capture and TTS flow and run the complete demo with Wi-Fi off.

The Argmax teammate owns voiceprints, capture, translation and TTS. Memory can already receive translated utterances, but does not implement live translation, microphone capture, speech synthesis, or the UI. The photo flow is likewise planned, not yet implemented.
