// End-to-end tests of the memory pipeline against the contract fixtures.
// The Bonsai here is a scripted test double: these tests prove the plumbing
// (grounding, identity binding, paging, citations), NOT Bonsai's accuracy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { ingestEvents, ingestFile, readSessionFile } from '../src/ingest.mjs';
import { enrollOwner, identify, cosine } from '../src/identity.mjs';
import { dock, refreshCore, segment, sensoryFilter } from '../src/dock.mjs';
import { resolveWhen } from '../src/temporal.mjs';
import { search, hybridSearch, evidenceClips } from '../src/retrieve.mjs';
import { indexMemories } from '../src/embeddings.mjs';
import { ask, coreMemoryPages, WORKING_BUDGET } from '../src/recall.mjs';
import { whoIsThis } from '../src/whisper.mjs';
import { Bonsai } from '../src/bonsai.mjs';
import { createHandler } from '../src/server.mjs';
import { Readable } from 'node:stream';

const fx = (f) => path.resolve(import.meta.dirname, '../../contract/fixtures', f);
const OWNER = [0.96, 0.04, 0.03, 0.02, 0.13, 0.02, 0.09, 0.02];

const EXTRACTIONS = {
  'd1-porch#0002': {
    summary: 'Maya from next door said her knee surgery moved to Friday and asked the owner to water her tomatoes.',
    speakers: [{ label: 'S1', name: 'Maya', relation: 'neighbour' }],
    mentioned: [{ name: 'Priya', relation: "Maya's daughter" }],
    facts: [
      { about: 'Maya', kind: 'health', text: 'Knee surgery at Mercy Hospital', when: 'this Friday', evidence: ['d1-porch#0003'] },
      { about: 'OWNER', kind: 'promise_by_owner', text: "Water Maya's tomato plants every evening; spare key under the blue pot", when: 'while Maya is away', evidence: ['d1-porch#0005', 'd1-porch#0006'] },
      { about: 'Priya', kind: 'family', text: 'Driving down from Boston to stay with Maya', when: null, evidence: ['d1-porch#0007'] },
      { about: 'Maya', kind: 'other', text: 'Invented fact with a fake citation', when: null, evidence: ['nope#1'] },
    ],
  },
  'd1-clinic#0001': {
    summary: 'Dr. Patel raised lisinopril to 10 mg every morning and booked a follow-up on December 3.',
    speakers: [{ label: 'S1', name: 'Dr. Patel', relation: 'doctor' }],
    mentioned: [],
    facts: [
      { about: 'OWNER', kind: 'medication', text: 'Lisinopril raised from 5 mg to 10 mg, once every morning', when: null, evidence: ['d1-clinic#0002'] },
      { about: 'OWNER', kind: 'health', text: 'Avoid potassium supplements and grapefruit juice', when: null, evidence: ['d1-clinic#0004'] },
      { about: 'Dr. Patel', kind: 'plan', text: 'Follow-up appointment; bring blood pressure log', when: 'December third', evidence: ['d1-clinic#0005'] },
    ],
  },
  'd2-call#0001': {
    summary: 'Sam, the owner\'s son, is coming Sunday at noon with Lily, who is allergic to peanuts.',
    speakers: [{ label: 'S1', name: 'Sam', relation: 'son' }],
    mentioned: [{ name: 'Lily', relation: "Sam's daughter" }],
    facts: [
      { about: 'Sam', kind: 'plan', text: 'Coming for lunch with Lily', when: 'Sunday around noon', evidence: ['d2-call#0003'] },
      { about: 'Lily', kind: 'health', text: 'Allergic to peanuts — no peanut cookies', when: null, evidence: ['d2-call#0004'] },
    ],
  },
};

class FakeBonsai {
  constructor() { this.calls = []; this.script = []; }
  async json({ name, user }) {
    this.calls.push({ name, user });
    if (name === 'extract') return structuredClone(Object.entries(EXTRACTIONS).find(([id]) => user.includes(`[${id}]`))[1]);
    if (name === 'core_memory') return { selected: [...user.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])).slice(0, 2), outdated: [] };
    if (name === 'whisper') return { line: 'This is Maya, your neighbour. You promised to water her tomatoes.' };
    if (name === 'recall_step') return this.script.shift() ?? { action: 'answer', query: null, person: null, episode: null, answer: 'fallback', cite: [] };
    throw new Error(`unexpected call ${name}`);
  }
}

async function dockedDb() {
  const db = openDb(':memory:');
  enrollOwner(db, OWNER);
  for (const f of ['day1-porch-maya.jsonl', 'day1-clinic-patel.jsonl', 'day2-call-sam.jsonl']) ingestFile(db, fx(f));
  const bonsai = new FakeBonsai();
  const report = await dock(db, bonsai);
  return { db, bonsai, report };
}

test('stage 1 drops filler and segments on silence', () => {
  assert.equal(sensoryFilter('Um, yeah.'), false);
  assert.equal(sensoryFilter('Could you water my plants?'), true);
  const eps = segment([{ text: 'a b c', start: 0, end: 1 }, { text: 'd e f', start: 2, end: 3 }, { text: 'g h i', start: 100, end: 101 }]);
  assert.equal(eps.length, 2);
});

test('ingest is idempotent', () => {
  const db = openDb(':memory:');
  ingestFile(db, fx('day1-porch-maya.jsonl'));
  ingestFile(db, fx('day1-porch-maya.jsonl'));
  assert.equal(db.prepare('SELECT count(*) n FROM utterances').get().n, 8);
});

test('dock builds people from speech, binds voices, and rejects ungrounded facts', async () => {
  const { db, report } = await dockedDb();
  assert.equal(report.sessions.length, 3);
  assert.equal(report.ungrounded, 1, 'fact citing a non-existent utterance must be rejected');
  assert.equal(report.dropped, 1, '"Um, yeah." is filtered before Bonsai sees it');
  const names = db.prepare('SELECT name FROM people ORDER BY name').all().map((p) => p.name);
  assert.deepEqual(names, ['Dr. Patel', 'Lily', 'Maya', 'Me', 'Priya', 'Sam']);
  // owner was matched by voice, not created again
  assert.equal(db.prepare("SELECT how FROM clusters WHERE session = 'd1-clinic' AND speaker = 'S0'").get().how, 'voice');
  // Maya was named by Bonsai from content, so her cluster's voiceprint is now enrolled
  // Maya introduces herself ("it's Maya from next door"), so the deterministic intro path binds her voice
  assert.equal(db.prepare("SELECT how FROM clusters WHERE session = 'd1-porch' AND speaker = 'S1'").get().how, 'intro');
  assert.ok(db.prepare("SELECT core FROM people WHERE name = 'Maya'").get().core.startsWith('Maya'));
});

test('a new recording of Maya is recognised by voice and produces a whisper', async () => {
  const { db, bonsai } = await dockedDb();
  const live = readSessionFile(fx('day3-live-maya.jsonl')).find((e) => e.type === 'speaker');
  assert.equal(identify(db, live.voiceprint).person.name, 'Maya');
  assert.ok(cosine(live.voiceprint, OWNER) < 0.3);
  const w = await whoIsThis(db, bonsai, live.voiceprint);
  assert.equal(w.name, 'Maya');
  assert.match(w.whisper, /^This is Maya/);
  const stranger = await whoIsThis(db, bonsai, [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(stranger.personId, null);
});

test('retrieval ranks the relevant fact first and filters by person', async () => {
  const { db } = await dockedDb();
  const hits = search(db, 'lisinopril dose');
  assert.equal(hits[0].layer, 'fact');
  assert.match(hits[0].text, /Lisinopril/);
  const lily = search(db, 'allergy', { person: 'Lily' });
  assert.ok(lily.some((h) => /peanut/i.test(h.text)));
});

test('recall pages memory in, validates citations, and returns audio evidence', async () => {
  const { db, bonsai } = await dockedDb();
  bonsai.script = [
    { action: 'search', query: 'Sam visit Sunday', person: 'Sam', episode: null, answer: null, cite: [] },
    { action: 'answer', query: null, person: null, episode: null, answer: 'Sam said on the 11th he is coming Sunday around noon with Lily.', cite: ['F99', ...[]] },
  ];
  // cite a real fact ref the controller has seen, plus a fake one that must be dropped
  const real = search(db, 'Sam visit Sunday', { person: 'Sam' })[0].ref;
  bonsai.script[1].cite = [real, 'F999'];
  const r = await ask(db, bonsai, 'When is Sam coming?');
  assert.deepEqual(r.cites, [real]);
  assert.ok(r.grounded);
  assert.ok(r.clips.some((c) => c.id === 'd2-call#0003' && c.speaker === 'Sam'));
  assert.ok(r.trace.some((t) => t.action === 'search' && t.query));
  const prompt = bonsai.calls.filter((c) => c.name === 'recall_step').at(-1).user;
  const working = prompt.split('WORKING MEMORY')[1].split('QUESTION')[0];
  assert.ok(working.length <= WORKING_BUDGET + 200, 'working memory stays within budget');
});

test('recall refuses to answer from nothing', async () => {
  const { db, bonsai } = await dockedDb();
  bonsai.script = Array(5).fill({ action: 'search', query: 'xyzzy', person: null, episode: null, answer: null, cite: [] });
  const r = await ask(db, bonsai, 'What is my bank PIN?');
  assert.equal(r.grounded, false);
});

test('Bonsai vectors are indexed once and recover a paraphrased garden memory', async () => {
  const { db } = await dockedDb();
  const bonsai = {
    model: 'bonsai-test', batches: 0,
    async embed(texts) {
      this.batches++;
      return (Array.isArray(texts) ? texts : [texts]).map((s) => /garden|tomato|plant|water/i.test(s) ? [1, 0] : [0, 1]);
    },
  };
  const first = await indexMemories(db, bonsai);
  assert.ok(first.indexed >= 8);
  assert.equal((await indexMemories(db, bonsai)).indexed, 0);
  const hits = await hybridSearch(db, bonsai, 'Did anyone need help with their garden?', { k: 6 });
  assert.ok(hits.some((h) => /Water Maya's tomato plants/.test(h.text)));
  assert.ok(hits.length <= 12);
  assert.ok(hits.some((h) => h.sources.includes('bonsai_vector')));
});

test('Bonsai plans and filters retrieval before paged answering', async () => {
  const { db } = await dockedDb();
  const calls = [];
  const bonsai = {
    model: 'bonsai-test',
    async embed(texts) { return (Array.isArray(texts) ? texts : [texts]).map((s) => /garden|tomato|plant|water/i.test(s) ? [1, 0] : [0, 1]); },
    async json({ name, user }) {
      calls.push(name);
      if (name === 'plan_query') return { queries: ['Maya garden help'], person: 'Maya' };
      if (name === 'rerank') return { refs: [user.match(/\[(F\d+)\] [^\n]*Water Maya's tomato plants/)?.[1]] };
      if (name === 'recall_step') return { action: 'answer', answer: 'You promised to water Maya’s tomato plants.', cite: [db.prepare("SELECT 'F' || rowid AS ref FROM facts WHERE text LIKE '%Water Maya%' LIMIT 1").get().ref] };
      throw new Error(`unexpected ${name}`);
    },
  };
  await indexMemories(db, bonsai);
  const result = await ask(db, bonsai, 'Did Maya need help with her garden?');
  assert.deepEqual(calls, ['plan_query', 'rerank', 'recall_step']);
  assert.equal(result.grounded, true);
  assert.ok(result.clips.some((c) => c.id === 'd1-porch#0005'));
  assert.ok(result.trace.some((t) => t.action === 'plan_query'));
  assert.ok(result.trace.some((t) => t.action === 'rerank'));
  assert.equal(result.trace[0].action, 'mode');
});

test('a core card outside the always-visible roster remains retrievable', async () => {
  const { db } = await dockedDb();
  for (let i = 0; i < 15; i++) {
    db.prepare('INSERT INTO people (id, name, core, created_at, updated_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`p_extra_${i}`, `Extra ${i}`, `Extra ${i} keeps a compass near the ferry`, '2026-11-01', '2026-11-01', `2026-11-${String(i + 1).padStart(2, '0')}`);
  }
  const bonsai = { model: 'core-test', async embed(texts) {
    return (Array.isArray(texts) ? texts : [texts]).map((s) => /compass|ferry/i.test(s) ? [1, 0] : [0, 1]);
  } };
  await indexMemories(db, bonsai);
  const hits = await hybridSearch(db, bonsai, 'Where is the ferry compass?', { k: 6 });
  assert.ok(hits.some((h) => h.ref.startsWith('P:p_extra_')));
});

test('Bonsai embedding client preserves vector order and traces the call', async () => {
  const client = new Bonsai({ fetchFn: async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).input, ['first', 'second']);
    return { ok: true, json: async () => ({ data: [
      { index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] },
    ] }) };
  } });
  assert.deepEqual(await client.embed(['first', 'second']), [[1, 0], [0, 1]]);
  assert.equal(client.calls[0].name, 'embed');
});

test('Bonsai native tool call becomes a memory search action', async () => {
  const client = new Bonsai({ fetchFn: async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.ok(request.tools.some((t) => t.function.name === 'search_memory'));
    return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{ function: {
      name: 'search_memory', arguments: '{"query":"Maya garden","person":"Maya"}',
    } }] } }] }) };
  } });
  assert.deepEqual(await client.memoryAction({ system: 'Use tools', user: 'What did Maya ask?' }),
    { action: 'search', query: 'Maya garden', person: 'Maya' });
});

test('relative dates are tied to the recording date', async () => {
  assert.equal(resolveWhen('this Friday', '2026-11-10T09:14:00Z'), '2026-11-13');
  assert.equal(resolveWhen('Sunday around noon', '2026-11-11T18:05:00Z'), '2026-11-15');
  assert.equal(resolveWhen('December third', '2026-11-10T14:30:00Z'), '2026-12-03');
  const { db } = await dockedDb();
  assert.equal(db.prepare("SELECT when_resolved FROM facts WHERE text LIKE '%Coming for lunch%' LIMIT 1").get().when_resolved, '2026-11-15');
});

test('core card uses selected source facts rather than model prose', async () => {
  const { db } = await dockedDb();
  const lily = db.prepare("SELECT id FROM people WHERE name = 'Lily'").get().id;
  await refreshCore(db, { async json() { return { selected: [db.prepare("SELECT rowid FROM facts WHERE person_id = ?").get(lily).rowid], outdated: [], core: 'Lily is your daughter and a genius.' }; } }, lily);
  const core = db.prepare('SELECT core FROM people WHERE id = ?').get(lily).core;
  assert.match(core, /Allergic to peanuts/);
  assert.doesNotMatch(core, /genius|your daughter/);
});

test('a core card cites only the facts selected to build it', async () => {
  const db = openDb(':memory:');
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO people (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('p_alex', 'Alex', stamp, stamp);
  const insert = db.prepare('INSERT INTO facts (person_id, kind, text, evidence, observed_at) VALUES (?, ?, ?, ?, ?)');
  const chosen = insert.run('p_alex', 'personal', 'Alex has a blue bicycle', '["bike-line"]', stamp).lastInsertRowid;
  insert.run('p_alex', 'health', 'Alex has a peanut allergy', '["allergy-line"]', stamp);
  await refreshCore(db, { async json() { return { selected: [chosen], outdated: [] }; } }, 'p_alex');
  const card = coreMemoryPages(db).find((p) => p.ref === 'P:p_alex');
  assert.match(card.text, /blue bicycle/);
  assert.deepEqual(card.evidence, ['bike-line']);
});

test('recall rejects a weekday absent from its cited utterance', async () => {
  const { db, bonsai } = await dockedDb();
  const sam = db.prepare("SELECT 'F' || rowid AS ref FROM facts WHERE text LIKE '%Coming for lunch%' LIMIT 1").get().ref;
  const lily = db.prepare("SELECT 'F' || rowid AS ref FROM facts WHERE text LIKE '%Allergic to peanuts%' LIMIT 1").get().ref;
  bonsai.script = [
    { action: 'answer', answer: 'Sam arrives Friday; avoid peanuts.', cite: [lily] },
    { action: 'answer', answer: 'Sam said he is coming Sunday around noon.', cite: [sam] },
  ];
  const result = await ask(db, bonsai, 'When is Sam coming and what should I avoid cooking?');
  assert.equal(result.trace.some((s) => s.action === 'answer_rejected'), true);
  assert.match(result.answer, /Sunday/);
});

test('translated directions are searchable while clips retain the original speech', async () => {
  const db = openDb(':memory:');
  enrollOwner(db, OWNER);
  const start = { type: 'session_start', session: 'travel1', startedAt: '2026-11-14T12:00:00Z' };
  const original = { type: 'utterance', session: 'travel1', id: 'travel1#0001', speaker: 'S1',
    start: 0, end: 4, text: 'Tournez à gauche après la pharmacie.', language: 'fr', audio: 'data/audio/travel1.wav' };
  ingestEvents(db, [start, original]);
  ingestEvents(db, [{ ...original, translation: 'Turn left after the pharmacy to reach the station.' }]);
  const found = search(db, 'pharmacy station');
  assert.ok(found.some((p) => p.ref === 'U:travel1#0001'));
  const bonsai = { async json({ name }) {
    if (name === 'extract') return { summary: 'Directions to the station past the pharmacy.', speakers: [], mentioned: [],
      facts: [{ about: 'OWNER', kind: 'directions', text: 'Turn left after the pharmacy to reach the station', when: null, evidence: ['travel1#0001'] }] };
    if (name === 'core_memory') return { selected: [], outdated: [] };
    throw new Error(name);
  } };
  await dock(db, bonsai);
  const clip = evidenceClips(db, ['travel1#0001'])[0];
  assert.equal(clip.text, original.text);
  assert.match(clip.translation, /pharmacy/);
  assert.equal(clip.language, 'fr');
  assert.equal(db.prepare("SELECT kind FROM facts WHERE session = 'travel1'").get().kind, 'directions');
});

test('local service identifies a voice from docked memory without a Bonsai call', async () => {
  const { db } = await dockedDb();
  const handler = createHandler(db, { async json() { throw new Error('Bonsai should not run for identify'); } });
  const live = readSessionFile(fx('day3-live-maya.jsonl')).find((e) => e.type === 'speaker');
  const req = Readable.from([JSON.stringify({ speaker: 'S1', voiceprint: live.voiceprint })]);
  Object.assign(req, { method: 'POST', url: '/identify' });
  let status, output;
  await handler(req, { writeHead(code) { status = code; }, end(text) { output = JSON.parse(text); } });
  assert.equal(status, 200);
  assert.equal(output.type, 'identity');
  assert.equal(output.name, 'Maya');
  assert.match(output.whisper, /^This is Maya/);
});

test('local service lists docked people read-only', async () => {
  const { db } = await dockedDb();
  const handler = createHandler(db, { async json() { throw new Error('Bonsai should not run for people'); } });
  const req = Readable.from([]);
  Object.assign(req, { method: 'GET', url: '/people' });
  let status, output;
  await handler(req, { writeHead(code) { status = code; }, end(text) { output = JSON.parse(text); } });
  assert.equal(status, 200);
  // Farhan's peopleGraph() shape (is_owner, voice_samples), which the app normalises.
  const maya = output.people.find((p) => p.name === 'Maya');
  assert.ok(maya, 'Maya is listed');
  assert.equal(maya.relation, 'neighbour');
  assert.equal(maya.is_owner, 0);
  assert.ok(maya.facts > 0);
  assert.equal(typeof maya.core, 'string');
  assert.equal(output.people[0].is_owner, 1, 'owner first');
  assert.ok(Array.isArray(output.relations));
});

test('local service enrolls the owner voice, then recognises it as the owner', async () => {
  const { db } = await dockedDb();
  const handler = createHandler(db, { async json() { throw new Error('Bonsai should not run for enroll-owner'); } });
  const call = async (url, body) => {
    const req = Readable.from([JSON.stringify(body)]);
    Object.assign(req, { method: 'POST', url });
    let status, output;
    await handler(req, { writeHead(code) { status = code; }, end(text) { output = JSON.parse(text); } });
    return { status, output };
  };
  const owner = db.prepare('SELECT v.samples FROM voices v JOIN people p ON p.id = v.person_id WHERE p.is_owner = 1').get();
  const mine = [0.95, 0.05, 0.04, 0.02, 0.14, 0.02, 0.08, 0.03]; // close to the fixture owner, like a real re-enrollment
  const first = await call('/enroll-owner', { voiceprint: mine });
  assert.equal(first.status, 200);
  assert.equal(first.output.samples, (owner?.samples ?? 0) + 1, 'one more sample folded into the owner voice');
  const again = await call('/enroll-owner', { voiceprint: mine });
  assert.equal(again.output.samples, first.output.samples + 1);
  assert.equal(again.output.personId, first.output.personId, 'same owner, no duplicate person');
  assert.equal(db.prepare('SELECT count(*) AS n FROM people WHERE is_owner = 1').get().n, 1);
  const who = await call('/identify', { speaker: 'L1', voiceprint: mine });
  assert.equal(who.output.owner, true);
  assert.equal(who.output.whisper, null, 'the owner is never whispered');
  assert.equal((await call('/enroll-owner', { voiceprint: 'nope' })).status, 400);
  assert.equal((await call('/enroll-owner', { voiceprint: [] })).status, 400);
});
