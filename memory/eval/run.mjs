// Real Bonsai fixture evaluation. Run with the server on localhost.
// `--mode=bm25|hybrid|hybrid-rerank` selects the retrieval pipeline; language generation is
// always Bonsai. The mode that actually ran (and whether it degraded) is printed with results.
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { Bonsai } from '../src/bonsai.mjs';
import { ingestFile } from '../src/ingest.mjs';
import { enrollOwner } from '../src/identity.mjs';
import { dock } from '../src/dock.mjs';
import { ask } from '../src/recall.mjs';
import { resolveMode, describeMode } from '../src/capabilities.mjs';

export const QUESTIONS = [
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

export function fixtures(db) {
  enrollOwner(db, [0.96, 0.04, 0.03, 0.02, 0.13, 0.02, 0.09, 0.02]);
  for (const f of ['day1-porch-maya.jsonl', 'day1-clinic-patel.jsonl', 'day2-call-sam.jsonl'])
    ingestFile(db, path.join(root, 'contract/fixtures', f));
}

/** Run one full fixture day in one retrieval mode. Returns per-question rows and timing. */
export async function runMode(mode, { db = openDb(':memory:'), bonsai = new Bonsai(), today = '2026-11-13' } = {}) {
  fixtures(db);
  const started = Date.now();
  const dockReport = await dock(db, bonsai, { mode });
  const dockMs = Date.now() - started;
  const rows = [];
  for (const c of QUESTIONS) {
    const t0 = Date.now();
    let r;
    try {
      r = await ask(db, bonsai, c.q, { today, mode });
    } catch (e) {
      rows.push({ question: c.q, error: e.message, ms: Date.now() - t0 });
      continue;
    }
    const answer = String(r.answer).toLowerCase();
    // A refusal that happens to contain the keywords is not a correct answer.
    const refused = /couldn['’]?t find|don['’]?t remember|do not remember|nothing in my memory|not in my memory/.test(answer);
    const correct = !refused && c.words.every((w) => answer.includes(w));
    const cited = new Set(r.clips.map((clip) => clip.id));
    const grounded = c.evidence.every((id) => cited.has(id));
    rows.push({ question: c.q, answer: r.answer, correct, refused, grounded, mode: r.mode,
      expectedEvidence: c.evidence, citedEvidence: [...cited], ms: Date.now() - t0, steps: r.trace.length });
  }
  return { mode, dockReport, dockMs, rows, bonsaiCalls: bonsai.calls };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isCli) {
const modeArg = process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1];
const db = openDb(':memory:');
const bonsai = new Bonsai();
const resolved = await resolveMode(bonsai);
console.log(`retrieval: ${describeMode(resolved)}`);

const started = Date.now();
const report = await runMode(modeArg ?? resolved.mode, { db, bonsai });

for (const r of report.rows) {
  const mark = (b) => (b ? '✓' : '✗');
  console.log(`${mark(r.correct)} answer  ${mark(r.grounded)} evidence  ${r.question} (${r.ms} ms)`
    + (r.correct && r.grounded ? '' : `\n     → ${r.answer ?? r.error}`));
}
const sum = (key) => report.rows.filter((r) => r[key]).length;
const totals = Object.values(report.bonsaiCalls.reduce((acc, c) => {
  const key = c.tool ? `${c.name}:${c.tool}` : c.name;
  const row = (acc[key] ??= { name: key, count: 0, ms: 0 });
  row.count++;
  row.ms += c.ms;
  return acc;
}, {}));
const summary = {
  mode: report.mode,
  requested: resolved.requested,
  degraded: resolved.degraded,
  embeddings: resolved.caps,
  questions: report.rows.length,
  answerCorrect: sum('correct'),
  evidenceCorrect: sum('grounded'),
  both: report.rows.filter((r) => r.correct && r.grounded).length,
  errors: report.rows.filter((r) => r.error).length,
  refused: report.rows.filter((r) => r.refused).length,
  dock: { sessions: report.dockReport.sessions.length, facts: report.dockReport.facts,
    duplicates: report.dockReport.duplicates, superseded: report.dockReport.superseded,
    rejectedNames: report.dockReport.rejected_names, embeddings: report.dockReport.embeddings ?? null, ms: report.dockMs },
  latencyMs: {
    total: Date.now() - started,
    perQuestion: report.rows.map((r) => r.ms),
    median: [...report.rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(report.rows.length / 2)] ?? null,
  },
  bonsaiCalls: totals,
};
console.log(JSON.stringify({ summary, results: report.rows }, null, 2));
}
