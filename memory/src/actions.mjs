// Bonsai memory actions that change something on disk. Every state change is two-phase:
// propose (writes a pending row, changes nothing) → confirm (applies and logs). The read-only
// "play the original clip" action needs no confirmation.
import { json, now, tx } from './db.mjs';
import { resolveWhen } from './temporal.mjs';
import { evidenceClips, readEpisode, resolvePersonId } from './retrieve.mjs';
import { indexMemories } from './embeddings.mjs';

export const STATE_CHANGING = ['set_reminder', 'correct_memory', 'forget_memory'];
export const ACTION_KINDS = ['set_reminder', 'play_original_clip', 'correct_memory', 'forget_memory'];

function factRow(db, ref) {
  if (!/^F\d+$/.test(String(ref ?? ''))) return null;
  return db.prepare('SELECT * FROM facts WHERE rowid = ?').get(Number(ref.slice(1))) ?? null;
}

/** Utterance ids behind a citation ref (fact, episode, raw utterance). */
export function evidenceForRef(db, ref) {
  const f = factRow(db, ref);
  if (f) return JSON.parse(f.evidence || '[]');
  if (/^E\d+$/.test(String(ref ?? ''))) return readEpisode(db, Number(ref.slice(1)))?.lines.map((l) => l.id) ?? [];
  if (String(ref ?? '').startsWith('U:')) return [ref.slice(2)];
  return [];
}

function summarise(db, kind, payload) {
  if (kind === 'set_reminder') {
    const due = payload.due ? ` for ${payload.due}` : '';
    return `Set a reminder to "${payload.text}"${due}?`;
  }
  if (kind === 'correct_memory') {
    const f = factRow(db, payload.ref);
    return `Replace the memory "${f?.text ?? payload.ref}" with "${payload.text}"?`;
  }
  if (kind === 'forget_memory') {
    if (payload.person) {
      const pid = resolvePersonId(db, payload.person);
      const n = pid ? db.prepare("SELECT count(*) n FROM facts f WHERE f.status = 'active' AND (f.person_id = ? OR EXISTS (SELECT 1 FROM fact_people fp WHERE fp.fact = f.rowid AND fp.person_id = ?))").get(pid, pid).n : 0;
      return `Forget ${n} ${n === 1 ? 'memory' : 'memories'} about ${payload.person}? They stop shaping answers. The conversations they came from stay in your history.`;
    }
    const f = factRow(db, payload.ref);
    if (!f) return `Forget memories matching "${payload.query ?? payload.ref ?? ''}"? They stop shaping answers; the conversations stay in your history.`;
    const what = f.origin === 'user' ? 'the memory you added' : 'this memory';
    const tail = f.origin === 'user'
      ? 'It disappears from the Ledger. Nothing else changes.'
      : 'It stops shaping answers. The conversation it came from stays in your history.';
    return `Forget ${what}: "${f.text}"? ${tail}`;
  }
  return null;
}

/** First step: record intent, change nothing, ask the user. */
export function proposeAction(db, { kind, ...payload }) {
  if (!ACTION_KINDS.includes(kind)) throw new Error(`unknown action: ${kind}`);
  if (kind === 'set_reminder' && !String(payload.text ?? '').trim()) throw new Error('reminder text is required');
  if (kind === 'correct_memory' && (!payload.ref || !String(payload.text ?? '').trim())) throw new Error('correct_memory needs a ref and text');
  if (kind === 'forget_memory' && !payload.ref && !payload.person && !payload.query) throw new Error('forget_memory needs a ref, person or query');
  const summary = summarise(db, kind, payload);
  const r = db.prepare('INSERT INTO memory_actions (kind, payload, applied, note, created_at) VALUES (?, ?, 0, ?, ?)')
    .run(kind, json(payload), summary, now());
  return { status: 'needs_confirmation', id: r.lastInsertRowid, kind, payload, summary, say: `${summary} Say yes to confirm.` };
}

function applyForget(db, payload) {
  const retract = (rowid) => {
    const person = db.prepare('SELECT person_id FROM facts WHERE rowid = ?').get(rowid);
    const linked = db.prepare('SELECT person_id FROM fact_people WHERE fact = ?').all(rowid);
    db.prepare("UPDATE facts SET status = 'retracted' WHERE rowid = ?").run(rowid);
    db.prepare("DELETE FROM embeddings WHERE ref = ?").run(`F${rowid}`);
    if (person?.person_id) db.prepare('UPDATE people SET core = NULL, core_fact_ids = NULL WHERE id = ?').run(person.person_id);
    for (const { person_id } of linked) db.prepare('UPDATE people SET core = NULL, core_fact_ids = NULL WHERE id = ?').run(person_id);
  };
  if (payload.ref) {
    const f = factRow(db, payload.ref);
    if (!f) throw new Error(`no such memory: ${payload.ref}`);
    retract(f.rowid);
    return { forgotten: 1, refs: [payload.ref] };
  }
  if (payload.person) {
    const pid = resolvePersonId(db, payload.person);
    if (!pid) throw new Error(`no such person: ${payload.person}`);
    const rows = db.prepare("SELECT f.rowid FROM facts f WHERE f.status = 'active' AND (f.person_id = ? OR EXISTS (SELECT 1 FROM fact_people fp WHERE fp.fact = f.rowid AND fp.person_id = ?))").all(pid, pid);
    for (const r of rows) retract(r.rowid);
    db.prepare('UPDATE people SET core = NULL, core_fact_ids = NULL WHERE id = ?').run(pid);
    return { forgotten: rows.length, personId: pid };
  }
  if (payload.query) {
    const rows = db.prepare(`SELECT f.rowid FROM facts_fts JOIN facts f ON f.rowid = facts_fts.rowid
      WHERE facts_fts MATCH ? AND f.status = 'active' LIMIT 5`).all(payload.query);
    for (const r of rows) retract(r.rowid);
    return { forgotten: rows.length };
  }
  return { forgotten: 0 };
}

function applyCorrection(db, payload) {
  const old = factRow(db, payload.ref);
  if (!old) throw new Error(`no such memory: ${payload.ref}`);
  const r = (() => {
    db.prepare("UPDATE facts SET status = 'superseded' WHERE rowid = ?").run(old.rowid);
    const ins = db.prepare('INSERT INTO facts (person_id, kind, text, when_text, when_resolved, evidence, session, episode, observed_at, about_raw, origin, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(old.person_id, old.kind, String(payload.text).trim(), old.when_text, old.when_resolved, '[]', old.session, old.episode, now(), 'user-confirmed correction', 'user', old.scope ?? 'all');
    const name = db.prepare('SELECT name FROM people WHERE id = ?').get(old.person_id)?.name ?? '';
    db.prepare('INSERT INTO facts_fts (rowid, text, person, kind) VALUES (?, ?, ?, ?)').run(ins.lastInsertRowid, String(payload.text), name, old.kind);
    for (const p of db.prepare('SELECT person_id, role FROM fact_people WHERE fact = ?').all(old.rowid))
      db.prepare('INSERT OR IGNORE INTO fact_people (fact, person_id, role) VALUES (?, ?, ?)').run(ins.lastInsertRowid, p.person_id, p.role);
    db.prepare('DELETE FROM embeddings WHERE ref = ?').run(`F${old.rowid}`);
    if (old.person_id) db.prepare('UPDATE people SET core = NULL, core_fact_ids = NULL WHERE id = ?').run(old.person_id);
    return ins.lastInsertRowid;
  })();
  return { corrected: true, ref: `F${r}`, replaced: payload.ref };
}

function applyReminder(db, payload) {
  const id = `rm_${Date.now().toString(36)}`;
  const dueDate = payload.due ? resolveWhen(payload.due, payload.on ?? new Date().toISOString()) : null;
  const pid = payload.person ? resolvePersonId(db, payload.person) : null;
  db.prepare('INSERT INTO reminders (id, text, due_text, due_date, person_id, evidence, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, String(payload.text).trim(), payload.due ?? null, dueDate, pid, json(payload.evidence ?? []), 'pending', now());
  return { reminder: db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) };
}

/** Confirm and apply a pending action, or apply a direct (already confirmed) payload. */
export async function applyAction(db, bonsai, action, { confirmed = false } = {}) {
  if (STATE_CHANGING.includes(action.kind) && !confirmed) {
    const proposal = proposeAction(db, action);
    return { ...proposal, status: 'needs_confirmation' };
  }
  let pendingId = null;
  if (action.id && !action.kind) {
    const row = db.prepare('SELECT * FROM memory_actions WHERE id = ?').get(action.id);
    if (!row) throw new Error(`no such action: ${action.id}`);
    if (row.applied) return { status: 'already_applied', id: row.id, kind: row.kind };
    if (!confirmed) return { status: 'needs_confirmation', id: row.id, kind: row.kind, summary: row.note,
      say: `${row.note} Say yes to confirm.` };
    action = { kind: row.kind, ...JSON.parse(row.payload) };
    pendingId = row.id;
  }
  const execute = () => {
    let result;
    if (action.kind === 'set_reminder') result = applyReminder(db, action);
    else if (action.kind === 'correct_memory') result = applyCorrection(db, action);
    else if (action.kind === 'forget_memory') result = applyForget(db, action);
    else if (action.kind === 'play_original_clip') {
      const ids = evidenceForRef(db, action.ref);
      result = { clips: evidenceClips(db, ids.slice(0, 4)) };
    } else throw new Error(`unknown action: ${action.kind}`);
    if (pendingId != null) db.prepare('UPDATE memory_actions SET applied = 1 WHERE id = ?').run(pendingId);
    return result;
  };
  const result = STATE_CHANGING.includes(action.kind) ? tx(db, execute) : execute();
  if (bonsai && typeof bonsai.embed === 'function' && (action.kind === 'correct_memory' || action.kind === 'forget_memory')) {
    try { await indexMemories(db, bonsai); } catch { /* index refresh is best-effort */ }
  }
  return { status: 'applied', kind: action.kind, ...result };
}

/** Server entry point: `{id, confirm:true}` or a fresh `{kind, ...}` proposal. */
export async function runAction(db, bonsai, input = {}, { confirm = false } = {}) {
  if (input.id) return applyAction(db, bonsai, { id: input.id }, { confirmed: confirm || input.confirm === true });
  if (confirm || input.confirm === true) throw new Error('confirm a pending action by id');
  if (input.kind === 'play_original_clip') return applyAction(db, bonsai, input, { confirmed: true });
  return proposeAction(db, input);
}

export function pendingActions(db) {
  return db.prepare('SELECT id, kind, payload, note, created_at FROM memory_actions WHERE applied = 0 ORDER BY id DESC').all()
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
