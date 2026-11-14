#!/usr/bin/env node
// kindred — memory side command line.
//   ingest <session.jsonl...>     load capture output (L0)
//   enroll-me '<voiceprint json>' register the device owner's voice
//   dock                          build episodes, facts, people, core memory with Bonsai
//   ask "<question>"              MemGPT-style recall with citations
//   who '<voiceprint json>'       live identification → whisper line
//   people                        print the people graph
//   demo                          reset a scratch DB and run the fixture day end to end
import path from 'node:path';
import { rmSync, readdirSync } from 'node:fs';
import { openDb, parse } from './db.mjs';
import { Bonsai } from './bonsai.mjs';
import { ingestFile } from './ingest.mjs';
import { enrollOwner } from './identity.mjs';
import { dock } from './dock.mjs';
import { ask } from './recall.mjs';
import { whoIsThis } from './whisper.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const [cmd, ...args] = process.argv.slice(2);
const log = (...a) => console.log(...a);

function printPeople(db) {
  for (const p of db.prepare('SELECT p.*, (SELECT count(*) FROM facts f WHERE f.person_id = p.id AND f.status = \'active\') AS n, (SELECT samples FROM voices v WHERE v.person_id = p.id) AS voice FROM people p ORDER BY is_owner DESC, name').all()) {
    log(`● ${p.name}${p.relation ? ` — ${p.relation}` : ''}  [${p.n} facts${p.voice ? `, voiceprint×${p.voice}` : ', no voice'}]`);
    if (p.core) log(`    ${p.core}`);
  }
  for (const r of db.prepare('SELECT a.name AS a, b.name AS b, label FROM relations JOIN people a ON a.id = relations.a JOIN people b ON b.id = relations.b').all()) log(`  ${r.a} ─${r.label}─ ${r.b}`);
}

async function main() {
  if (cmd === 'demo') {
    process.env.KINDRED_DB ||= path.join(root, 'data/demo.sqlite');
    for (const f of [process.env.KINDRED_DB, `${process.env.KINDRED_DB}-wal`, `${process.env.KINDRED_DB}-shm`]) rmSync(f, { force: true });
  }
  const db = openDb();
  const bonsai = new Bonsai();

  switch (cmd) {
    case 'ingest': for (const f of args) log(`ingested ${ingestFile(db, f).join(', ')} from ${f}`); break;
    case 'enroll-me': log(`owner voice enrolled as ${enrollOwner(db, parse(args[0]))}`); break;
    case 'dock': {
      const r = await dock(db, bonsai, { onEvent: (e) => log('  ·', JSON.stringify(e)) });
      log(`docked ${r.sessions.length} sessions → ${r.episodes} episodes, ${r.facts} facts (${r.dropped} filler lines dropped, ${r.ungrounded} ungrounded facts rejected)`);
      log(`Bonsai calls: ${bonsai.calls.length}, ${bonsai.calls.reduce((s, c) => s + c.ms, 0)} ms`);
      break;
    }
    case 'ask': {
      const r = await ask(db, bonsai, args.join(' '), { onStep: (s) => log('  ·', JSON.stringify(s)) });
      log(`\n${r.answer}`);
      for (const c of r.clips) log(`  ↳ ${c.speaker}, ${c.started_at?.slice(0, 10)}: "${c.text}"  (${c.audio}#t=${c.start},${c.end})`);
      break;
    }
    case 'who': log(JSON.stringify(await whoIsThis(db, bonsai, parse(args[0])), null, 2)); break;
    case 'people': printPeople(db); break;
    case 'demo': {
      const dir = path.join(root, 'contract/fixtures');
      enrollOwner(db, [0.96, 0.04, 0.03, 0.02, 0.13, 0.02, 0.09, 0.02]);
      for (const f of readdirSync(dir).filter((f) => f.startsWith('day1') || f.startsWith('day2'))) ingestFile(db, path.join(dir, f));
      log('— dock —');
      const r = await dock(db, bonsai, { onEvent: (e) => log('  ·', JSON.stringify(e)) });
      log(`${r.episodes} episodes, ${r.facts} facts\n— people —`);
      printPeople(db);
      log('— live: Maya walks up (day 3) —');
      const live = (await import('./ingest.mjs')).readSessionFile(path.join(dir, 'day3-live-maya.jsonl')).find((e) => e.type === 'speaker');
      log(JSON.stringify(await whoIsThis(db, bonsai, live.voiceprint), null, 2));
      for (const q of ['What did the doctor change about my medication?', 'When is Sam coming and is there anything I should not cook?']) {
        log(`— ask: ${q}`);
        const a = await ask(db, bonsai, q, { today: '2026-11-13' });
        log(a.answer);
        for (const c of a.clips) log(`  ↳ ${c.speaker}: "${c.text}"`);
      }
      break;
    }
    default:
      log('usage: kindred <ingest|enroll-me|dock|ask|who|people|demo> ...  (see src/cli.mjs)');
      process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
