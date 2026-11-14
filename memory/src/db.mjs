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
  speaker TEXT, start REAL, end REAL, text TEXT NOT NULL, language TEXT, translation TEXT,
  audio TEXT, kept INTEGER NOT NULL DEFAULT 1
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
  core TEXT, core_fact_ids TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen TEXT
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

-- L2 · facts can involve several people (Sam's visit concerns Sam and Lily)
CREATE TABLE IF NOT EXISTS fact_people (
  fact INTEGER NOT NULL, person_id TEXT NOT NULL REFERENCES people(id), role TEXT,
  PRIMARY KEY (fact, person_id)
);

-- Photo memory: the image stays as evidence; observations are grounded, searchable text
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY, path TEXT, sha256 TEXT NOT NULL UNIQUE, mime TEXT, taken_at TEXT,
  added_at TEXT NOT NULL, caption TEXT
);
CREATE TABLE IF NOT EXISTS photo_observations (
  rowid INTEGER PRIMARY KEY, photo_id TEXT NOT NULL REFERENCES photos(id), kind TEXT NOT NULL,
  text TEXT NOT NULL, confidence REAL, created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS photo_observations_fts USING fts5(text);

-- Which people appear in a photo (validated names only)
CREATE TABLE IF NOT EXISTS photo_people (
  photo_id TEXT NOT NULL REFERENCES photos(id), person_id TEXT NOT NULL REFERENCES people(id),
  role TEXT, PRIMARY KEY (photo_id, person_id)
);

-- Explicit user-facing actions (reminders, corrections, forgets). State changes are confirmed.
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, due_text TEXT, due_date TEXT, person_id TEXT,
  evidence TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_actions (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0,
  note TEXT, created_at TEXT NOT NULL
);

-- Recall traces for the demo view: what Bonsai planned, paged in and evicted
CREATE TABLE IF NOT EXISTS recall_traces (
  id INTEGER PRIMARY KEY, question TEXT NOT NULL, answer TEXT, mode TEXT, grounded INTEGER,
  trace TEXT NOT NULL, created_at TEXT NOT NULL
);

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
  const utteranceColumns = new Set(db.prepare('PRAGMA table_info(utterances)').all().map((c) => c.name));
  if (!utteranceColumns.has('language')) db.exec('ALTER TABLE utterances ADD COLUMN language TEXT');
  if (!utteranceColumns.has('translation')) db.exec('ALTER TABLE utterances ADD COLUMN translation TEXT');
  if (!db.prepare('PRAGMA table_info(facts)').all().some((c) => c.name === 'when_resolved'))
    db.exec('ALTER TABLE facts ADD COLUMN when_resolved TEXT');
  if (!db.prepare('PRAGMA table_info(facts)').all().some((c) => c.name === 'about_raw'))
    db.exec('ALTER TABLE facts ADD COLUMN about_raw TEXT');
  if (!db.prepare('PRAGMA table_info(people)').all().some((c) => c.name === 'core_fact_ids'))
    db.exec('ALTER TABLE people ADD COLUMN core_fact_ids TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS fact_people_person ON fact_people(person_id)');
  db.exec('CREATE INDEX IF NOT EXISTS facts_person_status ON facts(person_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS photo_obs_photo ON photo_observations(photo_id)');
  return db;
}

export const now = () => new Date().toISOString();
export const json = (v) => JSON.stringify(v);
export const parse = (s, fallback = null) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };

export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
