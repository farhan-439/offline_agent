#!/usr/bin/env node
// One command to start Kindred: preflight checks → Bonsai (started if it isn't running) → the app.
// The app itself starts and supervises memory (app/memory-supervisor.mjs) and capture.
//
//   ./kindred                 start with your real memory (data/kindred.sqlite)
//   ./kindred --demo          start with the demo memory (data/demo.sqlite; build it: node scripts/demo-db.mjs)
//   ./kindred --db FILE       start with another memory database
//   ./kindred --check         preflight only, start nothing
//
// Nothing here downloads anything: run `capture/.build/release/kindred-capture provision` once online first.
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] ?? true) : null; };
const checkOnly = args.includes('--check');
const db = args.includes('--demo') ? 'data/demo.sqlite' : flag('db');
const BONSAI = (process.env.BONSAI_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const MEMORY = (process.env.KINDRED_MEMORY_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const CAPTURE = path.join(root, 'capture/.build/release/kindred-capture');
const CACHE = path.join(os.homedir(), 'Library/Caches/Kindred');

let problems = 0, warnings = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m, fix) => { warnings++; console.log(`  ! ${m}${fix ? `\n      → ${fix}` : ''}`); };
const fail = (m, fix) => { problems++; console.log(`  ✗ ${m}${fix ? `\n      → ${fix}` : ''}`); };
const get = async (url, ms = 2000) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json().catch(() => ({})) : null; } catch { return null; } };
const run = (file, argv, ms) => new Promise((resolve) => execFile(file, argv, { cwd: root, timeout: ms }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));

console.log('Kindred preflight');

// 1 · runtime and builds
const major = Number(process.versions.node.split('.')[0]);
major >= 24 ? ok(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node} (memory needs 24+)`, 'nvm install 24');
existsSync(CAPTURE) ? ok('Argmax capture built') : fail('Argmax capture is not built', 'cd capture && swift build -c release');
existsSync(path.join(root, 'app/node_modules/electron')) ? ok('App installed') : fail('App dependencies missing', 'cd app && npm ci');

// 2 · offline models (staged by `kindred-capture provision`)
const model = (name) => { try { return existsSync(realpathSync(path.join(CACHE, name))); } catch { return false; } };
const required = ['whisper-model', 'whisper-tokenizer', 'speaker-model', 'tts-model', 'tts-tokenizer'];
const missing = required.filter((m) => !model(m));
missing.length ? fail(`Argmax models missing: ${missing.join(', ')}`, `${path.relative(root, CAPTURE)} provision   (once, online)`) : ok('Argmax models staged (Whisper, SpeakerKit, TTS)');
model('whisper-multi-model') ? ok('Translation model staged (Whisper small)') : warn('Translation model not staged: Live translation will not work offline', `${path.relative(root, CAPTURE)} provision --only whisper-multi`);
model('sortformer-model') ? ok('Live speaker detection model staged (Sortformer)') : warn('Sortformer not staged: live detection falls back to rolling pyannote');

// 3 · Argmax Pro license (refreshes the cached token when online; works from the cache offline)
let envKey = false;
try { envKey = /^ARGMAX_API_KEY=ax_\S+/m.test(readFileSync(path.join(root, '.env'), 'utf8')); } catch { /* no .env */ }
if (!envKey && !/^ax_/.test(process.env.ARGMAX_API_KEY || '')) warn('No ARGMAX_API_KEY (ax_…) in .env: using the open-source SDK, no live Sortformer');
else if (existsSync(CAPTURE)) {
  const { stdout } = await run(CAPTURE, ['license'], 30000);
  let lic = {};
  try { lic = JSON.parse(stdout.trim().split('\n').at(-1)); } catch { /* below */ }
  if (!lic.proAccess) warn('Argmax Pro license not active: using the open-source SDK', 'Run once with Wi-Fi on so the license can refresh');
  else {
    const days = lic.licenseTokenExpiresAt ? (Date.parse(lic.licenseTokenExpiresAt) - Date.now()) / 86400000 : null;
    days !== null && days < 2
      ? warn(`Argmax Pro license token expires in ${days.toFixed(1)} days`, 'Run ./kindred once with Wi-Fi on to refresh it')
      : ok(`Argmax Pro license active${days !== null ? ` (offline token valid ${Math.floor(days)} more days)` : ''}`);
  }
}

// 4 · Bonsai (start it if it isn't running)
let bonsai = await get(`${BONSAI}/models`);
if (bonsai) ok(`Bonsai running (${bonsai.data?.map((m) => m.id).join(', ') || 'up'})`);
else if (checkOnly) warn('Bonsai is not running (./kindred will start it)');
else if (problems === 0) {
  const script = path.join(root, 'memory/scripts/start-bonsai.sh');
  mkdirSync(path.join(root, 'data/logs'), { recursive: true });
  const log = path.join(root, 'data/logs/bonsai.log');
  const fd = openSync(log, 'a');
  const child = spawn(script, [], { cwd: root, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  process.stdout.write(`  … starting Bonsai 4B (log: ${path.relative(root, log)})`);
  for (let i = 0; i < 120 && !bonsai; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (child.exitCode !== null) break;
    bonsai = await get(`${BONSAI}/models`);
    if (i % 5 === 4) process.stdout.write('.');
  }
  process.stdout.write('\n');
  bonsai ? ok('Bonsai started (it keeps running after Kindred quits; stop it with: pkill llama-server)')
    : fail('Bonsai did not start', `see data/logs/bonsai.log, or run: ${path.relative(root, script)}`);
}

// 5 · memory: the app starts it (with the chosen database) unless one is already running
const memory = await get(`${MEMORY}/health`);
if (memory) {
  (db ? warn : ok)(`A memory server is already running at ${MEMORY}${memory.retrievalMode ? ` (${memory.retrievalMode})` : ''}`,
    db ? `It keeps its own database, so --${args.includes('--demo') ? 'demo' : 'db'} won't apply. Stop it (Ctrl-C in its terminal) and rerun.` : null);
} else ok(`Memory will be started by the app${db ? ` with ${db}` : ' with data/kindred.sqlite'}`);
if (db && !existsSync(path.join(root, db))) warn(`${db} does not exist yet: memory will start it empty`, args.includes('--demo') ? 'Build the demo memory: node scripts/demo-db.mjs' : null);

console.log(problems ? `\n${problems} problem(s) to fix first.` : `\nReady${warnings ? ` (${warnings} warning${warnings > 1 ? 's' : ''})` : ''}.`);
if (checkOnly || problems) process.exit(problems ? 1 : 0);

// 6 · the app (Ctrl-C here quits it; memory it started stops with it)
console.log('Starting Kindred… (click the orb at the bottom of the screen)\n');
const env = { ...process.env };
if (db) env.KINDRED_DB = path.resolve(root, db);
const app = spawn('npm', ['start'], { cwd: path.join(root, 'app'), env, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.kill(sig));
app.on('exit', (code) => process.exit(code ?? 0));
