import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { rememberMemory, listMemories } from '../src/memories.mjs';
import { ingestEvents } from '../src/ingest.mjs';
import { dock } from '../src/dock.mjs';
import { search } from '../src/retrieve.mjs';
import { ask } from '../src/recall.mjs';

test('a recorded object fact without a known person becomes miscellaneous and stays citeable', async () => {
  const db = openDb(':memory:');
  const model = {
    async capabilities() { return { embeddings: false }; },
    async json({ name }) {
      if (name === 'extract') return { summary: 'The apple on the table is blue.', speakers: [], mentioned: [], facts: [
        { about: 'MISC', people: [], kind: 'miscellaneous', text: 'The apple on the table is blue.', when: null, evidence: ['s-apple#0001'] },
      ] };
      if (name === 'recall_step') return { action: 'answer', answer: 'The apple is blue.', cite: ['F1'] };
      throw new Error(`unexpected ${name}`);
    },
  };
  try {
    ingestEvents(db, [
      { type: 'session_start', session: 's-apple', startedAt: '2026-11-15T12:00:00Z' },
      { type: 'utterance', session: 's-apple', id: 's-apple#0001', text: 'The apple on the table is blue.', speaker: 'S0', start: 0, end: 2 },
      { type: 'session_end', session: 's-apple', endedAt: '2026-11-15T12:00:02Z' },
    ]);
    await dock(db, model);
    const memory = listMemories(db)[0];
    assert.equal(memory.kind, 'miscellaneous');
    assert.equal(memory.person, null);
    assert.deepEqual(memory.source.utterances, ['s-apple#0001']);
    assert.ok(search(db, 'apple color').some((hit) => hit.ref === 'F1'));
    const answer = await ask(db, model, 'What color is the apple?', { mode: 'bm25', persistTrace: false });
    assert.deepEqual(answer.cites, ['F1']);
    assert.equal(answer.grounded, true);
  } finally { db.close(); }
});

test('an unassigned explicit memory is miscellaneous and is a direct user source', async () => {
  const db = openDb(':memory:');
  try {
    const memory = await rememberMemory(db, null, { text: 'The apple on the table is blue.' });
    assert.equal(memory.person, null);
    assert.equal(memory.kind, 'miscellaneous');
    assert.equal(memory.origin, 'user');
    assert.equal(search(db, 'apple blue')[0].ref, memory.ref);
  } finally { db.close(); }
});
