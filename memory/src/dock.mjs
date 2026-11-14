// "Dock": turn raw recordings into layered memory. Runs in a batch when the device
// comes home, so the always-on part (Argmax) stays cheap and Bonsai runs only once.
//
//   L0 utterances ──stage 1: sensory filter + topic segmentation (no LLM)──▶ episodes
//   episodes ──stage 2: Bonsai extraction (grounded in utterance ids)──▶ L1 summaries, L2 facts, people
//   touched people ──sleep-time update: Bonsai rewrites core memory, retires outdated facts──▶ L3 core
import { json, parse, now, tx } from './db.mjs';
import { identify, enrollVoice, upsertPerson, findPersonByName } from './identity.mjs';

const FILLER = /^(?:(?:um+|uh+|hmm+|mm+|yeah|yes|no|okay|ok|right|sure|oh|ah|so|well|like|i mean|you know)[\s,.!?]*)+$/i;
export const EPISODE_GAP_S = 45;
export const EPISODE_MAX_WORDS = 260;

// ---------- stage 1 · LightMem-style pre-compression and segmentation (deterministic) ----------

export function sensoryFilter(text) {
  const t = text.trim();
  return t.split(/\s+/).length >= 3 && !FILLER.test(t);
}

export function segment(utterances, { gap = EPISODE_GAP_S, maxWords = EPISODE_MAX_WORDS } = {}) {
  const episodes = [];
  let cur = null, words = 0;
  for (const u of utterances) {
    const w = u.text.split(/\s+/).length;
    if (!cur || (u.start != null && cur.end != null && u.start - cur.end > gap) || words + w > maxWords) {
      cur = { utterances: [], start: u.start, end: u.end };
      episodes.push(cur);
      words = 0;
    }
    cur.utterances.push(u);
    cur.end = u.end ?? cur.end;
    words += w;
  }
  return episodes;
}

// ---------- stage 2 · Bonsai extraction ----------

const KINDS = ['plan', 'promise_by_owner', 'promise_by_them', 'health', 'medication', 'preference', 'family', 'personal', 'other'];

const EXTRACT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'speakers', 'mentioned', 'facts'],
  properties: {
    summary: { type: 'string', maxLength: 300 },
    speakers: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['label', 'name', 'relation'],
      properties: { label: { type: 'string' }, name: { type: ['string', 'null'] }, relation: { type: ['string', 'null'] } } } },
    mentioned: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['name', 'relation'],
      properties: { name: { type: 'string' }, relation: { type: 'string' } } } },
    facts: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['about', 'kind', 'text', 'when', 'evidence'],
      properties: {
        about: { type: 'string' }, kind: { type: 'string', enum: KINDS }, text: { type: 'string', maxLength: 200 },
        when: { type: ['string', 'null'] }, evidence: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
      } } },
  },
};

const EXTRACT_SYSTEM = `You build a personal memory for the owner of a voice recorder. The owner may have memory loss, so accuracy matters more than coverage.
Read one conversation excerpt. Each line is: [utterance id] speaker label (known name or ?): text.
Return JSON:
- summary: one or two sentences, third person, name people when known.
- speakers: for every label, the person's name and their relation to the owner, only if the excerpt states it (e.g. "it's Maya from next door"). Use null when not stated. The owner's label is OWNER.
- mentioned: people who are talked about but not speaking (e.g. a daughter), with relation to the speaker or owner.
- facts: things the owner would want to remember later about a person: plans with dates, promises, health, medication changes, allergies, preferences, family news. "about" is the person's name (or OWNER). Copy dates/times exactly as said in "when". "evidence" lists the utterance ids that state the fact. Never invent anything not said.`;

function formatEpisode(ep, roster) {
  return ep.utterances.map((u) => {
    const who = roster.get(u.speaker);
    const label = who?.isOwner ? 'OWNER' : `${u.speaker}${who ? ` (${who.name})` : ' (?)'}`;
    return `[${u.id}] ${label}: ${u.text}`;
  }).join('\n');
}

// ---------- sleep-time update · core memory ----------

const CORE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['core', 'outdated'],
  properties: { core: { type: 'string', maxLength: 400 }, outdated: { type: 'array', items: { type: 'integer' } } },
};
const CORE_SYSTEM = `You maintain a short "core memory" card about one person in the owner's life, read aloud when the owner meets them.
Given the person and their remembered facts (newest last, each with an id), return:
- core: at most 50 words. Who they are to the owner, then the most important current things (upcoming plans, promises, health, allergies). Plain words.
- outdated: ids of facts that a NEWER fact clearly replaces (e.g. an old dose replaced by a new dose). Usually empty.`;

export async function refreshCore(db, bonsai, personId) {
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  const facts = db.prepare("SELECT rowid, kind, text, when_text, observed_at FROM facts WHERE person_id = ? AND status = 'active' ORDER BY observed_at, rowid").all(personId);
  if (!person || !facts.length) return null;
  const user = `Person: ${person.name}${person.relation ? ` (${person.relation})` : ''}\nFacts:\n` +
    facts.map((f) => `${f.rowid}. [${f.kind}${f.when_text ? `, ${f.when_text}` : ''}] ${f.text} (noted ${f.observed_at?.slice(0, 10) ?? '?'})`).join('\n');
  const out = await bonsai.json({ name: 'core_memory', system: CORE_SYSTEM, user, schema: CORE_SCHEMA, maxTokens: 300, temperature: 0.3 });
  const valid = new Set(facts.map((f) => f.rowid));
  tx(db, () => {
    db.prepare('UPDATE people SET core = ?, updated_at = ? WHERE id = ?').run(out.core, now(), personId);
    for (const id of out.outdated ?? []) if (valid.has(id) && id !== facts.at(-1).rowid) {
      db.prepare("UPDATE facts SET status = 'superseded' WHERE rowid = ?").run(id);
    }
  });
  return out;
}

// ---------- the dock pipeline ----------

export async function dock(db, bonsai, { onEvent = () => {} } = {}) {
  const report = { sessions: [], episodes: 0, facts: 0, people: new Set(), dropped: 0, ungrounded: 0 };
  const sessions = db.prepare('SELECT * FROM sessions WHERE docked = 0 ORDER BY coalesce(started_at, id)').all();

  for (const s of sessions) {
    onEvent({ type: 'session', id: s.id });
    // 1 · identify every speaker cluster by voice (Argmax voiceprint → person)
    const roster = new Map();
    for (const c of db.prepare('SELECT * FROM clusters WHERE session = ?').all(s.id)) {
      const { person, score } = identify(db, parse(c.voiceprint));
      if (person) {
        roster.set(c.speaker, person);
        db.prepare("UPDATE clusters SET person_id = ?, how = 'voice', score = ? WHERE session = ? AND speaker = ?").run(person.id, score, s.id, c.speaker);
        onEvent({ type: 'voice_match', speaker: c.speaker, name: person.name, score });
      }
    }

    // 2 · stage 1: sensory filter + segmentation
    const all = db.prepare('SELECT * FROM utterances WHERE session = ? ORDER BY start, rowid').all(s.id);
    const kept = all.filter((u) => sensoryFilter(u.text));
    for (const u of all) if (!kept.includes(u)) db.prepare('UPDATE utterances SET kept = 0 WHERE rowid = ?').run(u.rowid);
    report.dropped += all.length - kept.length;
    const episodes = segment(kept);

    // 3 · stage 2: Bonsai extraction per episode
    for (const ep of episodes) {
      const ids = new Set(ep.utterances.map((u) => u.id));
      const out = await bonsai.json({
        name: 'extract', system: EXTRACT_SYSTEM, schema: EXTRACT_SCHEMA, maxTokens: 900, temperature: 0.2,
        user: `Recorded ${s.started_at ?? 'unknown time'}${s.place ? ` at ${s.place}` : ''}.\n${formatEpisode(ep, roster)}`,
      });
      onEvent({ type: 'extracted', session: s.id, facts: out.facts.length });

      tx(db, () => {
        // names from content bind to voiceprints: this is how a new voice becomes a known person
        for (const sp of out.speakers ?? []) {
          if (!sp.name || sp.label === 'OWNER' || roster.has(sp.label)) continue;
          const pid = upsertPerson(db, { name: sp.name, relation: sp.relation });
          const cluster = db.prepare('SELECT voiceprint FROM clusters WHERE session = ? AND speaker = ?').get(s.id, sp.label);
          if (cluster) {
            enrollVoice(db, pid, parse(cluster.voiceprint));
            db.prepare("UPDATE clusters SET person_id = ?, how = 'named' WHERE session = ? AND speaker = ?").run(pid, s.id, sp.label);
          }
          roster.set(sp.label, { id: pid, name: sp.name, relation: sp.relation });
          onEvent({ type: 'named', speaker: sp.label, name: sp.name });
        }
        for (const m of out.mentioned ?? []) upsertPerson(db, { name: m.name, relation: m.relation });

        const ep_ = db.prepare('INSERT INTO episodes (session, start, end, summary, utterance_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(s.id, ep.start, ep.end, out.summary, json([...ids]), now());
        db.prepare('INSERT INTO episodes_fts (rowid, summary) VALUES (?, ?)').run(ep_.lastInsertRowid, out.summary);
        report.episodes++;

        const owner = db.prepare('SELECT id, name FROM people WHERE is_owner = 1').get();
        for (const f of out.facts ?? []) {
          const evidence = (f.evidence ?? []).map((id) => String(id).replace(/^\[|\]$/g, '').trim()).filter((id) => ids.has(id));
          if (!evidence.length) { report.ungrounded++; continue; } // grounding guard: no citation, no memory
          const person = f.about === 'OWNER' ? owner
            : [...roster.values()].find((p) => p.name?.toLowerCase() === f.about.toLowerCase()) ?? findPersonByName(db, f.about);
          const pid = person?.id ?? upsertPerson(db, { name: f.about });
          const r = db.prepare('INSERT INTO facts (person_id, kind, text, when_text, evidence, session, episode, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(pid, f.kind, f.text, f.when ?? null, json(evidence), s.id, ep_.lastInsertRowid, s.started_at ?? now());
          const name = db.prepare('SELECT name FROM people WHERE id = ?').get(pid).name;
          db.prepare('INSERT INTO facts_fts (rowid, text, person, kind) VALUES (?, ?, ?, ?)').run(r.lastInsertRowid, `${f.text} ${f.when ?? ''}`, name, f.kind);
          report.people.add(pid);
          report.facts++;
        }
        for (const p of roster.values()) {
          db.prepare('UPDATE people SET last_seen = ? WHERE id = ?').run(s.started_at ?? now(), p.id);
          if (!p.isOwner) report.people.add(p.id);
        }
        // relation edges: owner ↔ each identified speaker in this session
        if (owner) for (const p of roster.values()) if (p.id !== owner.id && p.relation) {
          db.prepare('INSERT OR IGNORE INTO relations (a, b, label, evidence) VALUES (?, ?, ?, ?)').run(owner.id, p.id, p.relation, json([...ids].slice(0, 1)));
        }
      });
    }
    db.prepare('UPDATE sessions SET docked = 1 WHERE id = ?').run(s.id);
    report.sessions.push(s.id);
  }

  // 4 · sleep-time update: rewrite core memory only for people whose facts changed
  for (const pid of report.people) {
    const out = await refreshCore(db, bonsai, pid);
    if (out) onEvent({ type: 'core', person: pid, core: out.core });
  }
  return { ...report, people: [...report.people] };
}
