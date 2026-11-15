// "Dock": turn raw recordings into layered memory. Runs in a batch when the device
// comes home, so the always-on part (Argmax) stays cheap and Bonsai runs only once.
//
//   L0 utterances ──stage 1: sensory filter + topic segmentation (no LLM)──▶ episodes
//   episodes ──stage 2: Bonsai extraction (grounded in utterance ids)──▶ L1 summaries, L2 facts, people
//   touched people ──sleep-time update: Bonsai rewrites core memory, retires outdated facts──▶ L3 core
import { json, parse, now, tx } from './db.mjs';
import { identify, enrollVoice, upsertPerson, findPersonByName } from './identity.mjs';
import { indexMemories } from './embeddings.mjs';
import { resolveWhen } from './temporal.mjs';
import { resolveMode } from './capabilities.mjs';
import { detectSelfIntroductions, isValidPersonName, normalizeRelation, nameMentionedIn, cleanName, displayName, OWNER_TOKENS } from './names.mjs';
import { sameFact, contradicts } from './text.mjs';

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

const KINDS = ['plan', 'promise_by_owner', 'promise_by_them', 'health', 'medication', 'preference', 'family', 'personal', 'directions', 'travel', 'other'];

const EXTRACT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'speakers', 'mentioned', 'facts'],
  properties: {
    summary: { type: 'string', maxLength: 300 },
    speakers: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['label', 'name', 'relation'],
      properties: { label: { type: 'string' }, name: { type: ['string', 'null'] }, relation: { type: ['string', 'null'] } } } },
    mentioned: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['name', 'relation'],
      properties: { name: { type: 'string' }, relation: { type: 'string' } } } },
    facts: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['about', 'people', 'kind', 'text', 'when', 'evidence'],
      properties: {
        about: { type: 'string' }, people: { type: 'array', maxItems: 4, items: { type: 'string' } },
        kind: { type: 'string', enum: KINDS }, text: { type: 'string', maxLength: 200 },
        when: { type: ['string', 'null'] }, evidence: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
      } } },
  },
};

const EXTRACT_SYSTEM = `You build a personal memory for the owner of a voice recorder. The owner may have memory loss, so accuracy matters more than coverage.
Read one conversation excerpt. Each line is: [utterance id] speaker label (known name or ?): text.
Return JSON:
- summary: one or two sentences, third person, name people when known.
- speakers: for every label, the person's name and their relation to the owner, ONLY if the excerpt states it (e.g. "it's Maya from next door", "I'm Doctor Patel"). Use null when not stated. The owner's label is OWNER. Never put a form of address (Mom, Dad, honey, doctor) in name; those are how someone is addressed, not their name.
- relation: one noun relative to the owner: neighbour, son, daughter, granddaughter, grandson, doctor, nurse, friend, partner, caregiver. Never "next door", never "daughter of S1", never "owner's mother". If the speaker calls the owner "Mom" or "Dad", that speaker's relation is son or daughter. A son's daughter is the owner's granddaughter; a speaker's doctor is the owner's doctor.
- mentioned: people talked about but not speaking (e.g. a daughter), with relation to the owner. Never the owner and never a form of address.
- facts: things the owner would want to remember later: plans with dates, promises, health, medication changes, allergies, preferences, family news, directions, landmarks, addresses and travel instructions.
  · "about" is the person's name (or OWNER). "people" lists every person the fact is about, including "about" and anyone else it concerns (for "Sam is coming with Lily", about is Sam and people are ["Sam","Lily"]).
  · text is one short third-person statement. Write the owner as "the owner" and everyone else by name. Never use I, me, my, we, our, you — even when the speaker said them. "Could you water my tomato plants?" becomes "Maya asked the owner to water her tomato plants."
  · Copy dates/times exactly as said in "when". "evidence" lists the utterance ids that state the fact. When a line has a translation, use it for meaning but cite the same original utterance id. Never invent anything not said.`;

function formatEpisode(ep, roster, intros) {
  const lines = ep.utterances.map((u) => {
    const who = roster.get(u.speaker);
    const label = who?.isOwner ? 'OWNER' : `${u.speaker}${who ? ` (${who.name})` : ' (?)'}`;
    return `[${u.id}] ${label}: ${u.text}${u.translation ? ` [translation: ${u.translation}]` : ''}`;
  });
  const hints = ep.utterances
    .map((u) => intros.get(u.speaker))
    .filter((h, i, arr) => h && arr.indexOf(h) === i)
    .map((h) => `- ${h.name}: said "${h.said}"`);
  if (hints.length) lines.unshift(`SELF-INTRODUCTIONS (verified from the speaker's own words — trust these names):\n${hints.join('\n')}`);
  return lines.join('\n');
}

// ---------- sleep-time update · core memory ----------

const CORE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['selected', 'outdated'],
  properties: {
    selected: { type: 'array', maxItems: 3, items: { type: 'integer' } },
    outdated: { type: 'array', items: { type: 'integer' } },
  },
};
const CORE_SYSTEM = `Select up to three fact ids for a short reminder about this person. Prefer upcoming plans, promises, medication and allergies. Do not write prose. List outdated ids only when a newer fact clearly replaces an older one; otherwise return an empty array.`;

function buildCore(person, facts) {
  const lead = person.is_owner ? 'You' : `${person.name}${person.relation ? `, ${person.relation}` : ''}`;
  const chunks = facts.map((f) => {
    let text = `${f.text}${f.when_text && !f.text.toLowerCase().includes(f.when_text.toLowerCase()) ? ` (${f.when_text})` : ''}`.replace(/[.\s]+$/, '');
    // cards are assembled from source facts, so the owner's card can speak to the owner directly
    if (person.is_owner) {
      text = text.replace(/^the owner\b/i, 'You')
        .replace(/\bthe owner['’]s\b/gi, 'your')
        .replace(/\bthe owner is\b/gi, 'you are')
        .replace(/\bthe owner was\b/gi, 'you were')
        .replace(/\bthe owner has\b/gi, 'you have')
        .replace(/\bthe owner\b/gi, 'you');
    }
    return text;
  });
  const words = `${lead}. ${chunks.join('. ')}.`.split(/\s+/);
  return words.slice(0, 50).join(' ');
}

export async function refreshCore(db, bonsai, personId) {
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  const facts = db.prepare("SELECT rowid, kind, text, when_text, observed_at FROM facts WHERE person_id = ? AND status = 'active' ORDER BY observed_at, rowid").all(personId);
  if (!person || !facts.length) return null;
  const user = `Person: ${person.name}${person.relation ? ` (${person.relation})` : ''}\nFacts:\n` +
    facts.map((f) => `${f.rowid}. [${f.kind}${f.when_text ? `, ${f.when_text}` : ''}] ${f.text} (noted ${f.observed_at?.slice(0, 10) ?? '?'})`).join('\n');
  const out = await bonsai.json({ name: 'core_memory', system: CORE_SYSTEM, user, schema: CORE_SCHEMA, maxTokens: 300, temperature: 0.3 });
  const valid = new Set(facts.map((f) => f.rowid));
  const chosen = [...new Set(out.selected ?? [])].filter((id) => valid.has(id));
  const selected = chosen.length ? chosen.map((id) => facts.find((f) => f.rowid === id)) : facts.slice(-2);
  const core = buildCore(person, selected);
  tx(db, () => {
    db.prepare('UPDATE people SET core = ?, core_fact_ids = ?, updated_at = ? WHERE id = ?')
      .run(core, json(selected.map((f) => f.rowid)), now(), personId);
    for (const id of out.outdated ?? []) if (valid.has(id) && id !== facts.at(-1).rowid) {
      db.prepare("UPDATE facts SET status = 'superseded' WHERE rowid = ?").run(id);
    }
  });
  return { ...out, core };
}

// ---------- naming: deterministic gates before anything is stored ----------

function resolveAbout(db, about, { roster, owner, sessionText, report }) {
  const raw = typeof about === 'string' ? about.trim() : '';
  if (!raw) return { pid: owner?.id ?? null, raw: null };
  if (OWNER_TOKENS.has(raw.toLowerCase())) return { pid: owner?.id ?? null, raw };
  const known = [...roster.values()].find((p) => p.name?.toLowerCase() === raw.toLowerCase());
  if (known) return { pid: known.id, raw };
  const found = findPersonByName(db, raw);
  if (found) return { pid: found.id, raw };
  const cleaned = displayName(raw);
  if (isValidPersonName(cleaned, { ownerName: owner?.name }) && nameMentionedIn(cleaned, [sessionText])) {
    return { pid: upsertPerson(db, { name: cleaned }), raw };
  }
  // Free text like "my neighbour's daughter" must not become a person row.
  report.rejected_names.push(raw);
  return { pid: owner?.id ?? null, raw };
}

export async function dock(db, bonsai, { onEvent = () => {}, mode: forcedMode = null } = {}) {
  const report = { sessions: [], episodes: 0, facts: 0, people: new Set(), dropped: 0, ungrounded: 0,
    duplicates: 0, superseded: 0, rejected_names: [], introduced: [] };
  const resolved = await resolveMode(bonsai);
  const mode = forcedMode ?? resolved.mode;
  report.mode = mode;
  report.caps = resolved.caps;
  onEvent({ type: 'mode', mode, caps: resolved.caps });
  const sessions = db.prepare('SELECT * FROM sessions WHERE docked = 0 ORDER BY coalesce(started_at, id)').all();

  for (const s of sessions) {
    onEvent({ type: 'session', id: s.id });
    const owner = db.prepare('SELECT id, name, is_owner FROM people WHERE is_owner = 1').get();
    const all = db.prepare('SELECT * FROM utterances WHERE session = ? ORDER BY start, rowid').all(s.id);
    const bySpeaker = new Map();
    for (const u of all) {
      if (!u.speaker) continue;
      if (!bySpeaker.has(u.speaker)) bySpeaker.set(u.speaker, []);
      bySpeaker.get(u.speaker).push(u);
    }
    const sessionText = all.map((u) => u.text).join(' ');
    const intros = detectSelfIntroductions(all, { ownerName: owner?.name });

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
    // A verified self-introduction binds a new voice even before Bonsai runs.
    for (const [label, intro] of intros) {
      if (roster.has(label)) continue;
      const pid = upsertPerson(db, { name: intro.name });
      const cluster = db.prepare('SELECT voiceprint FROM clusters WHERE session = ? AND speaker = ?').get(s.id, label);
      if (cluster?.voiceprint) enrollVoice(db, pid, parse(cluster.voiceprint));
      db.prepare("UPDATE clusters SET person_id = ?, how = 'intro' WHERE session = ? AND speaker = ?").run(pid, s.id, label);
      roster.set(label, { id: pid, name: intro.name, relation: null, isOwner: false });
      report.introduced.push({ session: s.id, speaker: label, name: intro.name });
      onEvent({ type: 'introduced', speaker: label, name: intro.name, evidence: intro.evidence });
    }

    // 2 · stage 1: sensory filter + segmentation
    const kept = all.filter((u) => sensoryFilter(u.translation || u.text));
    for (const u of all) if (!kept.includes(u)) db.prepare('UPDATE utterances SET kept = 0 WHERE rowid = ?').run(u.rowid);
    report.dropped += all.length - kept.length;
    const episodes = segment(kept);

    // 3 · stage 2: Bonsai extraction per episode
    for (const ep of episodes) {
      const ids = new Set(ep.utterances.map((u) => u.id));
      const out = await bonsai.json({
        name: 'extract', system: EXTRACT_SYSTEM, schema: EXTRACT_SCHEMA, maxTokens: 900, temperature: 0.2,
        user: `Recorded ${s.started_at ?? 'unknown time'}${s.place ? ` at ${s.place}` : ''}.\n${formatEpisode(ep, roster, intros)}`,
      });
      onEvent({ type: 'extracted', session: s.id, facts: out.facts.length });

      tx(db, () => {
        // names from content bind to voiceprints: this is how a new voice becomes a known person
        for (const sp of out.speakers ?? []) {
          if (!sp.label || sp.label === 'OWNER') continue;
          const known = roster.get(sp.label);
          if (known) {
            // already bound (by voice or self-introduction): only fill a missing, evidence-backed relation
            const rel = isValidPersonName(sp.name ?? '', { ownerName: owner?.name }) ? normalizeRelation(sp.relation) : null;
            if (rel && !known.relation) {
              db.prepare('UPDATE people SET relation = coalesce(relation, ?), updated_at = ? WHERE id = ?').run(rel, now(), known.id);
              known.relation = rel;
            }
            continue;
          }
          const hint = intros.get(sp.label);
          const candidate = hint?.name ?? displayName(sp.name ?? '');
          if (!candidate) continue;
          if (!isValidPersonName(candidate, { ownerName: owner?.name })) { report.rejected_names.push(String(sp.name)); continue; }
          // the name must be evidenced: said by this speaker, or at least said in this session
          const ownTexts = (bySpeaker.get(sp.label) ?? []).map((u) => u.text);
          const saidBySpeaker = !!hint || nameMentionedIn(candidate, ownTexts);
          if (!saidBySpeaker && !nameMentionedIn(candidate, [sessionText])) { report.rejected_names.push(candidate); continue; }
          // A relation inferred from a rejected name ("Mom" → mother) is not evidence; drop it.
          const relation = isValidPersonName(sp.name ?? '', { ownerName: owner?.name }) ? normalizeRelation(sp.relation) : null;
          const pid = upsertPerson(db, { name: candidate, relation });
          if (saidBySpeaker) {
            const cluster = db.prepare('SELECT voiceprint FROM clusters WHERE session = ? AND speaker = ?').get(s.id, sp.label);
            if (cluster?.voiceprint) enrollVoice(db, pid, parse(cluster.voiceprint));
            db.prepare("UPDATE clusters SET person_id = ?, how = ? WHERE session = ? AND speaker = ?").run(pid, hint ? 'intro' : 'named', s.id, sp.label);
            onEvent({ type: hint ? 'introduced' : 'named', speaker: sp.label, name: candidate });
          }
          roster.set(sp.label, { id: pid, name: candidate, relation: normalizeRelation(sp.relation), isOwner: false });
        }
        for (const m of out.mentioned ?? []) {
          const name = cleanName(m.name ?? '');
          if (!isValidPersonName(name, { ownerName: owner?.name }) || !nameMentionedIn(name, [sessionText])) {
            if (m.name) report.rejected_names.push(String(m.name));
            continue;
          }
          upsertPerson(db, { name, relation: normalizeRelation(m.relation) });
        }

        const ep_ = db.prepare('INSERT INTO episodes (session, start, end, summary, utterance_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(s.id, ep.start, ep.end, out.summary, json([...ids]), now());
        db.prepare('INSERT INTO episodes_fts (rowid, summary) VALUES (?, ?)').run(ep_.lastInsertRowid, out.summary);
        report.episodes++;

        for (const f of out.facts ?? []) {
          const evidence = (f.evidence ?? []).map((id) => String(id).replace(/^\[|\]$/g, '').trim()).filter((id) => ids.has(id));
          if (!evidence.length) { report.ungrounded++; continue; } // grounding guard: no citation, no memory
          const { pid, raw } = resolveAbout(db, f.about, { roster, owner, sessionText, report });
          const resolved = resolveWhen(f.when, s.started_at);

          // duplicate / contradiction handling, deterministic and model-free
          const existing = db.prepare("SELECT rowid, text FROM facts WHERE person_id = ? AND kind = ? AND status = 'active'").all(pid, f.kind);
          if (existing.some((x) => sameFact(x.text, f.text))) { report.duplicates++; continue; }
          for (const x of existing) {
            if (contradicts(x.text, f.text)) {
              db.prepare("UPDATE facts SET status = 'superseded' WHERE rowid = ?").run(x.rowid);
              report.superseded++;
            }
          }

          // every person the fact concerns; the primary one stays in facts.person_id
          const people = [];
          for (const name of [f.about, ...(f.people ?? [])]) {
            const p = resolveAbout(db, name, { roster, owner, sessionText, report });
            if (p.pid && !people.some((x) => x.pid === p.pid)) people.push(p);
          }
          const primary = people.find((p) => p.pid === pid) ?? { pid, raw };
          const r = db.prepare('INSERT INTO facts (person_id, kind, text, when_text, when_resolved, evidence, session, episode, observed_at, about_raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(primary.pid, f.kind, f.text, f.when ?? null, resolved, json(evidence), s.id, ep_.lastInsertRowid, s.started_at ?? now(), primary.raw ?? null);
          const rowid = r.lastInsertRowid;
          for (const p of people) {
            db.prepare('INSERT OR IGNORE INTO fact_people (fact, person_id, role) VALUES (?, ?, ?)')
              .run(rowid, p.pid, p.pid === primary.pid ? 'primary' : 'mentioned');
            report.people.add(p.pid);
          }
          if (primary.pid) db.prepare('INSERT OR IGNORE INTO fact_people (fact, person_id, role) VALUES (?, ?, ?)').run(rowid, primary.pid, 'primary');
          const names = people.length ? people.map((p) => db.prepare('SELECT name FROM people WHERE id = ?').get(p.pid)?.name).filter(Boolean) : ['?'];
          db.prepare('INSERT INTO facts_fts (rowid, text, person, kind) VALUES (?, ?, ?, ?)').run(rowid, `${f.text} ${f.when ?? ''}`, names.join(' '), f.kind);
          report.facts++;
        }
        for (const p of roster.values()) {
          db.prepare('UPDATE people SET last_seen = ? WHERE id = ?').run(s.started_at ?? now(), p.id);
          if (!p.isOwner) report.people.add(p.id);
        }
        // relation edges: owner ↔ every person with a known relation (speakers and mentioned people)
        if (owner) for (const p of roster.values()) {
          if (p.id === owner.id) continue;
          const rel = normalizeRelation(p.relation) ?? db.prepare('SELECT relation FROM people WHERE id = ?').get(p.id)?.relation;
          if (rel) db.prepare('INSERT OR IGNORE INTO relations (a, b, label, evidence) VALUES (?, ?, ?, ?)').run(owner.id, p.id, rel, json([...ids].slice(0, 1)));
        }
        if (owner) for (const m of db.prepare('SELECT id, relation FROM people WHERE is_owner = 0 AND relation IS NOT NULL').all()) {
          db.prepare('INSERT OR IGNORE INTO relations (a, b, label, evidence) VALUES (?, ?, ?, ?)').run(owner.id, m.id, normalizeRelation(m.relation) ?? m.relation, json([...ids].slice(0, 1)));
        }
      });
    }
    db.prepare('UPDATE sessions SET docked = 1 WHERE id = ?').run(s.id);
    report.sessions.push(s.id);
  }

  // 4 · sleep-time update: rewrite core memory for people whose facts changed (or were retired)
  for (const pid of report.people) {
    const out = await refreshCore(db, bonsai, pid);
    if (out) onEvent({ type: 'core', person: pid, core: out.core });
  }
  if (mode !== 'bm25') {
    report.embeddings = await indexMemories(db, bonsai);
    onEvent({ type: 'embeddings', ...report.embeddings });
  } else {
    report.embeddings = { indexed: 0, total: 0, skipped: 'bm25 mode' };
  }
  report.rejected_names = [...new Set(report.rejected_names)];
  return { ...report, people: [...report.people] };
}
