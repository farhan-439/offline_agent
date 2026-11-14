// Storage for every memory layer. One SQLite file on disk is the "archival memory":
// Bonsai's context window is small, so nothing lives in the prompt unless recall pages it in.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- L0 · raw log (what Argmax heard)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, started_at TEXT, ended_at TEXT, place TEXT,
  docked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS utterances (
  rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, session TEXT NOT NULL REFERENCES sessions(id),
  speaker TEXT, start REAL, end REAL, text TEXT NOT NULL, audio TEXT, kept INTEGER NOT NULL DEFAULT 1
);
CREATE VIRTUAL TABLE IF NOT EXISTS utterances_fts USING fts5(text);

-- Speaker clusters per session, linked to a person once identified
CREATE TABLE IF NOT EXISTS clusters (
  session TEXT NOT NULL, speaker TEXT NOT NULL, voiceprint TEXT, seconds REAL,
  person_id TEXT, how TEXT, score REAL,
  PRIMARY KEY (session, speaker)
);

-- People graph
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, relation TEXT, is_owner INTEGER NOT NULL DEFAULT 0,
  core TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS voices (
  person_id TEXT PRIMARY KEY REFERENCES people(id), vector TEXT NOT NULL, samples INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relations (
  a TEXT NOT NULL REFERENCES people(id), b TEXT NOT NULL REFERENCES people(id), label TEXT NOT NULL,
  evidence TEXT, PRIMARY KEY (a, b, label)
);

-- L1 · episodes (LightMem short-term → summarised topic segments)
CREATE TABLE IF NOT EXISTS episodes (
  rowid INTEGER PRIMARY KEY, session TEXT NOT NULL, start REAL, end REAL, summary TEXT,
  utterance_ids TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(summary);

-- L2 · semantic facts, each grounded in utterance ids
CREATE TABLE IF NOT EXISTS facts (
  rowid INTEGER PRIMARY KEY, person_id TEXT REFERENCES people(id), kind TEXT NOT NULL, text TEXT NOT NULL,
  when_text TEXT, when_resolved TEXT, evidence TEXT NOT NULL, session TEXT, episode INTEGER, observed_at TEXT,
  status TEXT NOT NULL DEFAULT 'active', superseded_by INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(text, person, kind);

-- Bonsai-generated semantic index. A content hash makes re-indexing incremental.
CREATE TABLE IF NOT EXISTS embeddings (
  ref TEXT PRIMARY KEY, model TEXT NOT NULL, content_hash TEXT NOT NULL,
  dim INTEGER NOT NULL, vector BLOB NOT NULL, updated_at TEXT NOT NULL
);
`;

export function openDb(file = process.env.KINDRED_DB || path.resolve(import.meta.dirname, '../../data/kindred.sqlite')) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  if (!db.prepare('PRAGMA table_info(facts)').all().some((c) => c.name === 'when_resolved'))
    db.exec('ALTER TABLE facts ADD COLUMN when_resolved TEXT');
  return db;
}

export const now = () => new Date().toISOString();
export const json = (v) => JSON.stringify(v);
export const parse = (s, fallback = null) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };

export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
