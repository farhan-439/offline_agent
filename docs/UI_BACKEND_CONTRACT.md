# UI backend contract: what the app can actually show

For the UI/design agent. **Read this with the design brief.** The brief is a product spec; this file
is the truth about the local backend it will talk to. Where the two disagree, this file wins, and
the UI must not invent the difference.

Run it:

```sh
memory/scripts/start-bonsai.sh                       # 4B on :8080 (chat + vision + embeddings)
cd memory && KINDRED_DB=../data/demo.sqlite npm run server   # memory API on :8787
```

Text input is enough to exercise everything below; no microphone or Argmax is needed. The demo
database already contains a docked "day" (Maya, Dr. Patel, Sam, Lily, Priya).

## The one thing the brief gets exactly right, and the one thing it cannot have yet

The Recall Strip is fully backed: every answer returns the exact memories it used, and each memory
card can show the original sentence, the recording it came from, how often it has shaped an answer,
and whether you or the model created it.

**Progressive “recalling… → searching 128 memories… → 3 recalled” is not backed.** `POST /ask` is a
single JSON response returned after the whole pipeline finishes (3–18 s). There is no token stream
and no event stream. The honest implementation: show `◈ recalling…` while the request is in flight,
then reveal the real chips when it returns. Do **not** animate invented counts or a fake search
counter.

## Endpoints (verified against the running server)

### `GET /health`

```json
{"ok":true,"model":"bonsai-4b","retrievalMode":"hybrid-rerank","requestedMode":"auto",
 "degraded":false,"embeddings":{"embeddings":true,"dim":2560,"reason":null},
 "detail":"hybrid-rerank [requested: auto; bonsai embeddings, 2560-dim]"}
```

Use for the “Local status” panel: model name, retrieval mode, embedding status. Do not claim RAM
figures, index size in MB, or “last built” — those are not exposed.

### `POST /ask` → the answer, its evidence, its trace

```json
{"answer":"The doctor increased your lisinopril dosage from five to ten milligrams once every morning.",
 "cites":["F5","P:p_dr_patel"],
 "clips":[{"id":"d1-clinic#0002","speaker":"Dr. Patel","text":"…five to ten milligrams…",
           "audio":"data/audio/d1-clinic.wav","start":3.8,"end":10.2,"started_at":"2026-11-10T14:30:00Z"}],
 "photos":[], "grounded":true, "mode":"hybrid-rerank",
 "trace":[{"step":0,"action":"mode"},{"action":"plan_query","queries":[…],"candidates":[…]},
          {"action":"rerank","selected":[…]} ,{"action":"answer","cite":[…]}]}
```

- `cites` are memory refs: `F12` = a fact (look it up in `/memories`), `P:p_maya` = a person's core
  card (link to the person), `E3` = a conversation episode, `O4` = a photo observation.
- `clips` are the original utterances behind the answer, with audio path + offsets. **The fixture
  audio files do not exist yet**, so “play” must degrade gracefully until recordings are dropped in
  `data/audio/`.
- `grounded:false` means no evidence was found. Show that state honestly; never present an
  ungrounded answer as sourced.
- `trace` is real (plan, candidates, rerank selection, steps). Good for a “why this answer” popover.

### `GET /memories?q=&person=&status=&limit=` → the Ledger

```json
{"memories":[{"ref":"F8","text":"The owner bumped up his blood pressure pill.","kind":"health",
 "status":"active","origin":"extracted","scope":"all","when":null,"whenText":null,
 "createdAt":"2026-11-11T18:05:00Z","uses":0,"lastUsed":null,
 "person":{"id":"p_sam","name":"Sam","relation":null},
 "source":{"session":"d2-call","utterances":["d2-call#0002"],
   "quote":{"utteranceId":"d2-call#0002","text":"Fine, he bumped up my blood pressure pill.",
            "session":"d2-call","start":3.3,"end":6.1,"audio":"data/audio/d2-call.wav"}}}]}
```

- `origin: "user"` = explicitly saved; `"extracted"` = inferred by the model. The brief's
  “You vs Inferred” distinction maps **exactly** to this field. Render them differently.
- `scope` currently exists only as a stored string with default `"all"`. There is **no** project or
  time scoping in retrieval yet, so do not offer “This project / Today only” as if it worked.
- `uses` / `lastUsed` are truthful: incremented only when that fact was cited in an answer.
- `source.quote` is the original words. For user memories it is `null` → show “Added by you”.
- `status`: `active`, `superseded`, `retracted`. `?status=any` lists retired ones.
- Filtering: `q` is full-text, `person` accepts a name or id. Category chips (Preferences, People,
  Projects, Files) are **client-side** filtering over `kind` + `person`; `kind` values are
  `plan`, `promise_by_owner`, `promise_by_them`, `health`, `medication`, `preference`, `family`,
  `personal`, `directions`, `travel`, `other`.
- No pagination cursor; `limit` up to 500, sorted by uses then recency.

### `POST /memory` → the ＋ Remember save

```json
{"text":"Prefers short answers with no preamble.","person":"Me","kind":"preference"}
```

Returns the created memory with `origin:"user"` and `source.quote:null`. Use it for the
“＋ Remember” action, the Ledger's “+ Add”, and a typed `Remember this: …` prefix (detect the
prefix client-side and call this endpoint — the model does **not** auto-save anything).

### `POST /action` → forget, correct, remind (two-phase)

```json
{"kind":"forget_memory","ref":"F8"}                     → {"status":"needs_confirmation","id":7,"summary":"…"}
{"id":7,"confirm":true}                                  → {"status":"applied","forgotten":1}
{"kind":"correct_memory","ref":"F8","text":"…"}          → propose, then confirm as above
{"kind":"set_reminder","text":"take the new pill","due":"tomorrow"}   → propose, then confirm
{"kind":"play_original_clip","ref":"F8"}                 → read-only, returns clips immediately
```

Nothing changes until the confirm call. The confirm dialog must repeat the consequence, and the
copy “Forget” is correct: the chat history is untouched, the fact stops shaping answers.
There is **no** “forget everything” endpoint and **no** export endpoint — both would need adding.

### `GET /people`

```json
{"people":[{"id":"p_maya","name":"Maya","relation":"neighbour","core":"Maya, neighbour. …",
            "is_owner":0,"last_seen":"…","facts":1,"voice_samples":1}],
 "relations":[{"a":"p_me","b":"p_maya","label":"neighbour"}]}
```

`core` is the person's always-visible card — the right content for a people view and for
“what do you know about Maya?”.

### `GET /traces?limit=20` → real recall traces

`{traces:[{id,question,answer,mode,grounded,trace,created_at}]}`. Use for a “memory work” view.

### `POST /ingest-photo` → photo memory

`{"file":"/abs/path.jpg","note":"…","people":["Maya"]}` → `{photo, observations, caption, mode}`.
`/ask` returns cited photos in `photos[]` (`{id,path,mime,taken_at,caption}`).

### `POST /upload-photo` → browser upload (raw bytes)

The page cannot supply a local path, so it posts the file itself: `POST /upload-photo?note=…&people=Maya,Priya`
with `Content-Type: image/png|image/jpeg|image/webp|image/gif` and the raw bytes as the body
(max 12 MB, configurable with `KINDRED_MAX_UPLOAD_BYTES`). The server sniffs the bytes rather than
trusting the header, rejects anything that is not PNG/JPEG/WebP/GIF with 415 and oversize bodies
with 413, writes a temporary file under `data/uploads/`, then runs the same pipeline as
`/ingest-photo` (SHA-256 dedupe, Bonsai vision, FTS + vectors) and deletes the temporary file.

### `GET /photo/:id` → the stored image

Serves the original bytes with its stored MIME type (404 if the row or file is gone). Only paths
inside `data/` are served. This is what the thread thumbnail and the source cards use.

## Gaps between the brief and the backend

| Brief element | Status |
|---|---|
| Recall Strip with real chips + popovers | **Backed** (`cites`, `/memories`) |
| Answer in flight → “recalling…” | Allowed as an honest spinner; no progressive events |
| Memory card: statement, source quote, used N×, origin, scope | **Backed** |
| Forget / correct with confirmation | **Backed** (`/action`, two-phase) |
| ＋ Remember / Ledger + Add | **Backed** (`POST /memory`) |
| “You vs Inferred” authority | **Backed** (`origin`) |
| Needs-review queue before saving inferred facts | **Not backed** — inferred facts are stored immediately. Either present them with a review affordance (forget/correct) or the backend needs an approval gate |
| Scope chips that change retrieval | **Not backed** — stored only |
| Expiry / “expires in 12 days” | **Not backed** |
| Conversation list, auto-titles, pinning | **Not backed** — the backend stores no chat messages; the UI owns history |
| Token streaming, stop button that keeps partial text | **Not backed** — `ask` is one response. A stop button can cancel the request, but partial text does not exist |
| File attachments / @ references / file-grounded answers | **Not backed** (photos only) |
| Photo picker, upload from the page, cited images as thumbnails | **Backed** (`/upload-photo`, `GET /photo/:id`) |
| Model picker with Fast/Balanced/Thorough | **Not backed** — one model; show `bonsai-4b` |
| Export .json / Forget everything | **Not backed** — could be client-side export of `/memories` + `/people`; forget-all needs an endpoint |
| Offline, no network claims | **Backed** — all calls are `127.0.0.1` |

## Rules for the UI agent

1. Never display a number the API did not return (memory counts, “searching N memories”, MB sizes).
2. Never claim a capability in the gaps table, including web search or file grounding.
3. Every saved memory must be announced in the thread; the API records `origin:"user"` so the line
   can be permanent and editable.
4. If `grounded:false`, say so plainly and offer Retry — do not style an unsourced answer like a
   sourced one.
5. Keep the assistant's identity minimal: the only “AI” mark is the margin tick; no avatar.

## Suggested backend additions, in order (for whoever owns memory/)

1. Server-sent events or polling for `/ask` progress (makes the strip honest, not decorative).
2. Approval queue for `origin:"extracted"` facts (the brief's “default to asking”).
3. Scope enforcement + expiry (`scope`, `expires_at`) in retrieval.
4. Export + forget-everything endpoints.
5. Image serving (`GET /photo/:id`) for a browser-only build.
