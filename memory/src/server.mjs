// Long-running localhost bridge for capture and UI. Dock/ingest/ask are serialized;
// voice identification reads the already-docked cards immediately.
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from './db.mjs';
import { Bonsai } from './bonsai.mjs';
import { ingestEvents, ingestFile } from './ingest.mjs';
import { dock } from './dock.mjs';
import { ask } from './recall.mjs';
import { whoIsThis } from './whisper.mjs';
import { enrollOwner } from './identity.mjs';

// Read-only roster for the app's Dock screen (same query as `kindred people` in cli.mjs).
export function listPeople(db) {
  const people = db.prepare(`SELECT p.id, p.name, p.relation, p.is_owner, p.core, p.last_seen,
      (SELECT count(*) FROM facts f WHERE f.person_id = p.id AND f.status = 'active') AS facts,
      (SELECT samples FROM voices v WHERE v.person_id = p.id) AS voice
    FROM people p ORDER BY is_owner DESC, name`).all().map((p) => ({
    id: p.id, name: p.name, relation: p.relation ?? null, owner: !!p.is_owner, core: p.core ?? null,
    lastSeen: p.last_seen ?? null, facts: p.facts, voiceSamples: p.voice ?? 0,
  }));
  const relations = db.prepare('SELECT a.name AS a, b.name AS b, label FROM relations JOIN people a ON a.id = relations.a JOIN people b ON b.id = relations.b').all();
  return { people, relations };
}

async function bodyOf(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 5_000_000) throw new Error('request body too large');
  }
  return text ? JSON.parse(text) : {};
}

export function createHandler(db, bonsai) {
  let queue = Promise.resolve();
  const serial = (fn) => {
    const task = queue.then(fn);
    queue = task.catch(() => {});
    return task;
  };
  return async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
      if (req.method === 'GET' && req.url === '/people') return send(200, listPeople(db));
      if (req.method !== 'POST') return send(404, { error: 'unknown route' });
      const input = await bodyOf(req);
      if (req.url === '/identify' || req.url === '/who') {
        if (!Array.isArray(input.voiceprint)) return send(400, { error: 'voiceprint array required' });
        const result = await whoIsThis(db, null, input.voiceprint);
        return send(200, { type: 'identity', speaker: input.speaker ?? null, ...result });
      }
      // Register the device owner's voice (the app's "Teach Kindred my voice"). Each call folds one
      // more sample into the owner's voice centroid, so recording again improves it.
      if (req.url === '/enroll-owner') {
        if (!Array.isArray(input.voiceprint) || !input.voiceprint.length || !input.voiceprint.every(Number.isFinite)) return send(400, { error: 'voiceprint array required' });
        const personId = await serial(() => enrollOwner(db, input.voiceprint, typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined));
        const voice = db.prepare('SELECT samples FROM voices WHERE person_id = ?').get(personId);
        return send(200, { personId, samples: voice?.samples ?? 0 });
      }
      if (req.url === '/ingest') {
        if (!Array.isArray(input.events) && typeof input.file !== 'string') return send(400, { error: 'events array or file required' });
        return send(200, { sessions: await serial(() => input.events ? ingestEvents(db, input.events) : ingestFile(db, input.file)) });
      }
      if (req.url === '/dock') return send(200, await serial(() => dock(db, bonsai)));
      if (req.url === '/ask') {
        if (typeof input.question !== 'string' || !input.question.trim()) return send(400, { error: 'question required' });
        return send(200, await serial(() => ask(db, bonsai, input.question)));
      }
      return send(404, { error: 'unknown route' });
    } catch (error) {
      return send(500, { error: error.message });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const db = openDb();
  const bonsai = new Bonsai();
  const port = Number(process.env.KINDRED_PORT || 8787);
  http.createServer(createHandler(db, bonsai)).listen(port, '127.0.0.1', () => {
    console.log(`Kindred memory listening on http://127.0.0.1:${port}`);
  });
}
