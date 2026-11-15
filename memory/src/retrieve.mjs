// Two-stage retrieval over the disk store.
//   stage A (coarse): FTS5 BM25 over facts, episode summaries, raw utterances and photo observations
//   stage B (fine):   rerank by relevance + recency + person match, then cut to a token budget
import { parse } from './db.mjs';
import { nearestRefs, inputChunks } from './embeddings.mjs';

const STOP = new Set('a an the and or but of to in on at for with about from by is are was were be been am do does did what when where who whom which how why that this these those i me my mine you your he she it they them his her their we our us said say says tell told remind there any some can could should would will just than then so if not no'.split(' '));

export function ftsQuery(text) {
  const terms = [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((t) => t.length > 1 && !STOP.has(t));
  return terms.length ? terms.map((t) => `"${t}"*`).join(' OR ') : null;
}

const DAY = 86_400_000;
const recency = (iso, ref = Date.now()) => (iso ? Math.exp(-Math.max(0, ref - Date.parse(iso)) / (30 * DAY)) : 0.5);

// A long direct input remains intact in storage and evidence. Recall sees the passage
// most related to this query so one note cannot consume the whole working window.
function inputExcerpt(text, query) {
  if (text.length <= 900) return text;
  const terms = (query.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((term) => term.length > 2 && !STOP.has(term))
    .map((term) => term.slice(0, Math.min(5, term.length)));
  const chunks = inputChunks(text, 800, 160);
  return chunks.map((chunk, index) => ({ chunk, index,
    score: terms.reduce((score, term) => score + (chunk.toLowerCase().includes(term) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.chunk ?? text.slice(0, 800);
}

export function resolvePersonId(db, person) {
  if (!person) return null;
  return db.prepare('SELECT id FROM people WHERE lower(name) = lower(?) OR id = ?').get(person, person)?.id ?? null;
}

/**
 * Returns memory items: { ref, layer, text, personId?, when?, evidence: [utterance ids], score }
 * ref is what Bonsai cites: F12 (fact), E3 (episode), U:<utterance id>, O7 (photo observation), N4 (typed input).
 */
export function search(db, query, { person = null, limit = 6, now = Date.now() } = {}) {
  const q = ftsQuery(query);
  const pid = resolvePersonId(db, person);
  const items = [];

  const facts = new Map();
  if (q) {
    for (const f of db.prepare(`SELECT f.*, p.name AS person, bm25(facts_fts) AS rank FROM facts_fts JOIN facts f ON f.rowid = facts_fts.rowid
        LEFT JOIN people p ON p.id = f.person_id WHERE facts_fts MATCH ? AND f.status = 'active' ORDER BY rank LIMIT 40`).all(q)) facts.set(f.rowid, f);
  }
  if (pid) {
    for (const f of db.prepare(`SELECT f.*, p.name AS person, 0 AS rank FROM facts f LEFT JOIN people p ON p.id = f.person_id
        WHERE f.status = 'active' AND (f.person_id = ? OR EXISTS (SELECT 1 FROM fact_people fp WHERE fp.fact = f.rowid AND fp.person_id = ?))
        ORDER BY f.observed_at DESC LIMIT 12`).all(pid, pid)) if (!facts.has(f.rowid)) facts.set(f.rowid, f);
  }
  if (pid) {
    // photos explicitly linked to this person (e.g. "this is Maya and Priya")
    for (const o of db.prepare(`SELECT o.*, 0 AS rank FROM photo_people pp
        JOIN photo_observations o ON o.photo_id = pp.photo_id WHERE pp.person_id = ? LIMIT 8`).all(pid)) {
      items.push({ ref: `O${o.rowid}`, layer: 'photo', text: `${o.kind}: ${o.text}`, when: o.created_at, evidence: [], bm25: 0, photoId: o.photo_id });
    }
  }

  for (const f of facts.values()) items.push({
    ref: `F${f.rowid}`, layer: 'fact', personId: f.person_id,
    text: `${f.person ?? '?'} · ${f.kind}${f.when_text ? ` · ${f.when_text}` : ''}${f.when_resolved ? ` [calendar date ${f.when_resolved}]` : ''}: ${f.text}${f.about_raw === 'user-confirmed correction' ? ' [user-confirmed correction; no original audio proof]' : ''}`,
    when: f.observed_at, evidence: parse(f.evidence, []), bm25: f.rank,
  });

  if (q) {
    for (const e of db.prepare(`SELECT e.*, s.started_at, bm25(episodes_fts) AS rank FROM episodes_fts JOIN episodes e ON e.rowid = episodes_fts.rowid
        JOIN sessions s ON s.id = e.session WHERE episodes_fts MATCH ? ORDER BY rank LIMIT 10`).all(q)) {
      items.push({ ref: `E${e.rowid}`, layer: 'episode', text: e.summary, when: e.started_at, evidence: parse(e.utterance_ids, []).slice(0, 4), bm25: e.rank });
    }
    for (const u of db.prepare(`SELECT u.*, s.started_at, bm25(utterances_fts) AS rank FROM utterances_fts JOIN utterances u ON u.rowid = utterances_fts.rowid
        JOIN sessions s ON s.id = u.session WHERE utterances_fts MATCH ? AND u.kept = 1 ORDER BY rank LIMIT 10`).all(q)) {
      items.push({ ref: `U:${u.id}`, layer: 'utterance', text: `"${u.text}"${u.translation ? ` [translation: ${u.translation}]` : ''}`, when: u.started_at, evidence: [u.id], bm25: u.rank });
    }
    for (const o of db.prepare(`SELECT o.*, bm25(photo_observations_fts) AS rank FROM photo_observations_fts JOIN photo_observations o ON o.rowid = photo_observations_fts.rowid
        WHERE photo_observations_fts MATCH ? ORDER BY rank LIMIT 10`).all(q)) {
      items.push({ ref: `O${o.rowid}`, layer: 'photo', text: `${o.kind}: ${o.text}`, when: o.created_at, evidence: [], bm25: o.rank, photoId: o.photo_id });
    }
    for (const note of db.prepare(`SELECT n.*, bm25(input_notes_fts) AS rank FROM input_notes_fts
        JOIN input_notes n ON n.rowid = input_notes_fts.rowid
        WHERE input_notes_fts MATCH ? ORDER BY rank LIMIT 40`).all(q)) {
      items.push({ ref: `N${note.rowid}`, layer: 'input', text: inputExcerpt(note.text, query), when: note.created_at,
        evidence: [], bm25: note.rank, noteId: note.rowid });
    }
  }

  // stage B: normalise BM25 (lower is better in SQLite) and blend
  const ranks = items.map((i) => i.bm25).filter((r) => r < 0);
  const best = Math.min(...ranks, -1e-9);
  const layerWeight = { input: 1.1, fact: 1.0, episode: 0.8, photo: 0.75, utterance: 0.6 };
  for (const i of items) {
    const rel = i.bm25 < 0 ? i.bm25 / best : 0.4; // person-only matches get a floor
    i.score = layerWeight[i.layer] * (0.7 * rel + 0.2 * recency(i.when, now) + (pid && (i.personId === pid) ? 0.3 : 0));
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

export function pageByRef(db, ref, query = '') {
  if (ref.startsWith('U:')) {
    const u = db.prepare('SELECT u.*, s.started_at FROM utterances u JOIN sessions s ON s.id = u.session WHERE u.id = ? AND u.kept = 1').get(ref.slice(2));
    return u && { ref, layer: 'utterance', text: `"${u.text}"${u.translation ? ` [translation: ${u.translation}]` : ''}`,
      when: u.started_at, evidence: [u.id] };
  }
  if (/^N\d+$/.test(ref)) {
    const note = db.prepare('SELECT rowid, text, created_at FROM input_notes WHERE rowid = ?').get(Number(ref.slice(1)));
    return note && { ref, layer: 'input', text: inputExcerpt(note.text, query), when: note.created_at,
      evidence: [], noteId: note.rowid };
  }
  if (ref.startsWith('P:')) {
    const p = db.prepare('SELECT id, name, relation, core, core_fact_ids, last_seen FROM people WHERE id = ?').get(ref.slice(2));
    if (!p || !p.core) return null;
    const ids = parse(p.core_fact_ids, []).filter(Number.isInteger);
    const facts = ids.flatMap((id) => db.prepare("SELECT evidence FROM facts WHERE rowid = ? AND person_id = ? AND status = 'active'").all(id, p.id));
    return { ref, layer: 'core', personId: p.id, text: `${p.name}${p.relation ? ` · ${p.relation}` : ''}: ${p.core}`,
      when: p.last_seen, evidence: [...new Set(facts.flatMap((f) => parse(f.evidence, [])))].slice(0, 4) };
  }
  if (/^F\d+$/.test(ref)) {
    const f = db.prepare(`SELECT f.*, p.name AS person FROM facts f LEFT JOIN people p ON p.id = f.person_id
      WHERE f.rowid = ? AND f.status = 'active'`).get(Number(ref.slice(1)));
    if (!f) return null;
    const people = db.prepare('SELECT p.name FROM fact_people fp JOIN people p ON p.id = fp.person_id WHERE fp.fact = ?').all(Number(ref.slice(1))).map((r) => r.name);
    return { ref, layer: 'fact', personId: f.person_id,
      text: `${f.person ?? '?'}${people.length > 1 ? ` with ${people.filter((n) => n !== f.person).join(', ')}` : ''} · ${f.kind}${f.when_text ? ` · ${f.when_text}` : ''}${f.when_resolved ? ` [calendar date ${f.when_resolved}]` : ''}: ${f.text}${f.about_raw === 'user-confirmed correction' ? ' [user-confirmed correction; no original audio proof]' : ''}`,
      when: f.observed_at, evidence: parse(f.evidence, []) };
  }
  if (/^E\d+$/.test(ref)) {
    const e = db.prepare('SELECT e.*, s.started_at FROM episodes e JOIN sessions s ON s.id = e.session WHERE e.rowid = ?').get(Number(ref.slice(1)));
    return e && { ref, layer: 'episode', text: e.summary, when: e.started_at, evidence: parse(e.utterance_ids, []).slice(0, 4) };
  }
  if (/^O\d+$/.test(ref)) {
    const o = db.prepare(`SELECT o.*, p.path, p.mime, p.taken_at, p.added_at FROM photo_observations o JOIN photos p ON p.id = o.photo_id WHERE o.rowid = ?`).get(Number(ref.slice(1)));
    if (!o) return null;
    return { ref, layer: 'photo', text: `${o.kind}: ${o.text}`, when: o.taken_at ?? o.added_at, evidence: [],
      photo: { id: o.photo_id, path: o.path, mime: o.mime } };
  }
  return null;
}

/** Bonsai vector + exact-term BM25, fused into a fixed 2K shortlist. Degrades to BM25 if a call fails. */
export async function hybridSearch(db, bonsai, query, { person = null, k = 6, now = Date.now() } = {}) {
  const lexical = search(db, query, { person, limit: 20, now });
  let semantic = [];
  try {
    const [vector] = await bonsai.embed(query);
    semantic = nearestRefs(db, vector, bonsai.model, { limit: 20 });
  } catch { semantic = []; } // runtime degradation: server restarted without --embeddings
  const candidates = new Map();
  const add = (ref, rank, source) => {
    const page = candidates.get(ref) ?? pageByRef(db, ref, query);
    if (!page) return;
    page.fusion = (page.fusion ?? 0) + 1 / (60 + rank);
    (page.sources ??= []).push(source);
    candidates.set(ref, page);
  };
  lexical.forEach((p, i) => add(p.ref, i + 1, 'bm25'));
  semantic.forEach((p, i) => add(p.ref, i + 1, 'bonsai_vector'));
  const pid = resolvePersonId(db, person);
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

export function evidencePhotos(db, photoIds) {
  return [...new Set(photoIds)].map((id) => db.prepare('SELECT id, path, mime, taken_at, added_at, caption FROM photos WHERE id = ?').get(id)).filter(Boolean);
}
