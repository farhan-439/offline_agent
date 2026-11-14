// Summarise a compare-<timestamp>.json run: per-mode accuracy with the strict scoring rule
// (a refusal is never a correct answer, whatever keywords it contains) plus latency and failures.
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

const dir = path.join(import.meta.dirname, 'results');
const file = process.argv[2] ?? readdirSync(dir).filter((f) => f.startsWith('compare-')).sort().at(-1);
if (!file) throw new Error('no compare-*.json found; run `npm run compare` first');
const data = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));

const refused = (a) => /couldn['’]?t find|don['’]?t remember|do not remember|nothing in my memory|not in my memory/i.test(String(a ?? ''));
const byMode = {};
for (const run of data.runs) {
  const key = run.mode;
  const m = (byMode[key] ??= { mode: key, runs: 0, questions: 0, answer: 0, evidence: 0, both: 0, refusals: 0, latencies: [], failures: [] });
  m.runs++;
  for (const r of run.rows) {
    m.questions++;
    const ok = r.correct && !refused(r.answer);
    if (!ok) m.failures.push({ mode: key, rep: run.rep, question: r.question, answer: r.answer, grounded: r.grounded, cited: r.citedEvidence, expected: r.expectedEvidence });
    if (refused(r.answer)) m.refusals++;
    if (ok) m.answer++;
    if (r.grounded) m.evidence++;
    if (ok && r.grounded) m.both++;
    m.latencies.push(r.ms);
  }
}
const rows = Object.values(byMode).map((m) => {
  m.latencies.sort((a, b) => a - b);
  return {
    mode: m.mode,
    runs: m.runs,
    answerAcc: +(m.answer / m.questions).toFixed(2),
    evidenceAcc: +(m.evidence / m.questions).toFixed(2),
    bothAcc: +(m.both / m.questions).toFixed(2),
    refusals: m.refusals,
    medianMs: m.latencies[Math.floor(m.latencies.length / 2)],
    answer: m.answer,
    evidence: m.evidence,
    both: m.both,
    questions: m.questions,
    failures: m.failures,
  };
});
console.log(`file: ${file}`);
console.log('mode            answer  evidence  both   refusals  median ms');
for (const r of rows) {
  console.log(`${r.mode.padEnd(15)} ${String(r.answer + '/' + r.questions).padEnd(7)} ${String(r.evidence + '/' + r.questions).padEnd(9)} ${String(r.both + '/' + r.questions).padEnd(6)} ${String(r.refusals).padEnd(9)} ${r.medianMs}`);
}
const failures = rows.flatMap((r) => r.failures);
console.log(`\n${failures.length} failing question-runs in total`);
for (const f of failures.slice(0, 25)) {
  console.log(`- [${f.mode} #${f.rep}] ${f.question}\n    answer: ${String(f.answer).slice(0, 160)}\n    grounded: ${f.grounded}; expected ${f.expected.join(',')}; cited ${f.cited.join(',') || '-'}`);
}
