// Memory records for the Ledger pane: the exact statement, its source, its scope, how often it
// has shaped an answer, and whether the user asked for it (origin "user") or the model inferred it.
import { json, parse, now } from './db.mjs';
import { ftsQuery, resolvePersonId } from './retrieve.mjs';
import { isValidPersonName, displayName } from './names.mjs';
import { findPersonByName, upsertPerson } from './identity.mjs';
import { indexMemories } from './embeddings.mjs';

export const KINDS = ['plan', 'promise_by_owner', 'promise_by_them', 'health', 'medication', 'preference', 'family', 'personal', 'directions', 'travel', 'miscellaneous', 'other'];

function quoteFor(db, ids) {
  for (const id of ids) {
    const u = db.prepare('SELECT id, text, session, start, end, audio FROM utterances WHERE id = ?').get(id);
    if (u) return { utteranceId: u.id, text: u.text, session: u.session, start: u.start, end: u.end, audio: u.audio };
  }
  return null;
}

export function toMemory(db, f, person = null) {
  const ids = parse(f.evidence, []);
  return {
    ref: `F${f.rowid}`,
    text: f.text,
    kind: f.kind,
    status: f.status,
    origin: f.origin ?? 'extracted',
    scope: f.scope ?? 'all',
    when: f.when_resolved ?? f.when_text ?? null,
    whenText: f.when_text ?? null,
    createdAt: f.observed_at,
    uses: f.uses ?? 0,
    lastUsed: f.last_used ?? null,
    person: f.person_id ? { id: f.person_id, name: person?.name ?? f.person_name ?? null, relation: person?.relation ?? f.person_relation ?? null } : null,
    source: ids.length
      ? { session: f.session, utterances: ids, quote: quoteFor(db, ids) }
      : { session: f.session, utterances: [], quote: null },
  };
}

/** List/search memory records for the Ledger. `status` defaults to active only. */
export function listMemories(db, { q = null, person = null, status = 'active', limit = 100 } = {}) {
  const pid = resolvePersonId(db, person);
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const base = `SELECT f.*, p.name AS person_name, p.relation AS person_relation FROM facts f LEFT JOIN people p ON p.id = f.person_id`;
  const personFilter = `(f.person_id = ? OR EXISTS (SELECT 1 FROM fact_people fp WHERE fp.fact = f.rowid AND fp.person_id = ?))`;
  const statusFilter = status === 'any' ? '1 = 1' : 'f.status = ?';
  const statusArgs = status === 'any' ? [] : [status];
  const query = ftsQuery(q ?? '');
  let rows;
  if (query) {
    rows = db.prepare(`SELECT f2.*, p.name AS person_name, p.relation AS person_relation FROM facts_fts
      JOIN facts f2 ON f2.rowid = facts_fts.rowid LEFT JOIN people p ON p.id = f2.person_id
      WHERE facts_fts MATCH ? AND ${statusFilter.replace(/f\./g, 'f2.')} ${pid ? `AND (f2.person_id = ? OR EXISTS (SELECT 1 FROM fact_people fp WHERE fp.fact = f2.rowid AND fp.person_id = ?))` : ''}
      ORDER BY f2.uses DESC, f2.observed_at DESC LIMIT ?`)
      .all(query, ...statusArgs, ...(pid ? [pid, pid] : []), lim);
  } else {
    rows = db.prepare(`${base} WHERE ${statusFilter} ${pid ? `AND ${personFilter}` : ''}
      ORDER BY f.uses DESC, f.observed_at DESC LIMIT ?`)
      .all(...statusArgs, ...(pid ? [pid, pid] : []), lim);
  }
  return rows.map((f) => toMemory(db, f));
}

/**
 * Explicit save ("＋ Remember", or "Remember this: …"). The user's own words are the source, so
 * origin is "user" and there is no utterance evidence to cite.
 */
export async function rememberMemory(db, bonsai, { text, person = null, kind = null, scope = 'all', when = null } = {}) {
  const statement = String(text ?? '').trim();
  if (statement.length < 3) throw new Error('memory text is required (at least 3 characters)');
  let pid = null;
  if (person) {
    const name = displayName(person);
    const found = findPersonByName(db, name); // resolves titles and the owner ("Me", "owner") too
    if (found) pid = found.id;
    else {
      if (!isValidPersonName(name)) throw new Error(`not a person name: ${person}`);
      pid = upsertPerson(db, { name });
    }
  }
  const personName = pid ? db.prepare('SELECT name FROM people WHERE id = ?').get(pid)?.name ?? '' : '';
  const k = KINDS.includes(kind) ? kind : (pid ? 'personal' : 'miscellaneous');
  const r = db.prepare(`INSERT INTO facts (person_id, kind, text, when_text, when_resolved, evidence, session, episode, observed_at, about_raw, origin, scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?)`)
    .run(pid, k, statement, when, null, json([]), null, null, now(), person, scope);
  const rowid = r.lastInsertRowid;
  db.prepare('INSERT INTO facts_fts (rowid, text, person, kind) VALUES (?, ?, ?, ?)').run(rowid, `${statement} ${when ?? ''}`, personName, k);
  if (pid) db.prepare('INSERT OR IGNORE INTO fact_people (fact, person_id, role) VALUES (?, ?, ?)').run(rowid, pid, 'primary');
  const row = db.prepare('SELECT f.*, p.name AS person_name, p.relation AS person_relation FROM facts f LEFT JOIN people p ON p.id = f.person_id WHERE f.rowid = ?').get(rowid);
  if (bonsai && typeof bonsai.embed === 'function') {
    try { await indexMemories(db, bonsai); } catch { /* indexing is best-effort */ }
  }
  return toMemory(db, row);
}

/** Truthful "used 3× · 2d ago" metadata: only facts actually cited in an answer count. */
export function bumpUsage(db, refs) {
  const stmt = db.prepare('UPDATE facts SET uses = coalesce(uses, 0) + 1, last_used = ? WHERE rowid = ?');
  for (const ref of refs) {
    const m = /^F(\d+)$/.exec(String(ref));
    if (m) stmt.run(now(), Number(m[1]));
  }
}
