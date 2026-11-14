// Real Bonsai fixture evaluation. Run with the server on localhost.
// `--bm25` is a retrieval ablation; all language generation still uses Bonsai.
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { Bonsai } from '../src/bonsai.mjs';
import { ingestFile } from '../src/ingest.mjs';
import { enrollOwner } from '../src/identity.mjs';
import { dock } from '../src/dock.mjs';
import { ask } from '../src/recall.mjs';

const cases = [
  { q: 'Did anyone need help with their garden?', words: ['water', 'maya'], evidence: ['d1-porch#0005'] },
  { q: 'Where is the spare house key?', words: ['blue', 'pot'], evidence: ['d1-porch#0005'] },
  { q: 'Who is having an operation soon?', words: ['maya'], evidence: ['d1-porch#0003'] },
  { q: 'Where is Maya having surgery?', words: ['mercy'], evidence: ['d1-porch#0003'] },
  { q: 'What did the doctor change about my medication?', words: ['lisinopril', 'ten'], evidence: ['d1-clinic#0002'] },
  { q: 'How often do I take the new dose?', words: ['morning'], evidence: ['d1-clinic#0002'] },
  { q: 'What should I avoid with my blood pressure medicine?', words: ['potassium', 'grapefruit'], evidence: ['d1-clinic#0004'] },
  { q: 'When is my follow-up with Dr. Patel?', words: ['december', 'third'], evidence: ['d1-clinic#0005'] },
  { q: 'When is Sam coming and is there anything I should not cook?', words: ['sunday', 'noon', 'peanut'], evidence: ['d2-call#0003', 'd2-call#0004'] },
  { q: 'Who has a peanut allergy?', words: ['lily'], evidence: ['d2-call#0004'] },
];

const root = path.resolve(import.meta.dirname, '../..');
const db = openDb(':memory:');
const bonsai = new Bonsai();
if (process.argv.includes('--bm25')) bonsai.embed = undefined;
enrollOwner(db, [0.96, 0.04, 0.03, 0.02, 0.13, 0.02, 0.09, 0.02]);
for (const f of ['day1-porch-maya.jsonl', 'day1-clinic-patel.jsonl', 'day2-call-sam.jsonl'])
  ingestFile(db, path.join(root, 'contract/fixtures', f));

const started = Date.now();
const dockReport = await dock(db, bonsai);
const results = [];
const caseArg = process.argv.find((arg) => arg.startsWith('--case='));
const selectedCases = caseArg ? [cases[Number(caseArg.split('=')[1])]].filter(Boolean) : cases;
for (const c of selectedCases) {
  const t0 = Date.now();
  const r = await ask(db, bonsai, c.q, { today: '2026-11-13' });
  const answer = r.answer.toLowerCase();
  const correct = c.words.every((w) => answer.includes(w));
  const cited = new Set(r.clips.map((clip) => clip.id));
  const grounded = c.evidence.every((id) => cited.has(id));
  results.push({ question: c.q, answer: r.answer, correct, grounded, expectedEvidence: c.evidence,
    citedEvidence: [...cited], ms: Date.now() - t0, calls: r.trace.length });
  console.log(`${correct ? '✓' : '✗'} answer  ${grounded ? '✓' : '✗'} evidence  ${c.q} (${results.at(-1).ms} ms)`);
}
const sum = (key) => results.filter((r) => r[key]).length;
const callStats = Object.values(bonsai.calls.reduce((acc, c) => {
  const key = c.tool ? `${c.name}:${c.tool}` : c.name;
  const row = (acc[key] ??= { name: key, count: 0, ms: 0 });
  row.count++;
  row.ms += c.ms;
  return acc;
}, {}));
const summary = { mode: process.argv.includes('--bm25') ? 'bm25' : 'bonsai_hybrid',
  questions: selectedCases.length, answerCorrect: sum('correct'), evidenceCorrect: sum('grounded'),
  both: results.filter((r) => r.correct && r.grounded).length,
  dock: { sessions: dockReport.sessions.length, facts: dockReport.facts, embeddings: dockReport.embeddings ?? null },
  totalMs: Date.now() - started, bonsaiCalls: callStats,
};
console.log(JSON.stringify({ summary, results }, null, 2));
