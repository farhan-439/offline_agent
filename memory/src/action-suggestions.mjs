// Bonsai proposes follow-through from saved, evidence-linked facts. Suggestions are local
// drafts: only the desktop app can export one, after a separate review and confirmation.
import { json, now, parse } from './db.mjs';
import { toMemory } from './memories.mjs';

const TARGETS = ['calendar', 'reminders', 'notes', 'contacts'];
const SCHEMA = { type: 'object', additionalProperties: false, required: ['actions'], properties: {
  actions: { type: 'array', maxItems: 2, items: { type: 'object', additionalProperties: false,
    required: ['target', 'title', 'details', 'place'], properties: {
      target: { type: 'string', enum: TARGETS },
      title: { type: 'string', maxLength: 100 },
      details: { type: 'string', maxLength: 300 },
      place: { type: ['string', 'null'], maxLength: 120 },
    } } },
} };

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12 };
const number = (word) => Number(word) || WORDS[String(word).toLowerCase()] || null;

/** Only a clock time actually stated in the source becomes a proposed time. */
export function statedTime(text) {
  const s = String(text || '').toLowerCase();
  const m = s.match(/\b(?:at\s+)?(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/)
    || s.match(/\bat\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})(?::([0-5]\d))?\s+(?:in\s+the\s+)?(morning|afternoon|evening|night)\b/);
  if (!m) return null;
  let hour = number(m[1]);
  if (!hour || hour > 12) return null;
  const pm = /^(?:p|afternoon|evening|night)/.test(m[3]);
  hour = (hour % 12) + (pm ? 12 : 0);
  return `${String(hour).padStart(2, '0')}:${m[2] || '00'}`;
}

export function statedSchedule(text) {
  const s = String(text || '').toLowerCase();
  const perDay = s.match(/\b(one|two|three|four|five|six|\d+)\s+times?\s+(?:a|per|each)\s+day\b/);
  const days = s.match(/\b(?:for|over)\s+(one|two|three|four|five|six|seven|\d+)\s+days?\b/);
  const recurring = /\b(?:every|each)\s+(?:morning|afternoon|evening|night|day|daily)\b|\bdaily\b/.test(s)
    ? 'daily' : /\b(?:every|each)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)\b|\b(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|weekly)\b/.test(s)
      ? 'weekly' : 'none';
  return { timesPerDay: perDay ? number(perDay[1]) : 1, duration: days ? number(days[1]) : null,
    repeat: perDay ? 'daily' : recurring };
}

function rowFor(db, row) {
  const f = db.prepare(`SELECT f.*, p.name AS person_name, p.relation AS person_relation
    FROM facts f LEFT JOIN people p ON p.id = f.person_id WHERE f.rowid = ?`).get(Number(row.fact_ref.slice(1)));
  return { id: row.id, target: row.target, payload: parse(row.payload, {}), status: row.status,
    createdAt: row.created_at, appliedAt: row.applied_at, externalId: row.external_id,
    source: f ? toMemory(db, f) : null };
}

export function actionSuggestions(db) {
  return db.prepare(`SELECT * FROM action_suggestions ORDER BY
    CASE status WHEN 'proposed' THEN 0 WHEN 'exporting' THEN 1 ELSE 2 END, id DESC`).all()
    .map((row) => rowFor(db, row));
}

/** Scan at most eight unexamined facts per click; no Apple app is touched here. */
export async function scanActionSuggestions(db, bonsai, { limit = 8 } = {}) {
  if (!bonsai?.json) throw new Error('Bonsai must be running to propose actions.');
  const facts = db.prepare(`SELECT f.*, p.name AS person_name FROM facts f
    LEFT JOIN people p ON p.id = f.person_id
    WHERE f.status = 'active' AND NOT EXISTS (SELECT 1 FROM action_scans s WHERE s.fact_ref = 'F' || f.rowid)
    ORDER BY f.observed_at DESC, f.rowid DESC LIMIT ?`).all(Math.max(1, Math.min(8, Number(limit) || 8)));
  let added = 0;
  for (const f of facts) {
    const ref = `F${f.rowid}`;
    const ids = parse(f.evidence, []);
    const quotes = ids.slice(0, 2).map((id) => db.prepare('SELECT text, translation FROM utterances WHERE id = ?').get(id))
      .filter(Boolean).map((u) => u.translation || u.text);
    const source = [f.text, f.when_text, ...quotes].filter(Boolean).join(' | ');
    const out = await bonsai.json({ name: 'propose_follow_through', schema: SCHEMA, maxTokens: 350, temperature: 0.1,
      system: `Find useful, concrete follow-through in one saved memory. Return zero, one or two action drafts.
calendar: a dated event or appointment. reminders: an explicit task, deadline, routine or medicine schedule.
notes: a useful visit summary or preparation note. contacts: an explicitly stated birthday for the named person.
Do not create actions for mere questions or unsupported guesses. Do not invent a date, time, dose, duration,
place, person, or relationship. Keep the title short. The app will ask the owner to review every draft.`,
      user: `Person: ${f.person_name || 'unknown'}\nKind: ${f.kind}\nSaved fact: ${f.text}\nWhen said: ${f.when_text || 'not stated'}\nOriginal evidence: ${quotes.join(' | ') || '(typed by owner)'}` });
    for (const a of out.actions || []) {
      if (!TARGETS.includes(a.target) || !String(a.title || '').trim()) continue;
      if (a.target === 'contacts' && (!f.person_name || !f.when_resolved)) continue;
      const schedule = statedSchedule(source);
      const proposedPlace = String(a.place || '').trim().slice(0, 120);
      const groundedPlace = proposedPlace && source.toLocaleLowerCase().includes(proposedPlace.toLocaleLowerCase()) ? proposedPlace : '';
      const payload = { title: String(a.title).trim().slice(0, 100), details: f.text.slice(0, 300),
        place: groundedPlace, date: f.when_resolved || null,
        time: statedTime(source), repeat: a.target === 'reminders' ? schedule.repeat : 'none',
        timesPerDay: a.target === 'reminders' ? schedule.timesPerDay : 1,
        duration: a.target === 'reminders' ? schedule.duration : null,
        person: f.person_name || null, sourceRef: ref };
      const result = db.prepare(`INSERT OR IGNORE INTO action_suggestions (fact_ref, target, payload, created_at)
        VALUES (?, ?, ?, ?)`).run(ref, a.target, json(payload), now());
      added += Number(result.changes || 0);
    }
    db.prepare('INSERT OR IGNORE INTO action_scans (fact_ref, scanned_at) VALUES (?, ?)').run(ref, now());
  }
  return { scanned: facts.length, added, suggestions: actionSuggestions(db) };
}

export function reserveActionSuggestion(db, id) {
  const row = db.prepare('SELECT * FROM action_suggestions WHERE id = ?').get(Number(id));
  if (!row) throw new Error('No such action draft.');
  if (row.status !== 'proposed') throw new Error('This action was already added or is being added.');
  const active = db.prepare("SELECT 1 FROM facts WHERE rowid = ? AND status = 'active'").get(Number(row.fact_ref.slice(1)));
  if (!active) throw new Error('The source memory has changed. Scan again before adding this action.');
  db.prepare("UPDATE action_suggestions SET status = 'exporting' WHERE id = ?").run(row.id);
  return rowFor(db, { ...row, status: 'exporting' });
}

export function finishActionSuggestion(db, id, { externalId = null, failed = false } = {}) {
  const row = db.prepare('SELECT status FROM action_suggestions WHERE id = ?').get(Number(id));
  if (!row || row.status !== 'exporting') throw new Error('This action is not being exported.');
  db.prepare('UPDATE action_suggestions SET status = ?, applied_at = ?, external_id = ? WHERE id = ?')
    .run(failed ? 'proposed' : 'added', failed ? null : now(), failed ? null : String(externalId || ''), Number(id));
  return { id: Number(id), status: failed ? 'proposed' : 'added' };
}
