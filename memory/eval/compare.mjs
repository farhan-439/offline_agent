// App-level comparison: the real Bonsai 4B runs the whole pipeline in each retrieval mode,
// repeated, with a fresh database every time (dock included, because extraction varies).
// Writes eval/results/compare-<timestamp>.json so numbers in the docs are reproducible.
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openDb } from '../src/db.mjs';
import { Bonsai } from '../src/bonsai.mjs';
import { runMode } from './run.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(import.meta.dirname, 'results');
const modes = (process.argv.find((a) => a.startsWith('--modes='))?.split('=')[1] ?? 'bm25,hybrid,hybrid-rerank').split(',');
const repeats = Number(process.argv.find((a) => a.startsWith('--repeats='))?.split('=')[1] ?? 3);

const summary = [];
const all = [];
for (const mode of modes) {
  for (let rep = 1; rep <= repeats; rep++) {
    const label = `${mode} #${rep}`;
    process.stdout.write(`${label}: docking... `);
    const bonsai = new Bonsai();
    const db = openDb(':memory:');
    const report = await runMode(mode, { db, bonsai });
    const ok = report.rows.filter((r) => r.correct).length;
    const ev = report.rows.filter((r) => r.grounded).length;
    const both = report.rows.filter((r) => r.correct && r.grounded).length;
    const latencies = report.rows.map((r) => r.ms).sort((a, b) => a - b);
    console.log(`done — answer ${ok}/${report.rows.length}, evidence ${ev}/${report.rows.length}, both ${both}, median ${latencies[Math.floor(latencies.length / 2)]} ms, dock ${report.dockMs} ms`);
    summary.push({ mode, rep, answerCorrect: ok, evidenceCorrect: ev, both, questions: report.rows.length,
      medianMs: latencies[Math.floor(latencies.length / 2)] ?? null, totalMs: report.rows.reduce((s, r) => s + r.ms, 0),
      dockMs: report.dockMs, facts: report.dockReport.facts, duplicates: report.dockReport.duplicates,
      superseded: report.dockReport.superseded, rejectedNames: report.dockReport.rejected_names,
      embeddings: report.dockReport.embeddings ?? null,
      people: report.dockReport.people.length });
    all.push({ mode, rep, rows: report.rows });
  }
}

mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, `compare-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const payload = { createdAt: new Date().toISOString(), modes, repeats, summary, runs: all };
writeFileSync(file, JSON.stringify(payload, null, 2));
console.log(`\nwrote ${path.relative(root, file)}`);

// Aggregate per mode across repetitions.
const agg = {};
for (const s of summary) {
  const a = (agg[s.mode] ??= { mode: s.mode, runs: 0, answerCorrect: 0, evidenceCorrect: 0, both: 0, questions: 0, medianMs: [] });
  a.runs++;
  a.answerCorrect += s.answerCorrect;
  a.evidenceCorrect += s.evidenceCorrect;
  a.both += s.both;
  a.questions += s.questions;
  a.medianMs.push(s.medianMs);
}
for (const a of Object.values(agg)) {
  a.answerAcc = +(a.answerCorrect / a.questions).toFixed(2);
  a.evidenceAcc = +(a.evidenceCorrect / a.questions).toFixed(2);
  a.bothAcc = +(a.both / a.questions).toFixed(2);
  a.medianMs = a.medianMs = a.medianMs[Math.floor(a.medianMs.length / 2)];
}
console.log(JSON.stringify(Object.values(agg), null, 2));
