import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { openDb } from '../src/db.mjs';
import { addInput } from '../src/inputs.mjs';
import { search, hybridSearch } from '../src/retrieve.mjs';
import { ask, repairCitations } from '../src/recall.mjs';
import { createHandler } from '../src/server.mjs';

const model = {
  model: 'test-bonsai',
  async capabilities() { return { embeddings: true, dim: 3, reason: null }; },
  async embed(values) {
    return (Array.isArray(values) ? values : [values]).map((value) =>
      /key|flower pot/i.test(value) ? [1, 0, 0] : [0, 1, 0]);
  },
  async memoryAction() {
    return { action: 'answer', answer: 'The key is under the blue flower pot.', cite: ['N1'] };
  },
};

test('typed input is searchable by exact terms and Bonsai vector, then cited in an answer', async () => {
  const db = openDb(':memory:');
  const saved = await addInput(db, model, 'The spare key is under the blue flower pot.');
  assert.equal(saved.id, 'N1');
  assert.equal(saved.indexed, true);
  assert.equal(search(db, 'spare key')[0].ref, 'N1');
  assert.equal((await hybridSearch(db, model, 'Where is the house key?'))[0].ref, 'N1');
  const result = await ask(db, model, 'Where is the house key?', { mode: 'hybrid', persistTrace: false });
  assert.equal(result.grounded, true);
  assert.deepEqual(result.cites, ['N1']);
  assert.equal(result.inputs[0].text, saved.text);
  assert.deepEqual(result.sources.map((source) => source.ref), ['N1']);
  assert.equal(result.sources[0].text, saved.text);
  db.close();
});

test('typed input stays searchable when Bonsai embeddings are unavailable', async () => {
  const db = openDb(':memory:');
  const unavailable = { model: 'test-bonsai', async capabilities() { return { embeddings: false, dim: null, reason: '501' }; } };
  const saved = await addInput(db, unavailable, 'Maya needs the tomato plants watered.');
  assert.equal(saved.indexed, false);
  assert.equal(search(db, 'tomato plants')[0].ref, 'N1');
  db.close();
});

async function request(handler, method, url, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(req, { method, url });
  const res = {
    status: null, headers: null, chunks: [],
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(value) { if (value) this.chunks.push(value); },
  };
  await handler(req, res);
  const text = Buffer.concat(res.chunks.map((chunk) => Buffer.from(chunk))).toString();
  return { status: res.status, headers: res.headers, text, json: res.headers['content-type']?.includes('json') ? JSON.parse(text) : null };
}

test('local lab serves the page and accepts inputs through its HTTP API', async () => {
  const db = openDb(':memory:');
  const handler = createHandler(db, model);
  const page = await request(handler, 'GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Your inputs/i);
  assert.equal((await request(handler, 'GET', '/lab.js')).status, 200);
  assert.equal((await request(handler, 'GET', '/lab.css')).status, 200);
  assert.equal((await request(handler, 'POST', '/input', { text: '   ' })).status, 400);
  const saved = await request(handler, 'POST', '/input', { text: 'The spare key is under the blue flower pot.' });
  assert.equal(saved.json.id, 'N1');
  const listed = await request(handler, 'GET', '/inputs');
  assert.equal(listed.json.inputs[0].text, saved.json.text);
  const answer = await request(handler, 'POST', '/ask', { question: 'Where is the house key?', mode: 'hybrid' });
  assert.equal(answer.json.inputs[0].id, 'N1');
  db.close();
});

test('answer evidence uses the folder input that actually supports the claim', async () => {
  const db = openDb(':memory:');
  const unavailable = { model: 'test-bonsai', async capabilities() { return { embeddings: false, dim: null }; } };
  await addInput(db, unavailable, 'The yellow folder contains tax receipts; the blue folder contains clinic papers.');
  await addInput(db, unavailable, 'I put the blue folder in the top desk drawer.');
  await addInput(db, unavailable, 'My reading glasses are in the fabric pouch in my backpack front pocket.');
  const scripted = { ...unavailable, async memoryAction() {
    return { action: 'answer', answer: 'The yellow folder has your tax receipts, and your reading glasses are in the fabric pouch in your backpack front pocket.', cite: ['N2', 'N3'] };
  } };
  const result = await ask(db, scripted, 'Which folder has tax receipts and where are my reading glasses?', { mode: 'bm25', persistTrace: false });
  assert.deepEqual(result.cites, ['N1', 'N3']);
  assert.deepEqual(result.inputs.map((input) => input.id), ['N1', 'N3']);
  assert.deepEqual(repairCitations('The red folder contains tax receipts.', 'Which folder has tax receipts?', [], [
    { ref: 'N1', text: 'The blue folder contains clinic papers. The yellow folder contains tax receipts. The red folder contains travel documents.' },
  ]), [], 'words from different sentences must not be combined into false evidence');
  db.close();
});

test('an unsupported event date is not returned by the final fallback', async () => {
  const db = openDb(':memory:');
  const unavailable = { model: 'test-bonsai', async capabilities() { return { embeddings: false, dim: null }; } };
  await addInput(db, unavailable, 'I ordered a replacement kettle, order number KT-9042.');
  await addInput(db, unavailable, 'The kettle delivery was expected on November 21, 2026.');
  await addInput(db, unavailable, 'The courier left the kettle package with building manager Tomas, not at my door.');
  const scripted = { ...unavailable,
    async memoryAction() { return { action: 'answer', answer: 'The courier left it with Tomas on November 15, 2026.', cite: ['N2'] }; },
    async json({ name }) { if (name === 'final_answer') return { answer: 'The courier left it with Tomas on November 15, 2026.', cite: [] }; throw new Error(name); },
  };
  const result = await ask(db, scripted, 'When did the courier leave the replacement kettle?', { mode: 'bm25', persistTrace: false });
  assert.doesNotMatch(result.answer, /November 15/);
  assert.match(result.answer, /can't verify when/i);
  assert.deepEqual(result.cites, ['N3']);
  assert.equal(result.grounded, true);
  db.close();
});
