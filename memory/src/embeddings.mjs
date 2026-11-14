// Incremental semantic index made by the same Bonsai model used for reasoning.
import { createHash } from 'node:crypto';
import { now } from './db.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const pack = (v) => Buffer.from(new Float32Array(v).buffer);
const unpack = (b) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

export function cosineVector(a, b) {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? dot / Math.sqrt(x * y) : 0;
}

export function memoryDocuments(db) {
  const docs = [];
  for (const f of db.prepare(`SELECT f.rowid, f.kind, f.text, f.when_text, f.when_resolved, p.name FROM facts f
    LEFT JOIN people p ON p.id = f.person_id WHERE f.status = 'active'`).all())
    docs.push({ ref: `F${f.rowid}`, text: `${f.name ?? ''} · ${f.kind} · ${f.text}${f.when_text ? ` · ${f.when_text}` : ''}${f.when_resolved ? ` · ${f.when_resolved}` : ''}` });
  for (const e of db.prepare('SELECT rowid, summary FROM episodes').all())
    docs.push({ ref: `E${e.rowid}`, text: e.summary });
  for (const p of db.prepare("SELECT id, name, relation, core FROM people WHERE core IS NOT NULL AND core != ''").all())
    docs.push({ ref: `P:${p.id}`, text: `${p.name} · ${p.relation ?? ''} · ${p.core}` });
  for (const o of db.prepare(`SELECT o.rowid, o.kind, o.text, p.caption, p.taken_at FROM photo_observations o
      JOIN photos p ON p.id = o.photo_id`).all())
    docs.push({ ref: `O${o.rowid}`, text: `${o.caption ? `${o.caption} · ` : ''}${o.kind} · ${o.text}${o.taken_at ? ` · ${o.taken_at}` : ''}` });
  return docs;
}

export async function indexMemories(db, bonsai, { batchSize = 16 } = {}) {
  const docs = memoryDocuments(db);
  const pending = docs.filter((d) => {
    const row = db.prepare('SELECT model, content_hash FROM embeddings WHERE ref = ?').get(d.ref);
    return !row || row.model !== bonsai.model || row.content_hash !== hash(d.text);
  });
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vectors = await bonsai.embed(batch.map((d) => d.text));
    for (let j = 0; j < batch.length; j++) {
      const v = vectors[j];
      if (v.some((n) => !Number.isFinite(n))) throw new Error('Bonsai returned a non-finite embedding');
      db.prepare(`INSERT INTO embeddings (ref, model, content_hash, dim, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(ref) DO UPDATE SET model=excluded.model, content_hash=excluded.content_hash,
        dim=excluded.dim, vector=excluded.vector, updated_at=excluded.updated_at`)
        .run(batch[j].ref, bonsai.model, hash(batch[j].text), v.length, pack(v), now());
    }
  }
  db.prepare("DELETE FROM embeddings WHERE ref LIKE 'F%' AND NOT EXISTS (SELECT 1 FROM facts WHERE 'F' || rowid = embeddings.ref AND status = 'active')").run();
  db.prepare("DELETE FROM embeddings WHERE ref LIKE 'O%' AND NOT EXISTS (SELECT 1 FROM photo_observations WHERE 'O' || rowid = embeddings.ref)").run();
  return { indexed: pending.length, total: docs.length };
}

export function nearestRefs(db, vector, model, { limit = 20 } = {}) {
  return db.prepare('SELECT ref, dim, vector FROM embeddings WHERE model = ?').all(model)
    .filter((r) => r.dim === vector.length)
    .map((r) => ({ ref: r.ref, similarity: cosineVector(vector, unpack(r.vector)) }))
    .sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}
