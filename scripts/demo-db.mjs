#!/usr/bin/env node
// Build a clean, rehearsable demo memory: data/demo.sqlite. Uses memory/'s own modules, unchanged.
//
//   node scripts/demo-db.mjs                       sample conversations + your registered voice
//   node scripts/demo-db.mjs --sessions data/inbox/X.jsonl …   also add real recordings
//   node scripts/demo-db.mjs --no-samples          only your voice (+ --sessions)
//   node scripts/demo-db.mjs --owner-voice FILE    take your voice from another memory db
//                                                  (default: data/fixture-test.sqlite, then data/kindred.sqlite)
//   node scripts/demo-db.mjs --out FILE --force    build somewhere else (only demo.sqlite is overwritten without --force)
//
// Then: ./kindred --demo
//
// Sample people (Maya, Dr. Patel, Sam, Lily) come from contract/fixtures with fake 8-number voiceprints.
// A real recording of that person replaces the fake print at dock, so "Dr. Patel" can be played by a friend.
import { existsSync, rmSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const listAfter = (name) => { const i = args.indexOf(`--${name}`); if (i < 0) return []; const out = []; for (const a of args.slice(i + 1)) { if (a.startsWith('--')) break; out.push(a); } return out; };
const out = path.resolve(root, flag('out') || 'data/demo.sqlite');
const samples = !args.includes('--no-samples');
const sessions = listAfter('sessions').map((f) => path.resolve(process.cwd(), f));
const ownerName = flag('owner-name') || 'Me';
const FIXTURE_OWNER = [0.96, 0.04, 0.03, 0.02, 0.13, 0.02, 0.09, 0.02]; // the owner in contract/fixtures
const log = (...a) => console.log(...a);

const { openDb, parse } = await import(path.join(root, 'memory/src/db.mjs'));
const { ingestFile } = await import(path.join(root, 'memory/src/ingest.mjs'));
const { dock } = await import(path.join(root, 'memory/src/dock.mjs'));
const { enrollOwner, enrollVoice } = await import(path.join(root, 'memory/src/identity.mjs'));
const { Bonsai } = await import(path.join(root, 'memory/src/bonsai.mjs'));

// 1 · your real voice, from the memory you registered it in
function ownerVoice() {
  const candidates = flag('owner-voice') ? [flag('owner-voice')] : ['data/fixture-test.sqlite', 'data/kindred.sqlite'];
  for (const c of candidates) {
    const file = path.resolve(root, c);
    if (!existsSync(file) || file === out) continue;
    const src = new DatabaseSync(file, { readOnly: true });
    try {
      const row = src.prepare('SELECT v.vector, v.samples FROM voices v JOIN people p ON p.id = v.person_id WHERE p.is_owner = 1').get();
      const vec = row && parse(row.vector);
      if (vec?.length > 8) return { vec, from: path.relative(root, file), samples: row.samples };
    } finally { src.close(); }
  }
  return null;
}
const voice = ownerVoice();

// 2 · fresh database
if (existsSync(out) && path.basename(out) !== 'demo.sqlite' && !args.includes('--force')) {
  console.error(`${path.relative(root, out)} exists. Add --force to overwrite it.`); process.exit(1);
}
try { if ((await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(800) })).ok) log('note: a memory server is running. If it is using this database, restart it after this (or just restart ./kindred).'); } catch { /* not running */ }
for (const f of [out, `${out}-wal`, `${out}-shm`]) rmSync(f, { force: true });
const db = openDb(out);
const bonsai = new Bonsai();
const needDock = samples || sessions.length;
if (needDock && !(await bonsai.health?.().catch(() => null))?.ok) {
  try { await fetch(`${bonsai.url}/models`, { signal: AbortSignal.timeout(2000) }); } catch { console.error(`Bonsai isn't running at ${bonsai.url}. Start it: memory/scripts/start-bonsai.sh (or ./kindred --check).`); process.exit(1); }
}
const t0 = Date.now();
const dockAll = async (label) => {
  const r = await dock(db, bonsai, { onEvent: (e) => { if (['introduced', 'named', 'voice_match'].includes(e.type)) log(`    · ${e.type}: ${e.speaker} → ${e.name}${e.score ? ` (${e.score.toFixed(2)})` : ''}`); } });
  log(`  ${label}: ${r.sessions?.length ?? 0} conversations → ${r.episodes} topics, ${r.facts} facts${r.rejected_names?.length ? ` (names rejected: ${[...new Set(r.rejected_names)].join(', ')})` : ''}`);
};

// 3 · sample conversations, docked with the fixture owner voice so "the owner" lines bind to you
if (samples) {
  enrollOwner(db, FIXTURE_OWNER, ownerName);
  const dir = path.join(root, 'contract/fixtures');
  const files = readdirSync(dir).filter((f) => /^day[12]-.*\.jsonl$/.test(f)).sort();
  for (const f of files) ingestFile(db, path.join(dir, f));
  log(`Sample conversations: ${files.join(', ')}`);
  await dockAll('docked with Bonsai');
}

// 4 · then your real voice (a different-length print replaces the fixture one)
const owner = db.prepare('SELECT id FROM people WHERE is_owner = 1').get();
if (voice) {
  if (owner) enrollVoice(db, owner.id, voice.vec); else enrollOwner(db, voice.vec, ownerName);
  log(`Your voice: copied from ${voice.from} (${voice.vec.length}-dim, ${voice.samples} sample${voice.samples > 1 ? 's' : ''})`);
} else log('Your voice: none found. Register it in the app (People → Teach Kindred my voice) after starting with --demo.');

// 5 · real recordings
if (sessions.length) {
  for (const f of sessions) { ingestFile(db, f); log(`Recording: ${path.relative(root, f)}`); }
  await dockAll('docked recordings');
}

// 6 · what's in it
log(`\n${path.relative(root, out)} ready in ${((Date.now() - t0) / 1000).toFixed(0)} s:`);
for (const p of db.prepare(`SELECT p.name, p.relation, p.is_owner,
    (SELECT count(*) FROM facts f WHERE f.person_id = p.id AND f.status = 'active') AS facts,
    (SELECT json_array_length(vector) FROM voices v WHERE v.person_id = p.id) AS dims
  FROM people p ORDER BY p.is_owner DESC, p.name`).all()) {
  const voiceNote = !p.dims ? 'no voice' : p.dims <= 8 ? 'sample voice (replaced by a real recording)' : 'real voice';
  log(`  ${p.is_owner ? '★ ' : '  '}${p.name}${p.relation ? `, ${p.relation}` : ''}: ${p.facts} facts, ${voiceNote}`);
}
const owners = db.prepare('SELECT count(*) AS n FROM people WHERE is_owner = 1').get().n;
const strays = db.prepare("SELECT name FROM people WHERE is_owner = 0 AND (upper(name) IN ('OWNER','ME','MOM','DAD') OR name GLOB 'S[0-9]*')").all().map((r) => r.name);
if (owners !== 1 || strays.length) log(`\n! check: ${owners} owner(s)${strays.length ? `, stray people: ${strays.join(', ')}` : ''}`);
log('\nStart it: ./kindred --demo');
db.close();
