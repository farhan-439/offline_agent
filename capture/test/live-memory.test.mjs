// LiveWhisper against the REAL memory HTTP handler (memory/src/server.mjs) on a scratch DB, so
// the /identify and /ingest request/response shapes are checked against Farhan's actual code.
// Voiceprints are synthetic 256-dim vectors; no Bonsai server is needed (/identify doesn't call it).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { LiveWhisper } from '../live.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kindred-live-mem-'));
process.env.KINDRED_DB = path.join(dir, 'kindred.sqlite');
const { openDb } = await import('../../memory/src/db.mjs');
const { createHandler } = await import('../../memory/src/server.mjs');
const { upsertPerson, enrollVoice, enrollOwner } = await import('../../memory/src/identity.mjs');

// Seeded pseudo-random unit vectors: different seeds are near-orthogonal, like different voices.
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 - 0.5; };
const norm = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const unit = (seed) => { const r = rng(seed); return norm(Array.from({ length: 256 }, r)); };
const near = (v, eps) => { const r = rng(99); return norm(v.map((x) => x + eps * r() / 16)); };

const db = openDb(process.env.KINDRED_DB);
const maya = upsertPerson(db, { name: 'Maya', relation: 'neighbour' });
const mayaId = typeof maya === 'string' ? maya : maya.id;
enrollVoice(db, mayaId, unit(1));
enrollOwner(db, unit(2));
const server = http.createServer(createHandler(db, null));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function make() {
  const spoken = [];
  const live = new LiveWhisper({ memoryUrl: url, bridge: { speak: async (t) => spoken.push(t) } });
  return { live, spoken };
}

test('a live voiceprint close to Maya\'s is identified and whispered', async () => {
  const { live, spoken } = make();
  const id = await live.handleSpeaker({ speaker: 'L1', voiceprint: near(unit(1), 0.05), final: false });
  await live.speaking;
  assert.equal(id.name, 'Maya');
  assert.ok(id.score >= 0.85, `score ${id.score}`);
  assert.equal(spoken.length, 1);
  assert.match(spoken[0], /Maya/);
});

test('the owner\'s voice is recognised and stays silent', async () => {
  const { live, spoken } = make();
  const id = await live.handleSpeaker({ speaker: 'L2', voiceprint: near(unit(2), 0.05), final: false });
  assert.equal(id.owner, true);
  assert.equal(spoken.length, 0);
});

test('a stranger\'s voice is unknown', async () => {
  const { live, spoken } = make();
  const id = await live.handleSpeaker({ speaker: 'L3', voiceprint: unit(7), final: false });
  assert.equal(id.personId, null);
  assert.equal(spoken.length, 0);
});

test('a finished session file is accepted by /ingest', async () => {
  const { live } = make();
  const file = path.join(dir, 's-live.jsonl');
  writeFileSync(file, [
    { type: 'session_start', session: 's-live', startedAt: '2026-11-14T18:00:00Z' },
    { type: 'utterance', session: 's-live', id: 's-live#0001', speaker: 'S1', start: 0, end: 2, text: 'Hi, it is Maya again.', audio: 'data/audio/s-live.wav' },
    { type: 'speaker', session: 's-live', speaker: 'S1', voiceprint: unit(1), seconds: 2, final: true },
    { type: 'session_end', session: 's-live', endedAt: '2026-11-14T18:00:05Z' },
  ].map((e) => JSON.stringify(e)).join('\n'));
  const r = await live.ingest({ jsonl: file });
  assert.deepEqual(r.sessions, ['s-live']);
});

test('a translated session file keeps language + translation in memory (real capture output shape)', async () => {
  const { live } = make();
  const file = path.join(dir, 's-fr.jsonl');
  // Lines as `process --translate` wrote them for a French `say -v Thomas` clip (11/14).
  writeFileSync(file, [
    { type: 'session_start', session: 's-fr', startedAt: '2026-11-14T19:00:00Z' },
    { type: 'utterance', session: 's-fr', id: 's-fr#0001', speaker: 'S1', start: 0, end: 3.6, language: 'en', text: 'Could you tell me where the train station is?', audio: 'data/audio/s-fr.wav' },
    { type: 'utterance', session: 's-fr', id: 's-fr#0002', speaker: 'S0', start: 4.53, end: 10.53, language: 'fr',
      text: 'Bonjour, excusez-moi, la gare est à 10 minutes à pied. Prenez la deuxième rue à gauche.',
      translation: 'Hello, excuse me, the station is 10 minutes away, take the second left street.', audio: 'data/audio/s-fr.wav' },
    { type: 'speaker', session: 's-fr', speaker: 'S0', voiceprint: unit(5), seconds: 6, final: true },
    { type: 'speaker', session: 's-fr', speaker: 'S1', voiceprint: unit(2), seconds: 3.6, final: true },
    { type: 'session_end', session: 's-fr', endedAt: '2026-11-14T19:00:12Z' },
  ].map((e) => JSON.stringify(e)).join('\n'));
  const r = await live.ingest({ jsonl: file });
  assert.deepEqual(r.sessions, ['s-fr']);
  const row = db.prepare('SELECT language, translation FROM utterances WHERE id = ?').get('s-fr#0002');
  assert.equal(row.language, 'fr');
  assert.match(row.translation, /station/);
  const hit = db.prepare("SELECT u.id FROM utterances_fts f JOIN utterances u ON u.rowid = f.rowid WHERE utterances_fts MATCH 'station' AND u.session = 's-fr' ORDER BY u.id").all();
  assert.deepEqual(hit.map((h) => h.id), ['s-fr#0001', 's-fr#0002']);
});
