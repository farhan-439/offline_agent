import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { addInput } from '../src/inputs.mjs';
import { ask, followUpContext } from '../src/recall.mjs';

test('a follow-up reopens the previous cited memory and keeps the subject', async () => {
  const db = openDb(':memory:');
  const prompts = [];
  const bonsai = {
    async capabilities() { return { embeddings: false }; },
    async json({ name, user }) {
      assert.equal(name, 'recall_step');
      prompts.push(user);
      return { action: 'answer', answer: 'The apple is blue.', cite: ['N1'] };
    },
  };
  try {
    await addInput(db, bonsai, 'The apple on the table is blue.');
    const first = await ask(db, bonsai, 'What color is the apple?', { mode: 'bm25', persistTrace: false });
    assert.equal(first.grounded, true);
    assert.deepEqual(first.cites, ['N1']);
    const second = await ask(db, bonsai, 'What color again?', { mode: 'bm25', persistTrace: false,
      history: [{ question: 'What color is the apple?', cites: first.cites }] });
    assert.equal(second.answer, 'The apple is blue.');
    assert.deepEqual(second.cites, ['N1']);
    assert.ok(second.trace.some((step) => step.action === 'follow_up'));
    assert.match(prompts.at(-1), /PREVIOUS QUESTION.*apple/);
    assert.match(prompts.at(-1), /\[N1\].*apple.*blue/i);
    assert.equal(followUpContext('Where is my jacket?', [{ question: 'What color is the apple?', cites: ['N1'] }]), null);
    assert.deepEqual(followUpContext('What color again?', [{ question: 'What is in the photo?', cites: ['PHOTO:p1'] }])?.cites, ['PHOTO:p1']);
  } finally { db.close(); }
});
