// Recall: a MemGPT-style controller. Bonsai sees only
//   · core memory (owner + roster of people with their one-line cards) — always in context
//   · a working context of memory pages it chose to load, under a hard character budget
// and decides each step whether to search again, open an episode, or answer with citations.
// Old pages are evicted (oldest first) when the budget is exceeded, MemGPT's queue manager.
import { search, readEpisode, evidenceClips } from './retrieve.mjs';

export const WORKING_BUDGET = 2400; // chars of paged-in memory; Bonsai's window must also fit prompt + answer
export const MAX_STEPS = 4;

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
Rules: answer in one or two short spoken sentences, mention who said it and when. Cite page refs you used. If memory does not contain the answer, say you don't remember that, and do not guess. Unused fields are null or [].`;

export function coreMemory(db) {
  const people = db.prepare('SELECT name, relation, core, is_owner, last_seen FROM people ORDER BY is_owner DESC, last_seen DESC NULLS LAST LIMIT 12').all();
  return people.map((p) => `- ${p.name}${p.relation ? ` (${p.relation})` : ''}${p.core ? `: ${p.core}` : ''}`).join('\n') || '(no people yet)';
}

function renderPages(pages) {
  return pages.map((p) => p.lines
    ? `[${p.ref}] conversation ${p.when?.slice(0, 10) ?? ''}${p.place ? ` at ${p.place}` : ''}:\n${p.lines.map((l) => `  ${l.who}: ${l.text}`).join('\n')}`
    : `[${p.ref}] (${p.when?.slice(0, 10) ?? '?'}) ${p.text}`).join('\n');
}

export async function ask(db, bonsai, question, { today = new Date().toISOString().slice(0, 10), onStep = () => {} } = {}) {
  const pages = [];
  const seen = new Map(); // ref → page, everything ever loaded (for citation validation)
  const evicted = [];
  const trace = [];

  const load = (items) => {
    for (const it of items) {
      if (seen.has(it.ref) && pages.includes(seen.get(it.ref))) continue;
      seen.set(it.ref, it);
      pages.push(it);
    }
    while (renderPages(pages).length > WORKING_BUDGET && pages.length > 1) evicted.push(pages.shift().ref);
  };

  // retrieval-first: seed working context so a small model rarely needs more than one hop
  load(search(db, question));
  trace.push({ step: 0, action: 'search', query: question, loaded: pages.map((p) => p.ref) });
  onStep(trace.at(-1));

  for (let step = 1; step <= MAX_STEPS; step++) {
    const final = step === MAX_STEPS;
    const user = `Today is ${today}.\nCORE MEMORY (people):\n${coreMemory(db)}\n\nWORKING MEMORY (pages loaded from disk):\n${renderPages(pages) || '(empty)'}` +
      (evicted.length ? `\n(${evicted.length} older pages were paged out: ${evicted.slice(-6).join(', ')}; search again if needed)` : '') +
      `\n\nQUESTION: ${question}${final ? '\nThis is your last step: you must answer now.' : ''}`;
    let out;
    try {
      out = await bonsai.json({ name: 'recall_step', system: SYSTEM, user, schema: STEP_SCHEMA, maxTokens: 250, temperature: 0.2 });
    } catch (e) {
      trace.push({ step, error: e.message });
      break;
    }
    if (final && out.action !== 'answer') out = { ...out, action: 'answer' };

    if (out.action === 'search' && out.query) {
      const before = pages.length;
      load(search(db, out.query, { person: out.person }));
      trace.push({ step, action: 'search', query: out.query, person: out.person, loaded: pages.slice(before).map((p) => p.ref) });
    } else if (out.action === 'open_episode' && /^E\d+$/.test(out.episode ?? '')) {
      const ep = readEpisode(db, Number(out.episode.slice(1)));
      if (ep) load([ep]);
      trace.push({ step, action: 'open_episode', episode: out.episode, found: !!ep });
    } else if (out.answer) {
      const cites = (out.cite ?? []).filter((r) => seen.has(r)); // only pages it actually saw
      const ids = [...new Set(cites.flatMap((r) => seen.get(r).evidence ?? seen.get(r).lines?.map((l) => l.id) ?? []))];
      trace.push({ step, action: 'answer', cite: cites });
      onStep(trace.at(-1));
      return { answer: out.answer, cites, clips: evidenceClips(db, ids.slice(0, 4)), trace, grounded: cites.length > 0 };
    } else {
      trace.push({ step, action: out.action, note: 'missing argument' });
    }
    onStep(trace.at(-1));
  }
  return { answer: "I couldn't find that in my memory.", cites: [], clips: [], trace, grounded: false };
}
