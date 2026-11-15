// Incremental semantic index made by the same Bonsai model used for reasoning.
import { createHash } from 'node:crypto';
import { now } from './db.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const pack = (v) => Buffer.from(new Float32Array(v).buffer);
const unpack = (b) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

// llama.cpp can reject a long embedding input even when the text fits the chat context.
// Keep the full input as evidence; index overlapping pieces that all resolve to its N ref.
export function inputChunks(text, size = 480, overlap = 80) {
  if (text.length <= size) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf(' ', end), text.lastIndexOf('\n', end));
      if (boundary > start + size / 2) end = boundary;
    }
    chunks.push(text.slice(start, end).trim());
    if (end === text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks.filter(Boolean);
}

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
  for (const note of db.prepare('SELECT rowid, text FROM input_notes').all()) {
    const chunks = inputChunks(note.text);
    chunks.forEach((text, i) => docs.push({ ref: chunks.length === 1 ? `N${note.rowid}` : `N${note.rowid}:${i}`, text }));
  }
  return docs;
}

export async function indexMemories(db, bonsai, { batchSize = 16 } = {}) {
  const docs = memoryDocuments(db);
  const pending = docs.filter((d) => {
    const row = db.prepare('SELECT model, content_hash FROM embeddings WHERE ref = ?').get(d.ref);
    return !row || row.model !== bonsai.model || row.content_hash !== hash(d.text);
  });
  for (let i = 0; i < pending.length;) {
    const batch = [];
    let chars = 0;
    while (i < pending.length && batch.length < batchSize && (batch.length === 0 || chars + pending[i].text.length <= 1200)) {
      batch.push(pending[i++]);
      chars += batch.at(-1).text.length;
    }
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
  const liveInputs = new Set(docs.filter((d) => d.ref.startsWith('N')).map((d) => d.ref));
  const dropInput = db.prepare('DELETE FROM embeddings WHERE ref = ?');
  for (const row of db.prepare("SELECT ref FROM embeddings WHERE ref LIKE 'N%'").all())
    if (!liveInputs.has(row.ref)) dropInput.run(row.ref);
  return { indexed: pending.length, total: docs.length };
}

export function nearestRefs(db, vector, model, { limit = 20 } = {}) {
  const best = new Map();
  for (const hit of db.prepare('SELECT ref, dim, vector FROM embeddings WHERE model = ?').all(model)
    .filter((r) => r.dim === vector.length)
    .map((r) => ({ ref: r.ref.replace(/^(N\d+):\d+$/, '$1'), similarity: cosineVector(vector, unpack(r.vector)) }))) {
    if (!best.has(hit.ref) || best.get(hit.ref).similarity < hit.similarity) best.set(hit.ref, hit);
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}
