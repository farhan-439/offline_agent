# Pebble

**Multilingual memory beyond the context window.** Pebble records conversations locally, keeps the original words and audio as evidence, and retrieves relevant memories when you ask a question later. The desktop app also supports live translation and spoken replies. Its memory lives in SQLite rather than inside a model prompt, so past conversations remain searchable as they grow.

[Watch the demo](https://youtu.be/9JLYg51D-ck?si=EJcDHfljC6LmvoDw)

## How it works

```text
Microphone
  → Argmax WhisperKit transcription + SpeakerKit diarization/voiceprints
  → timestamped session JSONL (original speech, language, translation, audio offsets)
  → SQLite + FTS5 raw log
  → Bonsai 2 4B extraction → episodes, grounded facts, people, core cards
  → bounded recall with BM25 / optional embeddings and page selection
  → answer with checked citations → original utterance, audio clip or photo
```

The implementation has three parts:

| Directory | Responsibility |
| --- | --- |
| [`capture/`](capture/README.md) | Swift/Argmax capture, diarization, live speaker events, multilingual Whisper translation and TTS. |
| [`memory/`](docs/MEMORY_STATUS.md) | Node/SQLite ingestion, evidence-linked extraction, identity, retrieval, recall, photos and local actions. |
| [`app/`](app/README.md) | Electron hub and floating orb for recording, people, questions and live translation. |

[`docs/CONTRACT.md`](docs/CONTRACT.md) defines the JSONL handoff between capture and memory. The app talks to the memory service over localhost. Models and data stay on the device after model provisioning; the desktop UI uses local assets and blocks network access from its renderer.

## Memory beyond context

Pebble keeps four memory layers:

1. **Raw log:** utterances, speaker IDs, timestamps, audio offsets, original language and optional English translation, indexed in SQLite FTS5.
2. **Episodes:** topic-sized segments and summaries extracted from the raw log.
3. **Grounded facts and people:** structured facts link to the utterances that support them. A fact can belong to several people, and updated facts can supersede older ones.
4. **Core cards:** short per-person summaries assembled from source facts. The model sees these cards plus a bounded working context and can page in more evidence through search and episode tools.

Extraction rejects facts with invalid utterance citations. Answers may cite only pages loaded during recall; those pages resolve back to the underlying utterance, clip or photo. Names and voiceprints are bound only when the conversation supplies enough evidence, limiting false identity matches. Retrieval can run as `bm25`, `hybrid` or `hybrid-rerank`; if the local embedding endpoint is unavailable, it falls back to BM25 and reports that state through `/health`.

## Multilingual capture and replies

In translation mode, multilingual Whisper detects a language for each speech chunk, transcribes the original, and produces an English translation. Pebble displays and can speak the translation live. Both texts are saved with the original audio timing, so a later memory question can find the conversation without losing its source language.

For two-way replies, the app records the owner's English response, Bonsai translates it, and Argmax TTSKit speaks it in the other person's language. The currently exposed reply flow is limited to German, Chinese, Spanish and French. Capture mutes the reply window and a short echo tail so its own speech is not recorded as another person's memory.

Translation is a convenience layer, not a verified interpreter. The current tests use synthetic voices and a simulated microphone; short chunks, code-switching, accents, numbers, allergens and medication names can be wrong. See [`capture/README.md`](capture/README.md) for model choices, measured latency and the full limitations.

## Run locally

Requires macOS 15+, Apple Silicon, Swift 6.3+, Node 24+ and the locally provisioned Argmax and Bonsai models. Provisioning needs network access once; normal processing is designed to run locally afterward. Keep API keys in environment variables or the ignored `.env` file.

```sh
cd capture
npm run build
.build/release/kindred-capture provision
cd ..

cd app
npm install
cd ..

./kindred --check
./kindred
```

The repository's existing executable, package scripts and `KINDRED_*` environment variables retain their implementation names for now. The launcher checks models, starts Bonsai when needed, and opens the Electron app; the app supervises the memory service. For individual components and commands, see the linked directory READMEs.

## Verification and current limits

```sh
cd memory && npm test
cd ../capture && npm test
cd ../app && npm test
```

The memory suite checks plumbing and policy with scripted models; it does not measure language-model accuracy. A ten-question fixture evaluation with real Bonsai 4B is documented in [`docs/MEMORY_STATUS.md`](docs/MEMORY_STATUS.md). In that test, BM25 matched or exceeded the hybrid modes on strict evidence accuracy and was faster. Retrieval and extraction can still miss or misattribute facts, and voice matching needs calibration on real people. The current documentation separates implemented paths from planned integration work.

Recording people requires consent. Pebble shows a visible recording state and stores its working data locally; use it with the applicable privacy rules where you record.
