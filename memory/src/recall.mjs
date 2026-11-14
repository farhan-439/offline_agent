// Recall: a MemGPT-style controller. Bonsai sees only
//   · core memory (owner + roster of people with their one-line cards) — always in context
//   · a working context of memory pages it chose to load, under a hard character budget
// and decides each step whether to search again, open an episode, or answer with citations.
// Old pages are evicted (oldest first) when the budget is exceeded, MemGPT's queue manager.
import { search, hybridSearch, readEpisode, evidenceClips, evidencePhotos } from './retrieve.mjs';
import { resolveWhen } from './temporal.mjs';
import { resolveMode } from './capabilities.mjs';
import { proposeAction, evidenceForRef } from './actions.mjs';
import { now } from './db.mjs';

export const WORKING_BUDGET = Math.min(20_000, Math.max(1200, Number(process.env.KINDRED_WORKING_CHARS || 2400))); // raise with a larger server context
export const MAX_STEPS = 4;
export const RETRIEVAL_K = 6;

const PLAN_SCHEMA = { type: 'object', additionalProperties: false, required: ['queries', 'person'], properties: {
  queries: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
  person: { type: ['string', 'null'] },
} };
const SELECT_SCHEMA = { type: 'object', additionalProperties: false, required: ['refs'], properties: {
  refs: { type: 'array', maxItems: RETRIEVAL_K, items: { type: 'string' } },
} };

async function selectMemories(db, bonsai, question, trace) {
  const plan = await bonsai.json({ name: 'plan_query', schema: PLAN_SCHEMA, maxTokens: 160, temperature: 0.1,
    system: `Plan memory retrieval. Split compound questions into standalone searches. Preserve names and time cues.
Do not assume that an unnamed part concerns the person named in another part. For a question like "When is Sam coming and what should I not cook?", search both "Sam visit time" and "food allergies dietary restrictions guests"; set person to null because the food restriction may concern someone else.
Set person only when every subquestion explicitly concerns that same person. Return queries and person only.`,
    user: question });
  const queries = [...new Set((plan.queries ?? []).map((q) => q.trim()).filter(Boolean))].slice(0, 3);
  if (!queries.length) queries.push(question);
  const pool = new Map();
  const bestByQuery = [];
  for (const q of queries) {
    const pages = await hybridSearch(db, bonsai, q, { person: plan.person, k: RETRIEVAL_K });
    // keep the best of each modality per subquestion: a 4B reranker can drop a page that is
    // only lexically (or only semantically) similar, e.g. "allergic to peanuts" for "what not to cook".
    const lexical = search(db, q, { person: plan.person, limit: 2 });
    const coverage = [...new Set([...pages.slice(0, 2).map((p) => p.ref), ...lexical.map((p) => p.ref)])];
    if (coverage.length) bestByQuery.push(coverage);
    for (const page of pages) {
      const old = pool.get(page.ref);
      if (!old || page.fusion > old.fusion) pool.set(page.ref, page);
    }
    for (const page of lexical) {
      const old = pool.get(page.ref);
      if (!old) pool.set(page.ref, { ...page, fusion: 0.01, sources: ['bm25'] });
    }
  }
  const candidates = [...pool.values()].sort((a, b) => b.fusion - a.fusion).slice(0, 2 * RETRIEVAL_K);
  trace.push({ step: 0, action: 'plan_query', queries, person: plan.person, candidates: candidates.map((p) => p.ref) });
  if (!candidates.length) return [];
  const choice = await bonsai.json({ name: 'rerank', schema: SELECT_SCHEMA, maxTokens: 130, temperature: 0.1,
    system: `Select up to ${RETRIEVAL_K} memory refs that provide evidence for every part of the question. Include evidence for each subquestion even when it concerns a different person, and include allergy, dietary and health facts when a subquestion is about guests, food or cooking. Prefer direct evidence over broad summaries. Never invent refs. Return refs only; do not answer.`,
    user: `Question: ${question}\nSubquestions: ${queries.join(' | ')}\nCandidates:\n${candidates.map((p) => `[${p.ref}] ${p.text}`).join('\n')}` });
  const selected = [...new Set(choice.refs ?? [])].filter((ref) => pool.has(ref)).slice(0, RETRIEVAL_K);
  // coverage guard: a compound question must keep at least one hit per subquestion,
  // even if the 4B reranker dropped one part ("Sam is coming" but not "no peanuts").
  if (queries.length > 1) for (const refs of bestByQuery) {
    for (const ref of refs) {
      if (selected.length >= RETRIEVAL_K) break;
      if (!selected.includes(ref) && pool.has(ref)) selected.push(ref);
    }
  }
  trace.push({ step: 0, action: 'rerank', selected });
  return (selected.length ? selected : candidates.slice(0, RETRIEVAL_K).map((p) => p.ref)).map((ref) => pool.get(ref));
}

const STEP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['action', 'query', 'person', 'episode', 'answer', 'cite'],
  properties: {
    action: { type: 'string', enum: ['search', 'open_episode', 'answer'] },
    query: { type: ['string', 'null'] },
    person: { type: ['string', 'null'] },
    episode: { type: ['string', 'null'] },
    answer: { type: ['string', 'null'] },
    cite: { type: 'array', maxItems: 4, items: { type: 'string' } },
  },
};

const SYSTEM = `You are Kindred, a private offline memory for the owner. You answer questions about the people in their life using ONLY memory pages.
Each step, return exactly one action as JSON:
- {"action":"search","query":"keywords","person":"name or null",...} to load more memory from disk.
- {"action":"open_episode","episode":"E7",...} to read the exact words of a conversation.
- {"action":"answer","answer":"...","cite":["F3","E7"],...} when the pages are enough.
Rules: answer in one or two short spoken sentences, mention who said it and when. Answer every part of a compound question; if one part is missing from the pages, search for it before answering. Answer in the question's language when possible. A translation is for understanding; the cited original utterance is the proof. Cite page refs you used. If memory does not contain the answer, say you don't remember that, and do not guess. Unused fields are null or [].`;

/**
 * The always-visible roster is itself a set of citeable pages (P:<person id>).
 * Without a ref, a 4B model answers correctly from a card but cannot cite it, so evidence
 * checks fail even though the model read the right memory.
 */
export function coreMemoryPages(db) {
  const people = db.prepare('SELECT id, name, relation, core, is_owner, last_seen FROM people ORDER BY is_owner DESC, last_seen DESC NULLS LAST LIMIT 12').all();
  return people.map((p) => {
    const facts = db.prepare("SELECT evidence FROM facts WHERE person_id = ? AND status = 'active' ORDER BY observed_at DESC LIMIT 4").all(p.id);
    return {
      ref: `P:${p.id}`, layer: 'core', personId: p.id, when: p.last_seen,
      text: `${p.name}${p.relation ? ` (${p.relation})` : ''}${p.core ? `: ${p.core}` : ''}`,
      evidence: [...new Set(facts.flatMap((f) => { try { return JSON.parse(f.evidence); } catch { return []; } }))].slice(0, 6),
    };
  });
}

export function coreMemory(db) {
  const pages = coreMemoryPages(db);
  return pages.map((p) => `- [${p.ref}] ${p.text}`).join('\n') || '(no people yet)';
}

function renderPages(pages) {
  return pages.map((p) => p.lines
    ? `[${p.ref}] conversation ${p.when?.slice(0, 10) ?? ''}${p.place ? ` at ${p.place}` : ''}:\n${p.lines.map((l) => `  ${l.who}: ${l.text}${l.translation ? ` [translation: ${l.translation}]` : ''}`).join('\n')}`
    : `[${p.ref}] (${p.when?.slice(0, 10) ?? '?'}) ${p.text}`).join('\n');
}

function temporalGrounded(answer, clips) {
  const claims = [...answer.matchAll(/\b(?:(?:this|next)\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth)\b|\b(?:today|tomorrow)\b|\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/gi)].map((m) => m[0]);
  return claims.every((claim) => clips.some((clip) => {
    const claimed = resolveWhen(claim, clip.started_at);
    const spoken = resolveWhen(clip.translation || clip.text, clip.started_at);
    return claimed && spoken && claimed === spoken;
  }));
}

export async function ask(db, bonsai, question, { today = new Date().toISOString().slice(0, 10), onStep = () => {}, mode: forcedMode = null, persistTrace = true } = {}) {
  const resolved = await resolveMode(bonsai);
  const mode = forcedMode ?? resolved.mode;
  const pages = [];
  const seen = new Map(); // ref → page, everything ever loaded (for citation validation)
  const evicted = [];
  const trace = [];
  let feedback = '';
  trace.push({ step: 0, action: 'mode', mode, caps: resolved.caps, requested: resolved.requested, degraded: resolved.degraded });

  // core cards are always in the prompt, so they are always "loaded" and able to be cited
  const corePages = coreMemoryPages(db);
  for (const p of corePages) seen.set(p.ref, p);

  const load = (items) => {
    for (const it of items) {
      if (seen.has(it.ref) && pages.includes(seen.get(it.ref))) continue;
      seen.set(it.ref, it);
      pages.push(it);
    }
    while (renderPages(pages).length > WORKING_BUDGET && pages.length > 1) evicted.push(pages.shift().ref);
  };
  const loadByQuery = async (query, person = null) => {
    if (mode === 'bm25') return search(db, query, { person, limit: RETRIEVAL_K });
    return (await hybridSearch(db, bonsai, query, { person, k: RETRIEVAL_K })).slice(0, RETRIEVAL_K);
  };

  // retrieval-first: seed working context so a small model rarely needs more than one hop
  if (mode === 'hybrid-rerank') load(await selectMemories(db, bonsai, question, trace));
  else if (mode === 'hybrid') {
    load(await loadByQuery(question));
    trace.push({ step: 0, action: 'hybrid_search', query: question, loaded: pages.map((p) => p.ref) });
  } else {
    load(search(db, question, { limit: RETRIEVAL_K }));
    trace.push({ step: 0, action: 'search', query: question, loaded: pages.map((p) => p.ref) });
  }
  onStep(trace.at(-1));

  for (let step = 1; step <= MAX_STEPS; step++) {
    const final = step === MAX_STEPS;
    const user = `Today is ${today}.\nCORE MEMORY (people):\n${coreMemory(db)}\n\nWORKING MEMORY (pages loaded from disk):\n${renderPages(pages) || '(empty)'}` +
      (evicted.length ? `\n(${evicted.length} older pages were paged out: ${evicted.slice(-6).join(', ')}; search again if needed)` : '') +
      `\n\nQUESTION: ${question}${feedback ? `\n${feedback}` : ''}${final ? '\nThis is your last step: you must answer now.' : ''}`;
    let out;
    try {
      out = (typeof bonsai.memoryAction === 'function' ? await bonsai.memoryAction({ system: SYSTEM, user, final }) : null)
        ?? await bonsai.json({ name: 'recall_step', system: SYSTEM, user, schema: STEP_SCHEMA, maxTokens: 250, temperature: 0.2 });
    } catch (e) {
      trace.push({ step, error: e.message });
      break;
    }
    if (final && out.action !== 'answer') out = { ...out, action: 'answer' };

    if (out.action === 'search' && out.query) {
      const before = pages.length;
      load(await loadByQuery(out.query, out.person));
      trace.push({ step, action: 'search', query: out.query, person: out.person, loaded: pages.slice(before).map((p) => p.ref) });
    } else if (out.action === 'tool' && out.tool) {
      // Actions either read evidence (safe) or change memory (proposal only — never applied here).
      if (out.tool === 'play_original_clip') {
        const ids = evidenceForRef(db, out.args?.ref);
        const clips = evidenceClips(db, ids.slice(0, 4));
        trace.push({ step, action: 'play_clip', ref: out.args?.ref, clips: clips.map((c) => c.id) });
        const result = { answer: clips.length ? 'Here is the original recording.' : 'I could not find that clip.', cites: [out.args?.ref].filter(Boolean), clips, photos: [], trace, grounded: clips.length > 0, mode };
        if (persistTrace) saveTrace(db, question, result);
        return result;
      }
      const proposal = proposeAction(db, { kind: out.tool, ...(out.args ?? {}) });
      trace.push({ step, action: 'propose_action', kind: out.tool, proposalId: proposal.id });
      const result = { answer: proposal.say, cites: [], clips: [], photos: [], trace, grounded: false, mode, pendingAction: proposal };
      if (persistTrace) saveTrace(db, question, result);
      return result;
    } else if (out.action === 'open_episode' && /^E\d+$/.test(out.episode ?? '')) {
      const ep = readEpisode(db, Number(out.episode.slice(1)));
      if (ep) load([ep]);
      trace.push({ step, action: 'open_episode', episode: out.episode, found: !!ep });
    } else if (out.answer) {
      const loaded = new Set([...pages.map((p) => p.ref), ...corePages.map((p) => p.ref)]);
      const cites = (out.cite ?? []).filter((r) => seen.has(r) && loaded.has(r)); // only pages still in context
      const citedPages = cites.map((r) => seen.get(r));
      const ids = [...new Set(citedPages.flatMap((p) => p.evidence ?? p.lines?.map((l) => l.id) ?? []))];
      const clips = evidenceClips(db, ids.slice(0, 4));
      const photoIds = citedPages.map((p) => p.photo?.id ?? p.photoId).filter(Boolean);
      const photos = evidencePhotos(db, photoIds);
      if (!temporalGrounded(out.answer, clips)) {
        feedback = 'Your previous date or weekday was not supported by the cited utterances. Search for the exact event and use its spoken date; do not use the recording date.';
        trace.push({ step, action: 'answer_rejected', reason: 'unsupported date', cite: cites });
        onStep(trace.at(-1));
        continue;
      }
      trace.push({ step, action: 'answer', cite: cites });
      onStep(trace.at(-1));
      const result = { answer: out.answer, cites, clips, photos, trace, grounded: clips.length > 0 || photos.length > 0, mode };
      if (persistTrace) saveTrace(db, question, result);
      return result;
    } else {
      trace.push({ step, action: out.action, note: 'missing argument' });
    }
    onStep(trace.at(-1));
  }
  const empty = { answer: "I couldn't find that in my memory.", cites: [], clips: [], photos: [], trace, grounded: false, mode };
  if (persistTrace) saveTrace(db, question, empty);
  return empty;
}

/** Recall trace for the demo view (what was planned, paged in, evicted). */
function saveTrace(db, question, result) {
  try {
    db.prepare('INSERT INTO recall_traces (question, answer, mode, grounded, trace, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(question, result.answer, result.mode, result.grounded ? 1 : 0, JSON.stringify(result.trace), now());
  } catch { /* tracing must never break an answer */ }
}
