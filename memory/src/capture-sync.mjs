// Recover completed Argmax recordings after a crash or a temporary memory outage.
// Ingest is idempotent, so the inbox remains the durable handoff to memory.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { ingestEvents, readSessionFile } from './ingest.mjs';

export function recoverCapturedSessions(db, inbox) {
  const recovered = [];
  const skipped = [];
  let names;
  try { names = readdirSync(inbox).filter((name) => /^[A-Za-z0-9_-]+\.jsonl$/.test(name)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return { recovered, skipped }; throw error; }
  for (const name of names) {
    const file = path.join(inbox, name);
    try {
      const events = readSessionFile(file);
      const start = events.find((e) => e.type === 'session_start');
      const end = events.at(-1);
      // A file still being written is retried on the next pass.
      if (!start?.session || end?.type !== 'session_end' || end.session !== start.session ||
          events.some((e) => e.session !== start.session)) { skipped.push(name); continue; }
      if (!db.prepare('SELECT id FROM sessions WHERE id = ?').get(start.session)) {
        ingestEvents(db, events);
        recovered.push(start.session);
      }
    } catch { skipped.push(name); }
  }
  return { recovered, skipped };
}
