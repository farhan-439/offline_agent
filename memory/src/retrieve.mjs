// Two-stage retrieval over the disk store.
//   stage A (coarse): FTS5 BM25 over facts, episode summaries and raw utterances
//   stage B (fine):   rerank by relevance + recency + person match, then cut to a token budget
import { parse } from './db.mjs';
import { nearestRefs } from './embeddings.mjs';

const STOP = new Set('a an the and or but of to in on at for with about from by is are was were be been am do does did what when where who whom which how why that this these those i me my mine you your he she it they them his her their we our us said say says tell told remind there any some can could should would will just than then so if not no'.split(' '));

export function ftsQuery(text) {
  const terms = [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((t) => t.length > 1 && !STOP.has(t));
  return terms.length ? terms.map((t) => `"${t}"*`).join(' OR ') : null;
}

const DAY = 86_400_000;
const recency = (iso, ref = Date.now()) => (iso ? Math.exp(-Math.max(0, ref - Date.parse(iso)) / (30 * DAY)) : 0.5);

/**
 * Returns memory items: { ref, layer, text, personId?, when?, evidence: [utterance ids], score }
 * ref is what Bonsai cites: F12 (fact), E3 (episode), U:<utterance id>.
 */
export function search(db, query, { person = null, limit = 6, now = Date.now() } = {}) {
  const q = ftsQuery(query);
  const pid = person ? db.prepare('SELECT id FROM people WHERE lower(name) = lower(?) OR id = ?').get(person, person)?.id : null;
  const items = [];

  if (q || pid) {
    const facts = q
      ? db.prepare(`SELECT f.*, p.name AS person, bm25(facts_fts) AS rank FROM facts_fts JOIN facts f ON f.rowid = facts_fts.rowid
          LEFT JOIN people p ON p.id = f.person_id WHERE facts_fts MATCH ? AND f.status = 'active' ORDER BY rank LIMIT 30`).all(q)
      : [];
    if (pid) for (const f of db.prepare(`SELECT f.*, p.name AS person, 0 AS rank FROM facts f LEFT JOIN people p ON p.id = f.person_id
        WHERE f.person_id = ? AND f.status = 'active' ORDER BY f.observed_at DESC LIMIT 12`).all(pid)) {
      if (!facts.some((x) => x.rowid === f.rowid)) facts.push(f);
    }
    for (const f of facts) items.push({
      ref: `F${f.rowid}`, layer: 'fact', personId: f.person_id,
      text: `${f.person ?? '?'} · ${f.kind}${f.when_text ? ` · ${f.when_text}` : ''}${f.when_resolved ? ` [calendar date ${f.when_resolved}]` : ''}: ${f.text}`,
      when: f.observed_at, evidence: parse(f.evidence, []), bm25: f.rank,
    });
  }
  if (q) {
    for (const e of db.prepare(`SELECT e.*, s.started_at, bm25(episodes_fts) AS rank FROM episodes_fts JOIN episodes e ON e.rowid = episodes_fts.rowid
        JOIN sessions s ON s.id = e.session WHERE episodes_fts MATCH ? ORDER BY rank LIMIT 10`).all(q)) {
      items.push({ ref: `E${e.rowid}`, layer: 'episode', text: e.summary, when: e.started_at, evidence: parse(e.utterance_ids, []).slice(0, 4), bm25: e.rank });
    }
    for (const u of db.prepare(`SELECT u.*, s.started_at, bm25(utterances_fts) AS rank FROM utterances_fts JOIN utterances u ON u.rowid = utterances_fts.rowid
        JOIN sessions s ON s.id = u.session WHERE utterances_fts MATCH ? AND u.kept = 1 ORDER BY rank LIMIT 10`).all(q)) {
      items.push({ ref: `U:${u.id}`, layer: 'utterance', text: `"${u.text}"${u.translation ? ` [translation: ${u.translation}]` : ''}`, when: u.started_at, evidence: [u.id], bm25: u.rank });
    }
  }

  // stage B: normalise BM25 (lower is better in SQLite) and blend
  const ranks = items.map((i) => i.bm25).filter((r) => r < 0);
  const best = Math.min(...ranks, -1e-9);
  const layerWeight = { fact: 1.0, episode: 0.8, utterance: 0.6 };
  for (const i of items) {
    const rel = i.bm25 < 0 ? i.bm25 / best : 0.4; // person-only matches get a floor
    i.score = layerWeight[i.layer] * (0.7 * rel + 0.2 * recency(i.when, now) + (pid && i.personId === pid ? 0.3 : 0));
  }
  items.sort((a, b) => b.score - a.score);
  // drop raw utterances already covered by a returned fact/episode
  const covered = new Set();
  const out = [];
  for (const i of items) {
    if (i.layer === 'utterance' && covered.has(i.evidence[0])) continue;
    i.evidence.forEach((id) => covered.add(id));
    out.push(i);
    if (out.length >= limit) break;
  }
  return out;
}

function pageByRef(db, ref) {
  if (/^F\d+$/.test(ref)) {
    const f = db.prepare(`SELECT f.*, p.name AS person FROM facts f LEFT JOIN people p ON p.id = f.person_id
      WHERE f.rowid = ? AND f.status = 'active'`).get(Number(ref.slice(1)));
    return f && { ref, layer: 'fact', personId: f.person_id,
      text: `${f.person ?? '?'} · ${f.kind}${f.when_text ? ` · ${f.when_text}` : ''}${f.when_resolved ? ` [calendar date ${f.when_resolved}]` : ''}: ${f.text}`,
      when: f.observed_at, evidence: parse(f.evidence, []) };
  }
  if (/^E\d+$/.test(ref)) {
    const e = db.prepare('SELECT e.*, s.started_at FROM episodes e JOIN sessions s ON s.id = e.session WHERE e.rowid = ?').get(Number(ref.slice(1)));
    return e && { ref, layer: 'episode', text: e.summary, when: e.started_at, evidence: parse(e.utterance_ids, []).slice(0, 4) };
  }
  return null;
}

/** Bonsai vector + exact-term BM25, fused into a fixed 2K shortlist. */
export async function hybridSearch(db, bonsai, query, { person = null, k = 6, now = Date.now() } = {}) {
  const lexical = search(db, query, { person, limit: 20, now });
  const [vector] = await bonsai.embed(query);
  const semantic = nearestRefs(db, vector, bonsai.model, { limit: 20 });
  const candidates = new Map();
  const add = (ref, rank, source) => {
    const page = candidates.get(ref) ?? pageByRef(db, ref);
    if (!page) return;
    page.fusion = (page.fusion ?? 0) + 1 / (60 + rank);
    (page.sources ??= []).push(source);
    candidates.set(ref, page);
  };
  lexical.forEach((p, i) => add(p.ref, i + 1, 'bm25'));
  semantic.forEach((p, i) => add(p.ref, i + 1, 'bonsai_vector'));
  const pid = person ? db.prepare('SELECT id FROM people WHERE lower(name) = lower(?) OR id = ?').get(person, person)?.id : null;
  const ranked = [...candidates.values()].map((p) => ({ ...p, fusion: p.fusion + (pid && p.personId === pid ? 0.01 : 0) }))
    .sort((a, b) => b.fusion - a.fusion).slice(0, 2 * k);
  return ranked;
}

export function readEpisode(db, rowid) {
  const e = db.prepare('SELECT e.*, s.started_at, s.place FROM episodes e JOIN sessions s ON s.id = e.session WHERE e.rowid = ?').get(rowid);
  if (!e) return null;
  const ids = parse(e.utterance_ids, []);
  const lines = ids.map((id) => db.prepare(`SELECT u.id, u.text, u.language, u.translation, coalesce(p.name, u.speaker) AS who FROM utterances u
    LEFT JOIN clusters c ON c.session = u.session AND c.speaker = u.speaker LEFT JOIN people p ON p.id = c.person_id WHERE u.id = ?`).get(id)).filter(Boolean);
  return { ref: `E${rowid}`, when: e.started_at, place: e.place, summary: e.summary, lines };
}

export function evidenceClips(db, ids) {
  return ids.map((id) => db.prepare(`SELECT u.id, u.text, u.language, u.translation, u.audio, u.start, u.end, s.started_at, coalesce(p.name, u.speaker) AS speaker
    FROM utterances u JOIN sessions s ON s.id = u.session LEFT JOIN clusters c ON c.session = u.session AND c.speaker = u.speaker
    LEFT JOIN people p ON p.id = c.person_id WHERE u.id = ?`).get(id)).filter(Boolean);
}
