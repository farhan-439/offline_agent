// Exact text memories entered through the local Input Lab.
import { now } from './db.mjs';
import { indexMemories } from './embeddings.mjs';
import { resolveMode } from './capabilities.mjs';

export function listInputs(db, limit = 100) {
  return db.prepare('SELECT rowid, text, created_at FROM input_notes ORDER BY rowid DESC LIMIT ?')
    .all(Math.min(200, Math.max(1, limit)))
    .map((row) => ({ id: `N${row.rowid}`, text: row.text, createdAt: row.created_at }));
}

export async function addInput(db, bonsai, text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Input text is required');
  const value = text.trim();
  if (value.length > 4000) throw new Error('Input must be 4,000 characters or fewer');
  const createdAt = now();
  const rowid = db.prepare('INSERT INTO input_notes (text, created_at) VALUES (?, ?)')
    .run(value, createdAt).lastInsertRowid;
  db.prepare('INSERT INTO input_notes_fts (rowid, text) VALUES (?, ?)').run(rowid, value);

  const capability = await resolveMode(bonsai);
  let indexed = false;
  if (capability.caps.embeddings) {
    try {
      await indexMemories(db, bonsai);
      indexed = true;
    } catch { /* exact text remains searchable through FTS5 */ }
  }
  return { id: `N${rowid}`, text: value, createdAt, indexed };
}

export function evidenceInputs(db, refs) {
  return [...new Set(refs)].filter((ref) => /^N\d+$/.test(ref))
    .map((ref) => db.prepare('SELECT rowid, text, created_at FROM input_notes WHERE rowid = ?').get(Number(ref.slice(1))))
    .filter(Boolean)
    .map((row) => ({ id: `N${row.rowid}`, text: row.text, createdAt: row.created_at }));
}
