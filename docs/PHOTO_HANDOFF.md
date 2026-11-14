# Proposed image handoff: capture → memory

Status: **proposal only**. `docs/CONTRACT.md` has not been changed, and `capture/` has not been
touched. Memory already accepts photos through its own local endpoint, so this can be agreed
with the Argmax teammate without blocking either side.

## Why

Kindred is meant to remember ordinary life, and a phone or pendant camera produces photos the
same way the microphone produces speech. The memory side now supports:

- a local photo file added by the user,
- Bonsai vision extraction into short, searchable observations,
- Bonsai embeddings + FTS over those observations,
- answers that cite the original photo as evidence,
- duplicate detection by content hash, so re-adding the same image is a no-op.

## Option A (recommended): a `photo` event in the session stream

Capture already writes one JSONL file per recording. A photo taken during or after a session
can be one more line; memory ignores unknown types, so old readers keep working.

```jsonc
{"type":"photo","session":"2026-11-14T16-02-11",
 "id":"2026-11-14T16-02-11#photo1",   // stable, unique, used as evidence
 "path":"data/photos/2026-11-14T16-02-11-photo1.jpg",  // relative to repo root
 "mime":"image/jpeg",
 "takenAt":"2026-11-14T16:05:12Z",
 "place":"optional free text",
 "note":"optional user caption",
 "people":["Maya"]}                   // optional hint; memory validates names
```

Rules mirroring the existing contract:

- `id` is unique and stable; answers cite it and the UI replays the photo.
- `path` is a local file the device already wrote. Memory copies it into `data/photos/` and keeps
  a SHA-256, so evidence survives the original file moving.
- `people` is a hint only. Memory rejects anything that is not a validated person name
  (placeholders, forms of address, phrases).
- Photos are optional; a session without them behaves exactly as today.

## Option B: out-of-band upload

If capture would rather not touch the session file, it can POST to memory:

```
POST /ingest-photo  {"file":"/abs/or/repo/relative.jpg","note":"...","takenAt":"...","people":["Maya"]}
```

Both options call the same code path in `memory/src/photos.mjs`, so the choice is only about
where the event lives.

## What capture needs to do

1. Write the image to a local path (no network).
2. Emit the `photo` line **or** call `/ingest-photo` on the memory service.
3. Keep the image on disk for the demo; memory keeps its own copy under `data/photos/`.

## What memory does with it

1. Bonsai vision (the same 4B model, already loaded with its vision projector) produces a caption
   and up to eight observations, each with a confidence.
2. Observations below 0.3 confidence, or shorter than three characters, are dropped.
3. Observations are indexed with Bonsai embeddings and FTS5.
4. `ask` can cite an observation ref (`O12`), which resolves to the photo, so an answer about a
   photo always carries the photo as proof.

## Open questions for the teammate

- Does capture want to own the photo file naming, or should memory name the copy?
- Should a photo be attachable to a *person* (e.g. "this is Maya") in the UI, or inferred only
  from the conversation that was recording at the time?
- HEIC: capture may need to convert to JPEG, since the vision path expects a common image type.
