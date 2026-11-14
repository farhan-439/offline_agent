// Voice identity: Argmax gives a voiceprint per speaker cluster; we keep one running
// centroid per person and match new clusters by cosine similarity.
import { json, parse, now } from './db.mjs';

export const MATCH_THRESHOLD = Number(process.env.KINDRED_VOICE_THRESHOLD || 0.85);

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const normalise = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };

/** Best matching person for a voiceprint, or null below the threshold. */
export function identify(db, voiceprint, threshold = MATCH_THRESHOLD) {
  if (!voiceprint?.length) return { person: null, score: 0 };
  let best = { person: null, score: 0 };
  for (const row of db.prepare('SELECT v.person_id, v.vector, p.name, p.relation, p.is_owner FROM voices v JOIN people p ON p.id = v.person_id').all()) {
    const score = cosine(voiceprint, parse(row.vector));
    if (score > best.score) best = { person: { id: row.person_id, name: row.name, relation: row.relation, isOwner: !!row.is_owner }, score };
  }
  return best.score >= threshold ? best : { person: null, score: best.score };
}

/** Fold a voiceprint into a person's centroid (running mean, re-normalised). */
export function enrollVoice(db, personId, voiceprint) {
  if (!voiceprint?.length) return;
  const v = normalise(voiceprint);
  const row = db.prepare('SELECT vector, samples FROM voices WHERE person_id = ?').get(personId);
  if (!row) {
    db.prepare('INSERT INTO voices (person_id, vector, samples) VALUES (?, ?, 1)').run(personId, json(v));
    return;
  }
  const old = parse(row.vector);
  if (old.length !== v.length) return; // different embedding model; keep the old print
  const n = row.samples;
  const merged = normalise(old.map((x, i) => (x * n + v[i]) / (n + 1)));
  db.prepare('UPDATE voices SET vector = ?, samples = ? WHERE person_id = ?').run(json(merged), n + 1, personId);
}

export function slug(name) {
  return 'p_' + name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export function findPersonByName(db, name) {
  if (!name) return null;
  const clean = name.replace(/^(dr\.?|doctor|mr\.?|mrs\.?|ms\.?)\s+/i, '').trim().toLowerCase();
  return db.prepare(`SELECT * FROM people WHERE lower(name) = ? OR lower(name) = ?
    OR lower(replace(replace(name,'Dr. ',''),'Doctor ','')) = ?`).get(name.toLowerCase(), clean, clean) ?? null;
}

export function upsertPerson(db, { name, relation = null, isOwner = false }) {
  const existing = isOwner ? db.prepare('SELECT * FROM people WHERE is_owner = 1').get() : findPersonByName(db, name);
  if (existing) {
    if (relation && !existing.relation) db.prepare('UPDATE people SET relation = ?, updated_at = ? WHERE id = ?').run(relation, now(), existing.id);
    return existing.id;
  }
  let id = isOwner ? 'p_me' : slug(name);
  while (db.prepare('SELECT 1 FROM people WHERE id = ?').get(id)) id += '_';
  db.prepare('INSERT INTO people (id, name, relation, is_owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, relation, isOwner ? 1 : 0, now(), now());
  return id;
}

export function enrollOwner(db, voiceprint, name = 'Me') {
  const id = upsertPerson(db, { name, relation: 'device owner', isOwner: true });
  enrollVoice(db, id, voiceprint);
  return id;
}
