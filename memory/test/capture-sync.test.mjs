import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { recoverCapturedSessions } from '../src/capture-sync.mjs';
import { search } from '../src/retrieve.mjs';
import { createHandler } from '../src/server.mjs';
import { enrollOwner } from '../src/identity.mjs';
import { ingestEvents } from '../src/ingest.mjs';
import { dock } from '../src/dock.mjs';

test('completed recorded conversations recover after restart; incomplete files wait', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kindred-recover-'));
  const inbox = path.join(root, 'inbox');
  mkdirSync(inbox);
  const db = openDb(path.join(root, 'memory.sqlite'));
  const moments = [
    ['key', 'The spare key is in the blue kitchen drawer.'],
    ['doctor', 'Dr. Patel changed the appointment to Tuesday at two.'],
    ['garden', 'Maya asked me to water her tomato plants.'],
    ['medicine', 'The new medicine is called lisinopril.'],
    ['directions', 'Gire a la derecha en la torre del reloj.', 'Turn right at the clock tower.'],
  ];
  try {
    for (const [id, text, translation] of moments) {
      const session = `demo-${id}`;
      const events = [
        { type: 'session_start', session, startedAt: '2026-11-15T12:00:00Z' },
        { type: 'utterance', session, id: `${session}#0001`, speaker: 'S0', start: 0, end: 3,
          text, translation, language: translation ? 'es' : 'en', audio: `data/audio/${session}.wav` },
        { type: 'session_end', session, endedAt: '2026-11-15T12:00:03Z' },
      ];
      writeFileSync(path.join(inbox, `${session}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    writeFileSync(path.join(inbox, 'unfinished.jsonl'), JSON.stringify({ type: 'session_start', session: 'unfinished' }));
    const first = recoverCapturedSessions(db, inbox);
    assert.equal(first.recovered.length, 5);
    assert.deepEqual(first.skipped, ['unfinished.jsonl']);
    assert.equal(recoverCapturedSessions(db, inbox).recovered.length, 0, 'recovery is idempotent');
    for (const [id] of moments) {
      assert.equal(db.prepare('SELECT count(*) n FROM utterances WHERE session = ?').get(`demo-${id}`).n, 1);
    }
    assert.equal(search(db, 'spare key')[0].ref, 'U:demo-key#0001');
    assert.equal(search(db, 'appointment Tuesday')[0].ref, 'U:demo-doctor#0001');
    assert.equal(search(db, 'tomato plants')[0].ref, 'U:demo-garden#0001');
    assert.equal(search(db, 'lisinopril')[0].ref, 'U:demo-medicine#0001');
    assert.equal(search(db, 'clock tower')[0].ref, 'U:demo-directions#0001');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('retrying a partly docked recording does not duplicate earlier facts', async () => {
  const db = openDb(':memory:');
  enrollOwner(db, [1, 0, 0]);
  ingestEvents(db, [
    { type: 'session_start', session: 'retry', startedAt: '2026-11-15T12:00:00Z' },
    { type: 'utterance', session: 'retry', id: 'retry#0001', text: 'The key is in the blue drawer.', start: 0, end: 3 },
    { type: 'utterance', session: 'retry', id: 'retry#0002', text: 'The appointment is Tuesday afternoon.', start: 70, end: 73 },
    { type: 'session_end', session: 'retry', endedAt: '2026-11-15T12:01:13Z' },
  ]);
  let failed = false;
  const bonsai = {
    async capabilities() { return { embeddings: false }; },
    async json({ name, user }) {
      if (name === 'core_memory') return { selected: [], outdated: [] };
      const id = user.match(/\[(retry#\d+)\]/)?.[1];
      if (id === 'retry#0002' && !failed) { failed = true; throw new Error('model interrupted'); }
      return { summary: user, speakers: [], mentioned: [], facts: [
        { about: 'OWNER', people: ['OWNER'], kind: 'other', text: id === 'retry#0001' ? 'The key is in the blue drawer.' : 'The appointment is Tuesday afternoon.',
          when: null, evidence: [id] },
      ] };
    },
  };
  try {
    await assert.rejects(dock(db, bonsai), /model interrupted/);
    assert.equal(db.prepare('SELECT count(*) n FROM facts').get().n, 1);
    const report = await dock(db, bonsai);
    assert.equal(report.sessions.length, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM facts').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM episodes').get().n, 2);
  } finally { db.close(); }
});

test('automatic sync docks five recorded topics into citable facts', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kindred-dock-'));
  const inbox = path.join(root, 'inbox');
  mkdirSync(inbox);
  const db = openDb(path.join(root, 'memory.sqlite'));
  enrollOwner(db, [1, 0, 0]);
  const topics = [
    ['key', 'The spare key is in the blue kitchen drawer.'],
    ['doctor', 'Dr. Patel changed the appointment to Tuesday at two.'],
    ['garden', 'Maya asked me to water her tomato plants.'],
    ['medicine', 'The new medicine is called lisinopril.'],
    ['directions', 'Turn right at the clock tower.'],
  ];
  const bonsai = {
    async capabilities() { return { embeddings: false, dim: null }; },
    async json({ name, user }) {
      if (name === 'core_memory') return { selected: [], outdated: [] };
      assert.equal(name, 'extract');
      const id = user.match(/\[(demo-[^#]+#0001)\]/)?.[1];
      const text = topics.find(([key]) => id === `demo-${key}#0001`)?.[1];
      assert.ok(text, `unexpected episode ${user}`);
      return { summary: text, speakers: [], mentioned: [], facts: [
        { about: 'OWNER', people: ['OWNER'], kind: 'other', text, when: null, evidence: [id] },
      ] };
    },
  };
  try {
    for (const [key, text] of topics) {
      const session = `demo-${key}`;
      writeFileSync(path.join(inbox, `${session}.jsonl`), [
        { type: 'session_start', session, startedAt: '2026-11-15T12:00:00Z' },
        { type: 'utterance', session, id: `${session}#0001`, speaker: 'S0', start: 0, end: 3, text,
          audio: `data/audio/${session}.wav` },
        { type: 'session_end', session, endedAt: '2026-11-15T12:00:03Z' },
      ].map((e) => JSON.stringify(e)).join('\n'));
    }
    const handler = createHandler(db, bonsai, { inbox });
    const synced = await handler.syncCaptured();
    assert.equal(synced.recovered.length, 5);
    assert.equal(synced.report.sessions.length, 5);
    assert.equal(synced.report.facts, 5);
    for (const [key, term] of [['key', 'spare key'], ['doctor', 'appointment Tuesday'],
      ['garden', 'tomato plants'], ['medicine', 'lisinopril'], ['directions', 'clock tower']]) {
      const hits = search(db, term);
      assert.ok(hits.some((hit) => hit.layer === 'fact' && hit.evidence.includes(`demo-${key}#0001`)), key);
    }
    assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE docked = 1').get().n, 5);
    assert.equal((await handler.syncCaptured()).report, null, 'repeat sync does not redock');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
