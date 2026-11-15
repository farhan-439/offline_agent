#!/usr/bin/env node
// Summarise a real-world run log (data/logs/run-YYYY-MM-DD.jsonl, written by the app; app/run-log.mjs).
//   node scripts/analyze-run.mjs                 today's log
//   node scripts/analyze-run.mjs data/logs/run-2026-11-15.jsonl
//   node scripts/analyze-run.mjs --since 10:30   only events after a time (local)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const sinceArg = args[args.indexOf('--since') + 1];
const fileArg = args.find((a) => a.endsWith('.jsonl'));
const logDir = path.join(root, 'data/logs');
const file = fileArg ? path.resolve(fileArg)
  : existsSync(logDir) ? path.join(logDir, readdirSync(logDir).filter((f) => /^run-.*\.jsonl$/.test(f)).sort().at(-1) ?? 'none') : null;
if (!file || !existsSync(file)) { console.error('No run log found. Start Kindred (./kindred), use it, then run this again.'); process.exit(1); }

let events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
if (args.includes('--since') && sinceArg) {
  const [h, m] = sinceArg.split(':').map(Number);
  const cut = new Date(events[0]?.t ?? Date.now()); cut.setHours(h, m || 0, 0, 0);
  events = events.filter((e) => new Date(e.t) >= cut);
}
const T = (e) => Date.parse(e.t);
const s = (ms) => `${(ms / 1000).toFixed(1)} s`;
const clock = (e) => new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
console.log(`Run log: ${path.relative(process.cwd(), file)} (${events.length} events)\n`);

// ---------- recordings ----------
const recordings = [];
let cur = null;
for (const e of events) {
  if (e.type === 'recording-start') { cur = { start: e, mode: e.mode, events: [] }; recordings.push(cur); continue; }
  if (!cur) continue;
  cur.events.push(e);
  if (e.type === 'recording-done' || e.type === 'enroll-done') cur = null;
}
const allScores = [];
for (const [i, r] of recordings.entries()) {
  const ev = r.events;
  const done = ev.find((e) => e.type === 'recording-done' || e.type === 'enroll-done');
  const mic = ev.find((e) => e.type === 'capture-mic-live');
  const live = ev.find((e) => e.type === 'capture-live');
  const t0 = T(mic ?? r.start);
  console.log(`● Recording ${i + 1} at ${clock(r.start)}: ${r.mode}${done ? `, ${s(T(done) - T(r.start))}` : ' (no end logged)'}${mic?.device ? `, mic: ${mic.device}` : ''}${live?.engine ? `, live: ${live.engine}` : ''}`);
  if (r.mode === 'enroll') { console.log(`    ${done?.ok ? `voice registered (${done.samples} sample(s), ${Math.round(done.seconds)} s of speech)` : `failed: ${done?.error}`}\n`); continue; }

  // voices: first heard → identity scores → whisper
  const labels = [...new Set(ev.filter((e) => e.type === 'capture-speaker' && e.final === false).map((e) => e.speaker))];
  for (const label of labels) {
    const sightings = ev.filter((e) => e.type === 'capture-speaker' && e.speaker === label);
    const ids = ev.filter((e) => e.type === 'live-identity' && e.speaker === label);
    const whisper = ev.find((e) => (e.type === 'whisper' || e.type === 'live-whisper') && e.speaker === label);
    const best = ids.reduce((b, x) => (x.score ?? 0) > (b?.score ?? -1) ? x : b, null);
    for (const x of ids) allScores.push({ rec: i + 1, label, name: x.owner ? 'you' : x.name ?? null, score: x.score ?? 0 });
    const who = best?.owner ? 'you' : best?.name ?? 'not recognised';
    const trail = ids.map((x) => `${(x.score ?? 0).toFixed(2)}${x.name ? '✓' : ''}`).join(' → ');
    console.log(`    ${label}: ${who}. Heard at ${s(T(sightings[0]) - t0)}, ${Math.round(sightings.at(-1).seconds ?? 0)} s of speech by the last check. Scores: ${trail || 'none (memory down?)'}`);
    if (whisper) console.log(`        whisper at ${s(T(whisper) - t0)} (${s(T(whisper) - T(sightings[0]))} after first heard): "${whisper.text}"`);
  }
  // translations + replies
  const tr = ev.filter((e) => e.type === 'translation');
  if (tr.length) {
    const lags = ev.filter((e) => e.type === 'capture-log' && /translate #\d+/.test(e.message)).map((e) => Number(e.message.match(/: (\d+) ms after speech ended/)?.[1])).filter(Number.isFinite);
    const langs = [...new Set(tr.map((t) => t.language))].join(', ');
    console.log(`    translations: ${tr.length} (${langs})${lags.length ? `, ${s(lags.sort((a, b) => a - b)[Math.floor(lags.length / 2)])} median after the speaker stopped (max ${s(Math.max(...lags))})` : ''}`);
    for (const t of tr.slice(0, 5)) console.log(`        ${t.language}: "${t.text}" → "${t.translation ?? '(English)'}"`);
  }
  for (const rp of ev.filter((e) => e.type === 'reply')) console.log(`    reply (${rp.language}): "${rp.english}" → "${rp.translated}" (Bonsai ${s(rp.translateMs ?? 0)})`);
  const muted = ev.filter((e) => e.type === 'capture-log' && /muted|dropped \d/.test(e.message)).length;
  if (muted) console.log(`    Kindred's own voice filtered ${muted} time(s)`);
  if (done) console.log(`    saved: ${done.utterances ?? '?'} lines from ${done.speakers ?? '?'} voice(s)${done.ingested ? ', sent to memory' : done.ok === false ? `, FAILED: ${done.error}` : `, NOT sent to memory: ${done.ingestError}`}`);
  console.log('');
}

// ---------- questions ----------
const asks = events.filter((e) => e.type === 'ask');
if (asks.length) {
  console.log(`? Questions: ${asks.length}`);
  for (const a of asks) console.log(`    ${clock(a)} "${a.question}" → ${s(a.ms)}${a.grounded ? '' : ' (NOT grounded)'}: ${String(a.answer ?? '').slice(0, 110)}`);
  console.log('');
}

// ---------- problems ----------
const problems = events.filter((e) => /error|exit|unavailable|failed/.test(e.type) || (e.type === 'capture-log' && /error|failed|exited/i.test(e.message)) || (e.type === 'recording-done' && e.ok === false));
if (problems.length) {
  console.log(`! Problems: ${problems.length}`);
  for (const p of problems.slice(-12)) console.log(`    ${clock(p)} ${p.type}: ${p.message ?? p.error ?? JSON.stringify(p).slice(0, 140)}`);
  console.log('');
}

// ---------- threshold ----------
if (allScores.length) {
  const threshold = Number(process.env.KINDRED_VOICE_THRESHOLD || 0.85);
  console.log(`Voice match scores (threshold ${threshold}; recognised ✓ means score ≥ threshold):`);
  const byLabel = new Map();
  for (const x of allScores) { const k = `rec ${x.rec} ${x.label}`; byLabel.set(k, [...(byLabel.get(k) ?? []), x]); }
  for (const [k, xs] of byLabel) {
    const top = xs.reduce((a, b) => (b.score > a.score ? b : a));
    console.log(`    ${k.padEnd(12)} best ${top.score.toFixed(3)} ${top.name ? `→ ${top.name} ✓` : '(unknown)'}`);
  }
  console.log(`\nTo tune KINDRED_VOICE_THRESHOLD: note who each voice really was. The threshold should sit below the`);
  console.log(`lowest best-score of a person you'd met before, and above the highest score of a stranger.`);
}
