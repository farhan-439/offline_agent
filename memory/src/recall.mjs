// Recall: a MemGPT-style controller. Bonsai sees only
//   · core memory (owner + roster of people with their one-line cards) — always in context
//   · a working context of memory pages it chose to load, under a hard character budget
// and decides each step whether to search again, open an episode, or answer with citations.
// Old pages are evicted (oldest first) when the budget is exceeded, MemGPT's queue manager.
import { search, hybridSearch, pageByRef, readEpisode, evidenceClips, evidencePhotos } from './retrieve.mjs';
import { resolveWhen } from './temporal.mjs';
import { resolveMode } from './capabilities.mjs';
import { proposeAction, evidenceForRef } from './actions.mjs';
import { now, parse } from './db.mjs';
import { askPhoto } from './photos.mjs';
import { evidenceInputs } from './inputs.mjs';
import { bumpUsage } from './memories.mjs';

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

const ANSWER_SCHEMA = { type: 'object', additionalProperties: false, required: ['answer', 'cite'], properties: {
  answer: { type: 'string' }, cite: { type: 'array', maxItems: 4, items: { type: 'string' } },
} };

const SYSTEM = `You are Kindred, a private offline memory for the owner. You answer questions about the people in their life using ONLY memory pages. Pages marked N are exact text inputs written by the owner; cite them just like other pages.
Each step, return exactly one action as JSON:
- {"action":"search","query":"keywords","person":"name or null",...} to load more memory from disk.
- {"action":"open_episode","episode":"E7",...} to read the exact words of a conversation.
- {"action":"answer","answer":"...","cite":["F3","E7"],...} when the pages are enough.
Rules: answer in one or two short spoken sentences. Mention an event date or time only when a page explicitly states it; the current date and the date a note was saved are not event dates. If asked when an event happened and the pages do not say, state that the date is unknown. Answer every part of a compound question; if one part is missing from the pages, search for it before answering. Answer in the question's language when possible. A translation is for understanding; the cited original utterance is the proof. Cite page refs you used. If memory does not contain the answer, say you don't remember that, and do not guess. Unused fields are null or [].`;

/**
 * The always-visible roster is itself a set of citeable pages (P:<person id>).
 * Without a ref, a 4B model answers correctly from a card but cannot cite it, so evidence
 * checks fail even though the model read the right memory.
 */
export function coreMemoryPages(db) {
  const people = db.prepare('SELECT id, name, relation, core, core_fact_ids, is_owner, last_seen FROM people ORDER BY is_owner DESC, last_seen DESC NULLS LAST LIMIT 12').all();
  return people.map((p) => {
    const ids = parse(p.core_fact_ids, []).filter(Number.isInteger);
    const facts = ids.flatMap((id) => db.prepare("SELECT evidence FROM facts WHERE rowid = ? AND person_id = ? AND status = 'active'").all(id, p.id));
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

const SUPPORT_STOP = new Set('a an and are as at be because by can cannot did do does eat eaten eating for from has have how i in into is it its me my no not of on or our the their there these this to under was were what when where which who with you your'.split(' '));
const COLORS = new Set('black blue brown gold green orange pink purple red silver white yellow'.split(' '));
const supportTerms = (text) => [...new Set((String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [])
  .filter((word) => word.length > 2 && !SUPPORT_STOP.has(word)))];
const pageText = (page) => page.text ?? page.lines?.map((line) => line.text).join(' ') ?? '';
const citedSources = (pages) => pages.map((page) => ({
  ref: page.ref, layer: page.layer, text: pageText(page), when: page.when ?? null,
  photoId: page.photo?.id ?? page.photoId ?? null,
}));
function sourceScore(question, page) {
  const text = pageText(page).toLowerCase();
  return supportTerms(question).reduce((score, term) => score + (text.includes(term)
    || (term === 'leave' && text.includes('left')) ? 1 : 0), 0);
}
const HAS_TIME = /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|january|february|march|april|may|june|july|august|september|october|november|december|today|tomorrow|noon|midnight|morning|afternoon|evening|\d{1,2}:\d{2})\b/i;
function answerWithUnknownTime(question, answer) {
  if (!/\bwhen\b/i.test(question) || HAS_TIME.test(answer)
    || /\b(?:unknown|not recorded|no date|no time|can't verify|cannot verify|don.t know|do not know)\b/i.test(answer)) return answer;
  return `I don't have a recorded date or time for that. ${answer}`;
}

/** Prefer a loaded page that actually supports each answer clause over an unrelated model citation. */
export function repairCitations(answer, question, modelCites, loadedPages) {
  const available = new Map(loadedPages.map((page) => [page.ref, page]));
  const valid = [...new Set(modelCites ?? [])].filter((ref) => available.has(ref));
  if (/\b(?:couldn.t find|don.t remember|do not remember|unknown)\b/i.test(answer)) return valid;
  const clauses = answer.split(/[.!?;]|\s+and\s+/i).map((part) => part.trim()).filter(Boolean);
  const questionTerms = supportTerms(question);
  const chosen = [];
  for (const clause of clauses) {
    const answerTerms = supportTerms(clause);
    const exactTerms = answerTerms.filter((term) => COLORS.has(term) || /\d/.test(term));
    const support = (page) => {
      const spans = pageText(page).toLowerCase().split(/[.;\n]+/).filter(Boolean);
      return spans.map((text) => {
        if (exactTerms.some((term) => !text.includes(term))) return { score: 0, coverage: 0 };
        const matched = answerTerms.filter((term) => text.includes(term)).length;
        return { score: matched * 2 + questionTerms.reduce((sum, term) => sum + (text.includes(term) ? 0.5 : 0), 0),
          coverage: answerTerms.length ? matched / answerTerms.length : 0 };
      }).sort((a, b) => b.score - a.score)[0] ?? { score: 0, coverage: 0 };
    };
    const ranked = loadedPages.map((page) => ({ page, ...support(page) })).sort((a, b) => b.score - a.score);
    const cited = ranked.find((item) => valid.includes(item.page.ref));
    const best = ranked[0];
    const winner = best?.score >= 2 && best.coverage >= 0.7 && (!cited || best.score > cited.score + 1) ? best : cited;
    if (winner && !chosen.includes(winner.page.ref)) chosen.push(winner.page.ref);
  }
  return chosen.length ? chosen.slice(0, 4) : valid;
}

// For a cooking question, an allergy stated in the cited conversation must not be
// replaced by an unrelated medication warning. This guards a real 4B failure on
// the Sam/Lily fixture: the model cited Lily's peanut allergy but answered with
// Dr. Patel's potassium advice instead.
export function missedFoodAllergy(question, answer, clips) {
  if (!/\b(cook|cooking|food|meal|eat|eating|serve|serving)\b/i.test(question)) return null;
  for (const clip of clips) {
    const match = String(clip.translation || clip.text || '').match(/\ballerg(?:ic|y)\s+to\s+([a-z][a-z -]*?)(?:[,.;]|\bso\b|$)/i);
    if (!match) continue;
    const allergen = match[1].trim().toLowerCase();
    if (!allergen) continue;
    const stem = allergen.replace(/s$/, '');
    if (!answer.toLowerCase().includes(stem)) return allergen;
  }
  return null;
}

const FOLLOW_UP = /\b(again|it|its|that|this|those|these|they|them|he|him|his|she|her|hers|there|same|what about|and what|how about)\b/i;

export function followUpContext(question, history = []) {
  const last = Array.isArray(history) ? history.at(-1) : null;
  if (!last || typeof last.question !== 'string' || !Array.isArray(last.cites)) return null;
  if (!FOLLOW_UP.test(question)) return null;
  const cites = last.cites.filter((ref) => typeof ref === 'string' && /^(?:F\d+|E\d+|N\d+|O\d+|U:[A-Za-z0-9_#:-]+|P:[A-Za-z0-9_-]+|PHOTO:[A-Za-z0-9_-]+)$/.test(ref)).slice(0, 4);
  if (!cites.length) return null;
  return { previousQuestion: last.question.slice(0, 500), cites, query: `${last.question.slice(0, 300)} ${question}` };
}

export async function ask(db, bonsai, question, { today = new Date().toISOString().slice(0, 10), onStep = () => {}, mode: forcedMode = null, persistTrace = true, history = [] } = {}) {
  const followUp = followUpContext(question, history);
  const retrievalQuestion = followUp?.query ?? question;
  const priorPhoto = followUp?.cites.find((ref) => ref.startsWith('PHOTO:'));
  if (priorPhoto && typeof bonsai.vision === 'function') {
    const result = await askPhoto(db, bonsai, priorPhoto.slice(6), `Earlier question: ${followUp.previousQuestion}\nFollow-up: ${question}`);
    if (persistTrace) saveTrace(db, question, result);
    return result;
  }
  // A question explicitly about the only stored photo can be answered from its pixels,
  // even when the first-pass caption omitted the detail. With several photos, normal
  // retrieval chooses a candidate or the user can specify a photo id via /ask-photo.
  if (/\b(photo|picture|image|snapshot)\b/i.test(question) && typeof bonsai.vision === 'function') {
    const photos = db.prepare('SELECT id FROM photos ORDER BY added_at DESC LIMIT 2').all();
    if (photos.length === 1) {
      const result = await askPhoto(db, bonsai, photos[0].id, question);
      if (persistTrace) saveTrace(db, question, result);
      return result;
    }
  }
  const resolved = await resolveMode(bonsai);
  const mode = forcedMode ?? resolved.mode;
  const pages = [];
  const seen = new Map(); // ref → page, everything ever loaded (for citation validation)
  const evicted = [];
  const pinned = new Set();
  const trace = [];
  let feedback = '';
  trace.push({ step: 0, action: 'mode', mode, caps: resolved.caps, requested: resolved.requested, degraded: resolved.degraded });
  if (followUp) trace.push({ step: 0, action: 'follow_up', previousQuestion: followUp.previousQuestion, cites: followUp.cites });

  // core cards are always in the prompt, so they are always "loaded" and able to be cited
  const corePages = coreMemoryPages(db);
  for (const p of corePages) seen.set(p.ref, p);

  const load = (items) => {
    for (const it of items) {
      if (seen.has(it.ref) && pages.includes(seen.get(it.ref))) continue;
      seen.set(it.ref, it);
      pages.push(it);
    }
    while (renderPages(pages).length > WORKING_BUDGET && pages.length > 1) {
      const index = pages.findIndex((page) => !pinned.has(page.ref));
      if (index < 0) break;
      evicted.push(pages.splice(index, 1)[0].ref);
    }
  };
  const loadByQuery = async (query, person = null) => {
    if (mode === 'bm25') return search(db, query, { person, limit: RETRIEVAL_K });
    return (await hybridSearch(db, bonsai, query, { person, k: RETRIEVAL_K })).slice(0, RETRIEVAL_K);
  };

  // retrieval-first: seed working context so a small model rarely needs more than one hop
  if (mode === 'hybrid-rerank') load(await selectMemories(db, bonsai, retrievalQuestion, trace));
  else if (mode === 'hybrid') {
    load(await loadByQuery(retrievalQuestion));
    trace.push({ step: 0, action: 'hybrid_search', query: retrievalQuestion, loaded: pages.map((p) => p.ref) });
  } else {
    load(search(db, retrievalQuestion, { limit: RETRIEVAL_K }));
    trace.push({ step: 0, action: 'search', query: retrievalQuestion, loaded: pages.map((p) => p.ref) });
  }
  if (followUp) {
    const priorPages = followUp.cites.map((ref) => pageByRef(db, ref, retrievalQuestion)).filter(Boolean);
    priorPages.forEach((page) => pinned.add(page.ref));
    load(priorPages);
  }
  pages.slice(0, 2).forEach((page) => pinned.add(page.ref));
  onStep(trace.at(-1));

  for (let step = 1; step <= MAX_STEPS; step++) {
    const final = step === MAX_STEPS;
    const user = `Today is ${today}.\nCORE MEMORY (people):\n${coreMemory(db)}\n\nWORKING MEMORY (pages loaded from disk):\n${renderPages(pages) || '(empty)'}` +
      (evicted.length ? `\n(${evicted.length} older pages were paged out: ${evicted.slice(-6).join(', ')}; search again if needed)` : '') +
      `${followUp ? `\n\nPREVIOUS QUESTION (topic only; verify the answer from memory pages): ${followUp.previousQuestion}` : ''}` +
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
      const cites = repairCitations(out.answer, question, (out.cite ?? []).filter((r) => seen.has(r) && loaded.has(r)), [...pages, ...corePages]);
      if (cites.join('|') !== (out.cite ?? []).filter((r) => loaded.has(r)).join('|'))
        trace.push({ step, action: 'citations_repaired', from: out.cite ?? [], to: cites });
      const citedPages = cites.map((r) => seen.get(r));
      const ids = [...new Set(citedPages.flatMap((p) => p.evidence ?? p.lines?.map((l) => l.id) ?? []))];
      const clips = evidenceClips(db, ids.slice(0, 4));
      const inputs = evidenceInputs(db, cites);
      const photoIds = citedPages.map((p) => p.photo?.id ?? p.photoId).filter(Boolean);
      const photos = evidencePhotos(db, photoIds);
      const missedAllergen = missedFoodAllergy(question, out.answer, clips);
      if (missedAllergen) {
        feedback = `Your answer missed a food allergy stated in the cited conversation: ${missedAllergen}. Answer that part from the cited words. Do not substitute medication advice for an allergy.`;
        trace.push({ step, action: 'answer_rejected', reason: 'missed cited food allergy', cite: cites });
        onStep(trace.at(-1));
        continue;
      }
      if (!temporalGrounded(out.answer, [...clips, ...citedPages.map((page) => ({ text: pageText(page), started_at: page.when }))])) {
        feedback = 'Your previous date or weekday was not supported by the cited utterances. Search for the exact event and use its spoken date; do not use the recording date.';
        trace.push({ step, action: 'answer_rejected', reason: 'unsupported date', cite: cites });
        onStep(trace.at(-1));
        continue;
      }
      trace.push({ step, action: 'answer', cite: cites });
      onStep(trace.at(-1));
      bumpUsage(db, cites);
      const result = { answer: answerWithUnknownTime(question, out.answer), cites, clips, photos, inputs, sources: citedSources(citedPages), trace,
        grounded: clips.length > 0 || photos.length > 0 || inputs.length > 0, mode };
      if (persistTrace) saveTrace(db, question, result);
      return result;
    } else {
      trace.push({ step, action: out.action, note: 'missing argument' });
    }
    onStep(trace.at(-1));
  }
  // Last resort: the paging loop can end without a well-formed answer (a 4B model sometimes
  // returns an `answer` action with no text). Ask once, plainly, with the pages already loaded,
  // instead of refusing while the evidence is sitting in the prompt.
  if (pages.length) {
    try {
      const out = await bonsai.json({ name: 'final_answer', maxTokens: 200, temperature: 0.2, schema: ANSWER_SCHEMA,
        system: 'Answer the question using ONLY the memory pages provided, in one or two short sentences. Cite page refs you used. If the pages truly do not contain the answer, say you do not remember. Never invent.',
        user: `QUESTION: ${question}\n\nPAGES:\n${renderPages(pages)}` });
      if (out.answer?.trim()) {
        const loaded = new Set([...pages.map((p) => p.ref), ...corePages.map((p) => p.ref)]);
        const cites = repairCitations(out.answer, question, (out.cite ?? []).filter((r) => seen.has(r) && loaded.has(r)), [...pages, ...corePages]);
        const citedPages = cites.map((r) => seen.get(r));
        const ids = [...new Set(citedPages.flatMap((p) => p.evidence ?? p.lines?.map((l) => l.id) ?? []))];
        const clips = evidenceClips(db, ids.slice(0, 4));
        const photos = evidencePhotos(db, citedPages.map((p) => p.photo?.id ?? p.photoId).filter(Boolean));
        const inputs = evidenceInputs(db, cites);
        if (!temporalGrounded(out.answer, [...clips, ...citedPages.map((page) => ({ text: pageText(page), started_at: page.when }))])) {
          trace.push({ step: 'fallback', action: 'answer_rejected', reason: 'unsupported date', cite: cites });
          const source = [...seen.values()].filter((page) => page.layer === 'input' || page.layer === 'fact')
            .sort((a, b) => sourceScore(question, b) - sourceScore(question, a))[0];
          if (source) {
            trace.push({ step: 'fallback', action: 'reopen_source', ref: source.ref });
            const safe = { answer: `I can't verify when that happened. The saved memory says: ${pageText(source)}`,
              cites: [source.ref], clips: evidenceClips(db, (source.evidence ?? []).slice(0, 4)),
              photos: [], inputs: evidenceInputs(db, [source.ref]), sources: citedSources([source]), trace,
              grounded: source.layer === 'input' || (source.evidence ?? []).length > 0, mode };
            if (persistTrace) saveTrace(db, question, safe);
            return safe;
          }
          throw new Error('unsupported date in fallback answer');
        }
        if (!cites.length) throw new Error('fallback answer has no verified source');
        trace.push({ step: 'fallback', action: 'answer', cite: cites });
        bumpUsage(db, cites);
        const result = { answer: answerWithUnknownTime(question, out.answer.trim()), cites, clips, photos, inputs, sources: citedSources(citedPages), trace,
          grounded: clips.length > 0 || photos.length > 0 || inputs.length > 0, mode };
        if (persistTrace) saveTrace(db, question, result);
        return result;
      }
    } catch { /* keep the refusal below */ }
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
