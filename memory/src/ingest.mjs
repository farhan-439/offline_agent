// Load capture session files (see docs/CONTRACT.md) into the raw L0 log.
import { readFileSync } from 'node:fs';
import { json, tx } from './db.mjs';

export function readSessionFile(file) {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`${file}:${i + 1} is not valid JSON`); }
  });
}

/** Idempotent: re-ingesting the same file changes nothing. Returns touched session ids. */
export function ingestEvents(db, events) {
  const sessions = new Set();
  tx(db, () => {
    const ensureSession = (id) => {
      db.prepare('INSERT OR IGNORE INTO sessions (id) VALUES (?)').run(id);
      sessions.add(id);
    };
    for (const e of events) {
      if (!e?.session) continue;
      ensureSession(e.session);
      if (e.type === 'session_start') {
        db.prepare('UPDATE sessions SET started_at = coalesce(?, started_at), place = coalesce(?, place) WHERE id = ?').run(e.startedAt ?? null, e.place ?? null, e.session);
      } else if (e.type === 'session_end') {
        db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(e.endedAt ?? null, e.session);
      } else if (e.type === 'utterance' && e.id && e.text?.trim()) {
        const r = db.prepare('INSERT OR IGNORE INTO utterances (id, session, speaker, start, end, text, audio) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(e.id, e.session, e.speaker ?? null, e.start ?? null, e.end ?? null, e.text.trim(), e.audio ?? null);
        if (r.changes) db.prepare('INSERT INTO utterances_fts (rowid, text) VALUES (?, ?)').run(r.lastInsertRowid, e.text.trim());
      } else if (e.type === 'speaker' && e.speaker) {
        db.prepare(`INSERT INTO clusters (session, speaker, voiceprint, seconds) VALUES (?, ?, ?, ?)
          ON CONFLICT (session, speaker) DO UPDATE SET voiceprint = coalesce(excluded.voiceprint, voiceprint), seconds = excluded.seconds`)
          .run(e.session, e.speaker, e.voiceprint ? json(e.voiceprint) : null, e.seconds ?? null);
      }
    }
  });
  return [...sessions];
}

export const ingestFile = (db, file) => ingestEvents(db, readSessionFile(file));
