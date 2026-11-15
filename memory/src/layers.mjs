// Read-only snapshot of every memory layer and the links between them, for the Memory map view.
// Nothing here is computed for show: every count and link comes straight from the store.
import { parse } from './db.mjs';

export function memoryLayers(db, { inputLimit = 200 } = {}) {
  const indexed = new Set(db.prepare('SELECT ref FROM embeddings').all().map((r) => r.ref));

  const people = db.prepare(`SELECT p.id, p.name, p.relation, p.core, p.is_owner, p.last_seen, p.core_fact_ids,
      (SELECT samples FROM voices v WHERE v.person_id = p.id) AS voice_samples
    FROM people p ORDER BY p.is_owner DESC, p.last_seen DESC NULLS LAST, p.name`).all()
    .map((p) => ({
      id: p.id, name: p.name, relation: p.relation, core: p.core, isOwner: !!p.is_owner, lastSeen: p.last_seen,
      voiceSamples: p.voice_samples ?? 0, coreFacts: (parse(p.core_fact_ids, []) ?? []).map((x) => (String(x).startsWith('F') ? String(x) : `F${x}`)),
      indexed: indexed.has(`P:${p.id}`),
    }));

  const speakerOf = new Map(db.prepare(`SELECT c.session, c.speaker, c.person_id, c.how, p.name
    FROM clusters c LEFT JOIN people p ON p.id = c.person_id`).all().map((c) => [`${c.session}|${c.speaker}`, c]));

  const sessions = db.prepare('SELECT * FROM sessions ORDER BY coalesce(started_at, id)').all().map((s) => ({
    id: s.id, startedAt: s.started_at, endedAt: s.ended_at, place: s.place, docked: !!s.docked,
    utterances: db.prepare('SELECT * FROM utterances WHERE session = ? ORDER BY start, rowid').all(s.id).map((u) => {
      const c = speakerOf.get(`${s.id}|${u.speaker}`);
      return { id: u.id, speaker: u.speaker, personId: c?.person_id ?? null, who: c?.name ?? u.speaker, matchedBy: c?.how ?? null,
        start: u.start, end: u.end, text: u.text, kept: !!u.kept, language: u.language ?? null, translation: u.translation ?? null };
    }),
  }));

  const episodes = db.prepare('SELECT rowid, * FROM episodes ORDER BY rowid').all().map((e) => ({
    ref: `E${e.rowid}`, session: e.session, start: e.start, end: e.end, summary: e.summary,
    utterances: parse(e.utterance_ids, []), indexed: indexed.has(`E${e.rowid}`),
  }));

  const linked = new Map();
  for (const r of db.prepare('SELECT fact, person_id FROM fact_people').all()) {
    if (!linked.has(r.fact)) linked.set(r.fact, new Set());
    linked.get(r.fact).add(r.person_id);
  }
  const facts = db.prepare('SELECT rowid, * FROM facts ORDER BY observed_at, rowid').all().map((f) => ({
    ref: `F${f.rowid}`, kind: f.kind, text: f.text, when: f.when_text, whenResolved: f.when_resolved,
    status: f.status, supersededBy: f.superseded_by ? `F${f.superseded_by}` : null,
    origin: f.origin ?? 'extracted', uses: f.uses ?? 0, session: f.session,
    episode: f.episode ? `E${f.episode}` : null, evidence: parse(f.evidence, []),
    people: [...new Set([f.person_id, ...(linked.get(f.rowid) ?? [])].filter(Boolean))],
    observedAt: f.observed_at, indexed: indexed.has(`F${f.rowid}`),
  }));

  const inputs = db.prepare('SELECT rowid, text, created_at FROM input_notes ORDER BY rowid DESC LIMIT ?').all(inputLimit)
    .map((n) => ({ ref: `N${n.rowid}`, text: n.text, createdAt: n.created_at, indexed: indexed.has(`N${n.rowid}`) }));

  const photos = db.prepare('SELECT id, caption, taken_at, added_at FROM photos ORDER BY added_at DESC').all().map((p) => ({
    id: p.id, caption: p.caption, takenAt: p.taken_at, addedAt: p.added_at,
    observations: db.prepare('SELECT rowid, kind, text FROM photo_observations WHERE photo_id = ?').all(p.id)
      .map((o) => ({ ref: `O${o.rowid}`, kind: o.kind, text: o.text, indexed: indexed.has(`O${o.rowid}`) })),
  }));

  const traceRow = db.prepare('SELECT id, question, answer, mode, grounded, trace, created_at FROM recall_traces ORDER BY id DESC LIMIT 1').get();
  const lastRecall = traceRow ? { ...traceRow, grounded: !!traceRow.grounded, trace: parse(traceRow.trace, []) } : null;

  const utterances = sessions.flatMap((s) => s.utterances);
  const totals = {
    sessions: sessions.length,
    utterances: utterances.length,
    kept: utterances.filter((u) => u.kept).length,
    filtered: utterances.filter((u) => !u.kept).length,
    inputs: db.prepare('SELECT count(*) AS n FROM input_notes').get().n,
    photos: photos.length,
    episodes: episodes.length,
    facts: facts.filter((f) => f.status === 'active').length,
    retired: facts.filter((f) => f.status !== 'active').length,
    people: people.length,
    cards: people.filter((p) => p.core).length,
    vectors: indexed.size,
    traces: db.prepare('SELECT count(*) AS n FROM recall_traces').get().n,
  };

  return { totals, sessions, episodes, facts, people, inputs, photos, lastRecall };
}
