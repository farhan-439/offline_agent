// End-to-end tests of the memory pipeline against the contract fixtures.
// The Bonsai here is a scripted test double: these tests prove the plumbing
// (grounding, identity binding, paging, citations), NOT Bonsai's accuracy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { ingestFile, readSessionFile } from '../src/ingest.mjs';
import { enrollOwner, identify, cosine } from '../src/identity.mjs';
import { dock, segment, sensoryFilter } from '../src/dock.mjs';
import { search } from '../src/retrieve.mjs';
import { ask, WORKING_BUDGET } from '../src/recall.mjs';
import { whoIsThis } from '../src/whisper.mjs';

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
    if (name === 'core_memory') return { core: `core for ${user.match(/Person: ([^\n(]+)/)[1].trim()}`, outdated: [] };
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
  assert.equal(db.prepare("SELECT how FROM clusters WHERE session = 'd1-porch' AND speaker = 'S1'").get().how, 'named');
  assert.ok(db.prepare("SELECT core FROM people WHERE name = 'Maya'").get().core.startsWith('core for Maya'));
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
  assert.equal(r.trace[1].action, 'search');
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
