import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { includeReplyEvents } from '../core.mjs';
import { openDb } from '../../memory/src/db.mjs';
import { ingestEvents } from '../../memory/src/ingest.mjs';
import { search } from '../../memory/src/retrieve.mjs';

test('a translated reply joins the saved session and can be recalled in English or Spanish', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kindred-reply-memory-'));
  const inbox = path.join(root, 'data/inbox');
  mkdirSync(inbox, { recursive: true });
  const file = path.join(inbox, 'session.jsonl');
  const original = [
    { type: 'session_start', session: 'session', startedAt: '2026-11-15T12:00:00Z' },
    { type: 'utterance', session: 'session', id: 'session#0001', speaker: 'S0', text: '¿Dónde está la estación?', language: 'es', translation: 'Where is the station?' },
    { type: 'session_end', session: 'session', endedAt: '2026-11-15T12:00:05Z' },
  ];
  writeFileSync(file, original.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const reply = { english: 'Turn right at the clock tower.', translated: 'Gire a la derecha en la torre del reloj.', language: 'es', at: 10_000 };
  const db = openDb(':memory:');
  try {
    assert.equal(includeReplyEvents(file, 'session', [reply], root, 0), 1);
    assert.equal(includeReplyEvents(file, 'session', [reply], root), 0);
    const events = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events.at(-1).type, 'session_end');
    assert.equal(events[2].speaker, 'OWNER');
    assert.equal(events[2].start, 10);
    ingestEvents(db, events);
    assert.ok(search(db, 'clock tower').some((hit) => hit.ref === 'U:session#reply0001'));
    assert.ok(search(db, 'torre reloj').some((hit) => hit.ref === 'U:session#reply0001'));
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
