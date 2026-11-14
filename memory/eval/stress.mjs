// Scale check for memory storage, search, Bonsai vector indexing and paged recall.
// Synthetic vectors test plumbing only; --ask exercises real Bonsai tool calls on BM25.
import { performance } from 'node:perf_hooks';
import { openDb, json } from '../src/db.mjs';
import { Bonsai } from '../src/bonsai.mjs';
import { enrollOwner, upsertPerson } from '../src/identity.mjs';
import { ingestEvents } from '../src/ingest.mjs';
import { indexMemories } from '../src/embeddings.mjs';
import { search, hybridSearch } from '../src/retrieve.mjs';
import { ask } from '../src/recall.mjs';

const count = Number(process.argv.find((a) => a.startsWith('--count='))?.split('=')[1] ?? 1000);
if (!Number.isInteger(count) || count < 20 || count > 10_000) throw new Error('count must be 20–10000');
const target = Math.floor(count / 2);
const db = openDb(':memory:');
enrollOwner(db, [1, 0]);
const maya = upsertPerson(db, { name: 'Maya', relation: 'neighbour' });
const session = 'stress-day';
const events = [{ type: 'session_start', session, startedAt: '2026-11-14T09:00:00Z' }];
for (let i = 0; i < count; i++) {
  const special = i === target;
  events.push({ type: 'utterance', session, id: `${session}#${i}`, speaker: 'S1', start: i * 3, end: i * 3 + 2,
    text: special ? 'Could you water my tomato plants? The spare key is under the blue pot.'
      : `Person ${i} left a note about parcel ${i} at stop ${i % 40}.`, audio: 'data/audio/stress.wav' });
}
ingestEvents(db, events);
const insert = db.prepare('INSERT INTO facts (person_id, kind, text, evidence, session, observed_at) VALUES (?, ?, ?, ?, ?, ?)');
const index = db.prepare('INSERT INTO facts_fts (rowid, text, person, kind) VALUES (?, ?, ?, ?)');
for (let i = 0; i < count; i++) {
  const special = i === target;
  const fact = special ? 'Maya asked the owner to water her tomato plants; spare key under the blue pot'
    : `Person ${i} left a note about parcel ${i} at stop ${i % 40}`;
  const r = insert.run(special ? maya : null, special ? 'promise_by_owner' : 'other', fact,
    json([`${session}#${i}`]), session, '2026-11-14T09:00:00Z');
  index.run(r.lastInsertRowid, fact, special ? 'Maya' : '', special ? 'promise_by_owner' : 'other');
}
const t0 = performance.now();
const lexical = search(db, 'Where is Maya’s spare house key?', { limit: 6 });
const lexicalMs = performance.now() - t0;
const synthetic = { model: 'synthetic-scale-test', calls: 0, async embed(texts) {
  this.calls++;
  return (Array.isArray(texts) ? texts : [texts]).map((s) => /maya|tomato|spare key|garden/i.test(s) ? [1, 0] : [0, 1]);
} };
const t1 = performance.now();
const indexed = await indexMemories(db, synthetic);
const indexMs = performance.now() - t1;
const t2 = performance.now();
const hybrid = await hybridSearch(db, synthetic, 'Who needed help with their garden?', { k: 6 });
const hybridMs = performance.now() - t2;
const targetRef = `F${target + 1}`;
const report = { count, targetRef, lexicalTop: lexical[0]?.ref, lexicalMs,
  indexed: indexed.indexed, indexMs, hybridTop: hybrid[0]?.ref, hybridMs,
  hybridContainsTarget: hybrid.some((p) => p.ref === targetRef),
  note: 'Synthetic vectors measure storage and ranking plumbing, not Bonsai semantic accuracy.' };
if (process.argv.includes('--ask')) {
  const bonsai = new Bonsai();
  bonsai.embed = undefined; // current server lacks embedding mode; real chat/tool calls still run
  const t3 = performance.now();
  const question = process.argv.includes('--paraphrase') ? 'Did anyone need help with their garden?' : 'Where is Maya’s spare house key?';
  const result = await ask(db, bonsai, question);
  report.realAsk = { question, answer: result.answer, grounded: result.grounded,
    citesTarget: result.clips.some((c) => c.id === `${session}#${target}`),
    ms: performance.now() - t3, tools: bonsai.calls.map((c) => c.tool || c.name) };
}
console.log(JSON.stringify(report, null, 2));
