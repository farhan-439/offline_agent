// Regression tests for the Bonsai memory work: capability fallback, grounded identity,
// multi-person facts, dedupe/supersede, dates, compound coverage, photo memory and actions.
// The model is always scripted here; these prove behaviour, not Bonsai's accuracy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { openDb } from '../src/db.mjs';
import { ingestFile, ingestEvents, readSessionFile } from '../src/ingest.mjs';
import { enrollOwner } from '../src/identity.mjs';
import { dock } from '../src/dock.mjs';
import { ask } from '../src/recall.mjs';
import { search, hybridSearch } from '../src/retrieve.mjs';
import { indexMemories, memoryDocuments } from '../src/embeddings.mjs';
import { ingestPhoto } from '../src/photos.mjs';
import { proposeAction, applyAction, runAction, pendingActions } from '../src/actions.mjs';
import { createHandler } from '../src/server.mjs';
import { Bonsai } from '../src/bonsai.mjs';
import { resolveMode } from '../src/capabilities.mjs';
import { isValidPersonName, normalizeRelation, detectSelfIntroductions } from '../src/names.mjs';
import { resolveWhen } from '../src/temporal.mjs';
import { sameFact, contradicts } from '../src/text.mjs';

const fx = (f) => path.resolve(import.meta.dirname, '../../contract/fixtures', f);
const OWNER = [0.96, 0.04, 0.03, 0.02, 0.13, 0.02, 0.09, 0.02];

const GOOD = {
  'd1-porch#0002': {
    summary: 'Maya from next door has knee surgery on Friday and asked for help with her tomatoes.',
    speakers: [{ label: 'S1', name: 'Maya', relation: 'next door' }],
    mentioned: [{ name: 'Priya', relation: 'daughter' }],
    facts: [
      { about: 'Maya', people: ['Maya'], kind: 'health', text: 'Knee surgery at Mercy Hospital', when: 'this Friday', evidence: ['d1-porch#0003'] },
      { about: 'OWNER', people: ['OWNER', 'Maya'], kind: 'promise_by_owner', text: "Water Maya's tomato plants; spare key under the blue pot", when: null, evidence: ['d1-porch#0005'] },
      { about: 'Priya', people: ['Priya', 'Maya'], kind: 'family', text: 'Driving from Boston to stay with Maya', when: null, evidence: ['d1-porch#0007'] },
    ],
  },
  'd1-clinic#0001': {
    summary: 'Dr. Patel raised lisinopril to ten milligrams and booked a follow-up.',
    speakers: [{ label: 'S1', name: 'Dr. Patel', relation: 'doctor' }],
    mentioned: [],
    facts: [
      { about: 'OWNER', people: ['OWNER'], kind: 'medication', text: 'Lisinopril raised from 5 mg to 10 mg, once every morning', when: null, evidence: ['d1-clinic#0002'] },
      { about: 'OWNER', people: ['OWNER'], kind: 'preference', text: 'Avoid potassium supplements and grapefruit juice', when: null, evidence: ['d1-clinic#0004'] },
      { about: 'Dr. Patel', people: ['Dr. Patel', 'OWNER'], kind: 'plan', text: 'Follow-up appointment; bring the blood pressure log', when: 'December third', evidence: ['d1-clinic#0005'] },
    ],
  },
  'd2-call#0001': {
    summary: 'Sam is coming for lunch on Sunday with Lily, who is allergic to peanuts.',
    speakers: [{ label: 'S1', name: 'Sam', relation: 'son' }],
    mentioned: [{ name: 'Lily', relation: 'granddaughter' }],
    facts: [
      { about: 'Sam', people: ['Sam', 'Lily'], kind: 'plan', text: 'Coming for lunch around noon', when: 'Sunday around noon', evidence: ['d2-call#0003'] },
      { about: 'Lily', people: ['Lily'], kind: 'health', text: 'Allergic to peanuts', when: null, evidence: ['d2-call#0004'] },
    ],
  },
};

class ScriptedDock {
  constructor(extractions = GOOD) { this.extractions = extractions; this.calls = []; }
  async json({ name, user }) {
    this.calls.push({ name, user });
    if (name === 'extract') {
      for (const [needle, payload] of Object.entries(this.extractions)) if (user.includes(`[${needle}]`)) return structuredClone(payload);
      throw new Error(`no extraction for ${user.slice(0, 120)}`);
    }
    if (name === 'core_memory') return { selected: [...user.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])).slice(0, 2), outdated: [] };
    throw new Error(`unexpected call ${name}`);
  }
}

async function docked(extractions = GOOD) {
  const db = openDb(':memory:');
  enrollOwner(db, OWNER);
  for (const f of ['day1-porch-maya.jsonl', 'day1-clinic-patel.jsonl', 'day2-call-sam.jsonl']) ingestFile(db, fx(f));
  const bonsai = new ScriptedDock(extractions);
  const report = await dock(db, bonsai);
  return { db, report, bonsai };
}

test('names: placeholders, forms of address and phrases are rejected before anything is stored', () => {
  for (const bad of ['?', 'unknown', 'owner', 'Owner', 'Mom', 'mom', 'daughter of S1', 'next door', 'my neighbour', 'S1', 'the doctor', '', '123'])
    assert.equal(isValidPersonName(bad), false, `${bad} must be rejected`);
  for (const good of ['Maya', 'Sam', 'Dr. Patel', 'Doctor Patel', 'Priya Sharma', "Seán O'Connor"])
    assert.equal(isValidPersonName(good), true, `${good} must be accepted`);
  assert.equal(isValidPersonName('Me', { ownerName: 'Me' }), false);
  assert.equal(normalizeRelation('next door'), 'neighbour');
  assert.equal(normalizeRelation("owner's mother"), 'mother');
  assert.equal(normalizeRelation('daughter of S1'), 'daughter');
  assert.equal(normalizeRelation('S1'), null);
});

test('self-introductions are detected from the speaker’s own words', () => {
  const porch = detectSelfIntroductions(readSessionFile(fx('day1-porch-maya.jsonl')));
  assert.equal(porch.get('S1').name, 'Maya');
  const clinic = detectSelfIntroductions(readSessionFile(fx('day1-clinic-patel.jsonl')));
  assert.match(clinic.get('S1').name, /Patel$/);
  const call = detectSelfIntroductions(readSessionFile(fx('day2-call-sam.jsonl')));
  assert.equal(call.get('S1').name, 'Sam');
  assert.equal(call.has('S0'), false, 'the owner is addressed as Mom, not introduced');
});

test('dock binds voices from introductions, normalises relations, and links multi-person facts', async () => {
  const { db, report } = await docked();
  const people = db.prepare('SELECT name, relation FROM people ORDER BY name').all();
  const names = people.map((p) => p.name);
  for (const phantom of ['?', 'Mom', 'owner', 'S1', 'next door']) assert.equal(names.includes(phantom), false, `${phantom} leaked into people`);
  assert.ok(names.includes('Maya') && names.includes('Sam') && names.includes('Lily'));
  assert.equal(db.prepare("SELECT relation FROM people WHERE name = 'Maya'").get().relation, 'neighbour');
  assert.equal(db.prepare("SELECT relation FROM people WHERE name = 'Sam'").get().relation, 'son');
  assert.equal(db.prepare("SELECT relation FROM people WHERE name = 'Lily'").get().relation, 'granddaughter');
  assert.equal(db.prepare("SELECT how FROM clusters WHERE session = 'd1-porch' AND speaker = 'S1'").get().how, 'intro');
  assert.equal(db.prepare("SELECT how FROM clusters WHERE session = 'd2-call' AND speaker = 'S1'").get().how, 'intro');
  assert.equal(report.rejected_names.length, 0);

  const lunch = db.prepare("SELECT rowid FROM facts WHERE text LIKE '%Coming for lunch%'").get();
  const linked = db.prepare('SELECT p.name FROM fact_people fp JOIN people p ON p.id = fp.person_id WHERE fp.fact = ?').all(lunch.rowid).map((r) => r.name).sort();
  assert.deepEqual(linked, ['Lily', 'Sam']);
  // a person-scoped search finds a fact that only mentions them through fact_people
  const hits = search(db, 'xyzzy', { person: 'Lily' });
  assert.ok(hits.some((h) => h.ref === `F${lunch.rowid}`), 'Lily’s partition must include the joint visit fact');
});

test('a hostile extraction cannot create phantom people or a wrong relation', async () => {
  const hostile = structuredClone(GOOD);
  hostile['d1-porch#0002'].speakers = [{ label: 'S1', name: '?', relation: 'next door' }];
  hostile['d1-porch#0002'].mentioned = [{ name: 'Mom', relation: "owner's mother" }, { name: '?', relation: 'daughter' }];
  hostile['d2-call#0001'].speakers = [{ label: 'S1', name: 'Mom', relation: "owner's mother" }];
  const { db, report } = await docked(hostile);
  const names = db.prepare('SELECT name, relation FROM people').all().map((p) => p.name);
  assert.equal(names.includes('Mom'), false);
  assert.equal(names.includes('?'), false);
  // the introduction still binds Maya and Sam, but the relation guessed from "Mom" is discarded
  assert.ok(names.includes('Maya') && names.includes('Sam'));
  assert.equal(db.prepare("SELECT relation FROM people WHERE name = 'Sam'").get().relation, null);
  assert.ok(report.rejected_names.includes('Mom'));
});

test('duplicate facts are skipped and a changed dose supersedes the old fact', async () => {
  const db = openDb(':memory:');
  enrollOwner(db, OWNER);
  ingestEvents(db, [
    { type: 'session_start', session: 's1', startedAt: '2026-11-10T10:00:00Z' },
    { type: 'utterance', session: 's1', id: 's1#1', speaker: 'S1', start: 0, end: 3, text: 'I take lisinopril 5 mg every morning.' },
    { type: 'utterance', session: 's1', id: 's1#2', speaker: 'S1', start: 200, end: 203, text: 'Now I take lisinopril 10 mg every morning.' },
    { type: 'utterance', session: 's1', id: 's1#3', speaker: 'S1', start: 400, end: 403, text: 'Now I take lisinopril 10 mg every morning.' },
  ]);
  const texts = { 's1#1': 'Lisinopril 5 mg every morning', 's1#2': 'Lisinopril 10 mg every morning', 's1#3': 'Lisinopril 10 mg every morning' };
  const fake = { async json({ name, user }) {
    if (name === 'extract') {
      const id = Object.keys(texts).find((k) => user.includes(`[${k}]`));
      return { summary: 'Medication chat.', speakers: [], mentioned: [],
        facts: [{ about: 'OWNER', people: ['OWNER'], kind: 'medication', text: texts[id], when: null, evidence: [id] }] };
    }
    if (name === 'core_memory') return { selected: [], outdated: [] };
    throw new Error(name);
  } };
  const report = await dock(db, fake);
  const facts = db.prepare('SELECT text, status FROM facts ORDER BY rowid').all();
  assert.equal(report.duplicates, 1, 'the repeated 10 mg fact is not stored twice');
  assert.equal(report.superseded, 1, 'the 5 mg fact is retired when the dose changes');
  assert.deepEqual(facts.map((f) => f.status), ['superseded', 'active']);
  assert.equal(facts.at(-1).text, 'Lisinopril 10 mg every morning');
  assert.ok(sameFact('Avoid grapefruit juice', 'avoid grapefruit juice.'));
  assert.ok(contradicts('Follow-up on December third', 'Follow-up on December tenth'));
  assert.equal(contradicts('Follow-up on December third', 'Follow-up on December tenth with Dr. Patel'), false);
});

test('numeric and ordinal dates resolve against the recording date', () => {
  assert.equal(resolveWhen('11/15', '2026-11-10T09:00:00Z'), '2026-11-15');
  assert.equal(resolveWhen('2026-12-03', '2026-11-10T09:00:00Z'), '2026-12-03');
  assert.equal(resolveWhen('3 December', '2026-11-10T09:00:00Z'), '2026-12-03');
  assert.equal(resolveWhen('the 3rd', '2026-11-10T09:00:00Z'), '2026-12-03');
  assert.equal(resolveWhen('the 20th', '2026-11-10T09:00:00Z'), '2026-11-20');
});

// ---------- capability probe / graceful degradation ----------

const embedVec = (t) => (/garden|tomato|water|plant/i.test(t) ? [1, 0, 0] : /peanut|allerg|cook/i.test(t) ? [0, 1, 0] : [0, 0, 1]);

function chatServer({ embeddings = false, stats = {} } = {}) {
  return async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    if (url.endsWith('/embeddings')) stats.embeddings = (stats.embeddings ?? 0) + 1;
    if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'bonsai-4b' }] }) };
    if (url.endsWith('/embeddings')) {
      if (!embeddings) return { ok: false, status: 501, text: async () => 'This server does not support embeddings', json: async () => ({}) };
      return { ok: true, json: async () => ({ data: body.input.map((t, i) => ({ index: i, embedding: embedVec(t) })) }) };
    }
    const name = body.response_format?.json_schema?.name;
    const user = body.messages?.at(-1)?.content ?? '';
    if (!name) return { ok: true, json: async () => ({ choices: [{ message: { content: '', tool_calls: null } }], usage: {} }) };
    let payload;
    if (name === 'extract') payload = Object.entries(GOOD).find(([id]) => user.includes(`[${id}]`))?.[1] ?? { summary: 'x', speakers: [], mentioned: [], facts: [] };
    else if (name === 'core_memory') payload = { selected: [], outdated: [] };
    else if (name === 'recall_step') payload = { action: 'answer', query: null, person: null, episode: null, answer: 'Bonsai answered from memory.', cite: [] };
    else if (name === 'plan_query') payload = { queries: [user.trim()], person: null };
    else if (name === 'rerank') payload = { refs: [] };
    else throw new Error(`unexpected schema ${name}`);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }], usage: {} }) };
  };
}

async function call(handler, method, url, body = null) {
  const req = Readable.from(body ? [JSON.stringify(body)] : []);
  Object.assign(req, { method, url });
  let status, payload;
  await handler(req, { writeHead(code) { status = code; }, end(text) { payload = text ? JSON.parse(text) : null; } });
  return { status, payload };
}

test('a server without embeddings degrades dock and ask to BM25 instead of throwing', async () => {
  const db = openDb(':memory:');
  const stats = {};
  const bonsai = new Bonsai({ fetchFn: chatServer({ embeddings: false, stats }) });
  const mode = await resolveMode(bonsai);
  assert.equal(mode.mode, 'bm25');
  assert.equal(mode.degraded, false, 'auto mode is not a degraded request');
  assert.match(mode.caps.reason, /501|embeddings/i);
  enrollOwner(db, OWNER);
  for (const f of ['day1-porch-maya.jsonl', 'day1-clinic-patel.jsonl', 'day2-call-sam.jsonl']) ingestFile(db, fx(f));
  const report = await dock(db, bonsai);
  assert.equal(report.mode, 'bm25');
  assert.ok(report.facts > 0);
  assert.equal(report.embeddings.indexed, 0);
  const answer = await ask(db, bonsai, 'What did the doctor change about my medication?');
  assert.equal(answer.mode, 'bm25');
  assert.equal(answer.answer, 'Bonsai answered from memory.');
  // exactly one cached capability probe touched /embeddings, and nothing else did
  assert.equal(stats.embeddings, 1);
  assert.equal(bonsai.calls.filter((c) => c.name === 'embed').length, 0);
  const handler = createHandler(db, bonsai);
  const health = await call(handler, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.payload.retrievalMode, 'bm25');
  assert.equal(health.payload.embeddings.embeddings, false);
});

test('a server with embeddings reports hybrid mode and indexes vectors', async () => {
  const db = openDb(':memory:');
  const bonsai = new Bonsai({ fetchFn: chatServer({ embeddings: true }) });
  enrollOwner(db, OWNER);
  for (const f of ['day1-porch-maya.jsonl', 'day1-clinic-patel.jsonl', 'day2-call-sam.jsonl']) ingestFile(db, fx(f));
  const report = await dock(db, bonsai);
  assert.equal(report.mode, 'hybrid-rerank');
  assert.ok(report.embeddings.indexed > 0);
  const handler = createHandler(db, bonsai);
  const health = await call(handler, 'GET', '/health');
  assert.equal(health.payload.retrievalMode, 'hybrid-rerank');
  assert.equal(health.payload.embeddings.dim, 3);
});

test('compound questions keep one retrieval hit per subquestion', async () => {
  const { db } = await docked();
  const lunch = db.prepare("SELECT rowid FROM facts WHERE text LIKE '%Coming for lunch%'").get().rowid;
  const allergy = db.prepare("SELECT rowid FROM facts WHERE text LIKE '%Allergic to peanuts%'").get().rowid;
  const fake = {
    model: 'fake', async embed(texts) { return texts.map(embedVec); },
    async json({ name, user }) {
      if (name === 'plan_query') return { queries: ['Sam Sunday lunch', 'peanut allergy'], person: null };
      if (name === 'rerank') return { refs: [`F${lunch}`] }; // deliberately drops the second half
      if (name === 'recall_step') return { action: 'answer', answer: 'Sam is coming Sunday around noon; avoid peanuts.', cite: [`F${lunch}`, `F${allergy}`] };
      throw new Error(name);
    },
  };
  await indexMemories(db, fake);
  const r = await ask(db, fake, 'When is Sam coming and is there anything I should not cook?');
  const rerank = r.trace.find((t) => t.action === 'rerank');
  assert.ok(rerank.selected.includes(`F${allergy}`), 'coverage guard must add the allergy fact back');
  assert.ok(r.clips.some((c) => c.id === 'd2-call#0004'));
});

// ---------- photo memory ----------

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('photo memory: vision observations are searchable and answers cite the original photo', async () => {
  const { db } = await docked();
  const dir = mkdtempSync(path.join(tmpdir(), 'kindred-photo-'));
  const file = path.join(dir, 'cake.png');
  writeFileSync(file, PNG);
  const bonsai = {
    model: 'fake',
    async vision() {
      return { caption: 'A blue birthday cake on a table', observations: [
        { kind: 'object', text: 'blue birthday cake', confidence: 0.9 },
        { kind: 'person', text: 'a woman smiling', confidence: 0.8 },
        { kind: 'object', text: '', confidence: 0.9 },
        { kind: 'object', text: 'something vague', confidence: 0.1 },
      ] };
    },
    async json({ name }) {
      if (name === 'recall_step') return { action: 'answer', answer: 'It was a blue birthday cake.', cite: ['O1'] };
      throw new Error(name);
    },
  };
  const added = await ingestPhoto(db, bonsai, { file, note: 'Maya’s birthday' });
  assert.equal(added.duplicate, false);
  assert.equal(added.observations.length, 2, 'empty and low-confidence observations are dropped');
  assert.ok(added.photo.path.startsWith('data/photos/'));
  const again = await ingestPhoto(db, bonsai, { file });
  assert.equal(again.duplicate, true, 'the same image is not stored twice');
  assert.ok(search(db, 'cake').some((h) => /^O\d+$/.test(h.ref)));
  assert.ok(memoryDocuments(db).some((d) => /^O\d+$/.test(d.ref)), 'photo observations are part of the vector index');
  const r = await ask(db, bonsai, 'What was on the birthday photo?');
  assert.equal(r.grounded, true);
  assert.equal(r.photos.length, 1);
  assert.match(r.photos[0].path, /^data\/photos\/[0-9a-f]+\.png$/);
});

test('a photo can be linked to a person and found from that person’s partition', async () => {
  const { db } = await docked();
  const dir = mkdtempSync(path.join(tmpdir(), 'kindred-photo2-'));
  const file = path.join(dir, 'maya-garden.png');
  writeFileSync(file, Buffer.concat([PNG, Buffer.from(String(Date.now()))]));
  const bonsai = { model: 'fake', async vision() { return { caption: 'Maya in the garden', observations: [{ kind: 'person', text: 'a woman by tomato plants', confidence: 0.9 }] }; } };
  await ingestPhoto(db, bonsai, { file, people: ['Maya', '?', 'Mom'] });
  assert.equal(db.prepare('SELECT count(*) n FROM photo_people').get().n, 1, 'only validated names are linked');
  const hits = search(db, 'xyzzy', { person: 'Maya' });
  assert.ok(hits.some((h) => /^O\d+$/.test(h.ref)), 'photos linked to Maya are in her partition');
});

// ---------- actions ----------

test('state-changing actions need confirmation; forgetting removes memories from retrieval', async () => {
  const { db } = await docked();
  const before = db.prepare("SELECT count(*) n FROM facts WHERE status = 'active'").get().n;
  const fact = db.prepare("SELECT rowid FROM facts WHERE text LIKE '%Lisinopril%'").get().rowid;

  const proposal = await applyAction(db, null, { kind: 'forget_memory', ref: `F${fact}` }, { confirmed: false });
  assert.equal(proposal.status, 'needs_confirmation');
  assert.equal(db.prepare("SELECT count(*) n FROM facts WHERE status = 'active'").get().n, before, 'proposal must not change anything');
  assert.equal(pendingActions(db).length, 1);

  const applied = await runAction(db, null, { id: proposal.id, confirm: true }, { confirm: true });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.forgotten, 1);
  assert.equal(db.prepare('SELECT status FROM facts WHERE rowid = ?').get(fact).status, 'retracted');
  assert.equal(search(db, 'lisinopril').some((h) => h.ref === `F${fact}`), false);
  assert.equal(pendingActions(db).length, 0);

  const correction = proposeAction(db, { kind: 'correct_memory', ref: `F${db.prepare("SELECT rowid FROM facts WHERE text LIKE '%potassium%'").get().rowid}`, text: 'Avoid potassium supplements only' });
  const corrected = await runAction(db, null, { id: correction.id, confirm: true }, { confirm: true });
  assert.equal(corrected.status, 'applied');
  assert.ok(db.prepare("SELECT 1 FROM facts WHERE text = 'Avoid potassium supplements only' AND status = 'active'").get());
  assert.equal(db.prepare('SELECT evidence FROM facts WHERE rowid = ?').get(Number(corrected.ref.slice(1))).evidence, '[]',
    'a user correction must not cite old audio as proof of its new wording');

  const reminder = proposeAction(db, { kind: 'set_reminder', text: 'take the new pill', due: 'tomorrow' });
  await runAction(db, null, { id: reminder.id, confirm: true }, { confirm: true });
  const row = db.prepare("SELECT * FROM reminders WHERE text = 'take the new pill'").get();
  assert.equal(row.status, 'pending');
  assert.match(row.due_date, /^\d{4}-\d{2}-\d{2}$/);

  const clip = await applyAction(db, null, { kind: 'play_original_clip', ref: `F${fact}` });
  assert.equal(clip.status, 'applied');
  assert.ok(clip.clips.length > 0);
});

test('recall proposes a reminder but never applies it', async () => {
  const { db } = await docked();
  const fake = {
    async memoryAction() { return { action: 'tool', tool: 'set_reminder', args: { text: 'call Sam back', due: 'tomorrow' } }; },
    async json() { throw new Error('should use native tools'); },
  };
  const r = await ask(db, fake, 'Remind me to call Sam back tomorrow');
  assert.equal(r.pendingAction.status, 'needs_confirmation');
  assert.match(r.answer, /confirm/i);
  assert.equal(db.prepare('SELECT count(*) n FROM reminders').get().n, 0);
});

test('a pending action requires confirmation and a failed action remains pending', async () => {
  const { db } = await docked();
  const reminder = proposeAction(db, { kind: 'set_reminder', text: 'Call Maya' });
  await assert.rejects(runAction(db, null, { kind: 'set_reminder', text: 'Call Maya', confirm: true }),
    /confirm a pending action by id/);
  const unchecked = await runAction(db, null, { id: reminder.id });
  assert.equal(unchecked.status, 'needs_confirmation');
  assert.equal(db.prepare('SELECT count(*) n FROM reminders').get().n, 0);
  assert.equal(db.prepare('SELECT applied FROM memory_actions WHERE id = ?').get(reminder.id).applied, 0);

  const failed = proposeAction(db, { kind: 'correct_memory', ref: 'F999999', text: 'A correction' });
  await assert.rejects(runAction(db, null, { id: failed.id, confirm: true }), /no such memory/);
  assert.equal(db.prepare('SELECT applied FROM memory_actions WHERE id = ?').get(failed.id).applied, 0);

  const applied = await runAction(db, null, { id: reminder.id, confirm: true });
  assert.equal(applied.status, 'applied');
  assert.equal(db.prepare('SELECT count(*) n FROM reminders').get().n, 1);
  assert.equal((await runAction(db, null, { id: reminder.id, confirm: true })).status, 'already_applied');
});

// ---------- demo view data ----------

test('the local service exposes mode, the people graph and recall traces', async () => {
  const { db } = await docked();
  const fake = { async json({ name }) {
    if (name === 'recall_step') return { action: 'answer', answer: 'Maya is the neighbour.', cite: [] };
    throw new Error(name);
  } };
  await ask(db, fake, 'Who is Maya?');
  const handler = createHandler(db, fake);
  const health = await call(handler, 'GET', '/health');
  assert.equal(health.payload.retrievalMode, 'bm25');
  const people = await call(handler, 'GET', '/people');
  assert.ok(people.payload.people.some((p) => p.name === 'Maya' && p.facts >= 1));
  assert.ok(people.payload.relations.some((r) => r.label === 'neighbour'));
  const traces = await call(handler, 'GET', '/traces?limit=5');
  assert.ok(traces.payload.traces.length >= 1);
  assert.equal(traces.payload.traces[0].question, 'Who is Maya?');
  const action = await call(handler, 'POST', '/action', { kind: 'forget_memory', ref: 'F1' });
  assert.equal(action.payload.status, 'needs_confirmation');
});
