// Long-running localhost bridge for capture and UI. Dock/ingest/ask/photo are serialized;
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
import { resolveMode, describeMode } from './capabilities.mjs';
import { ingestPhoto } from './photos.mjs';
import { runAction, pendingActions } from './actions.mjs';

async function bodyOf(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 5_000_000) throw new Error('request body too large');
  }
  return text ? JSON.parse(text) : {};
}

export function peopleGraph(db) {
  const people = db.prepare(`SELECT p.id, p.name, p.relation, p.core, p.is_owner, p.last_seen,
      (SELECT count(*) FROM facts f WHERE f.person_id = p.id AND f.status = 'active') AS facts,
      (SELECT samples FROM voices v WHERE v.person_id = p.id) AS voice_samples
    FROM people p ORDER BY p.is_owner DESC, p.last_seen DESC NULLS LAST, p.name`).all();
  const relations = db.prepare('SELECT a, b, label FROM relations ORDER BY label').all();
  return { people, relations };
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
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        const mode = await resolveMode(bonsai);
        return send(200, { ok: true, model: bonsai?.model ?? null, retrievalMode: mode.mode,
          requestedMode: mode.requested, degraded: mode.degraded, embeddings: mode.caps, detail: describeMode(mode) });
      }
      if (req.method === 'GET' && url.pathname === '/people') return send(200, peopleGraph(db));
      if (req.method === 'GET' && url.pathname === '/traces') {
        const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 20));
        const traces = db.prepare('SELECT id, question, answer, mode, grounded, trace, created_at FROM recall_traces ORDER BY id DESC LIMIT ?').all(limit)
          .map((t) => ({ ...t, trace: JSON.parse(t.trace) }));
        return send(200, { traces });
      }
      if (req.method === 'GET' && url.pathname === '/actions') return send(200, { pending: pendingActions(db) });
      if (req.method !== 'POST') return send(404, { error: 'unknown route' });
      const input = await bodyOf(req);
      if (url.pathname === '/identify' || url.pathname === '/who') {
        if (!Array.isArray(input.voiceprint)) return send(400, { error: 'voiceprint array required' });
        const result = await whoIsThis(db, null, input.voiceprint);
        return send(200, { type: 'identity', speaker: input.speaker ?? null, ...result });
      }
      if (url.pathname === '/ingest') {
        if (!Array.isArray(input.events) && typeof input.file !== 'string') return send(400, { error: 'events array or file required' });
        return send(200, { sessions: await serial(() => input.events ? ingestEvents(db, input.events) : ingestFile(db, input.file)) });
      }
      if (url.pathname === '/dock') return send(200, await serial(() => dock(db, bonsai)));
      if (url.pathname === '/ask') {
        if (typeof input.question !== 'string' || !input.question.trim()) return send(400, { error: 'question required' });
        return send(200, await serial(() => ask(db, bonsai, input.question, input.mode ? { mode: input.mode } : {})));
      }
      if (url.pathname === '/ingest-photo' || url.pathname === '/photo') {
        if (typeof input.file !== 'string') return send(400, { error: 'file (local path) required' });
        return send(200, await serial(() => ingestPhoto(db, bonsai, input)));
      }
      if (url.pathname === '/action') return send(200, await serial(() => runAction(db, bonsai, input, { confirm: input.confirm === true })));
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
  http.createServer(createHandler(db, bonsai)).listen(port, '127.0.0.1', async () => {
    console.log(`Kindred memory listening on http://127.0.0.1:${port}`);
    const mode = await resolveMode(bonsai);
    console.log(`retrieval: ${describeMode(mode)}`);
  });
}
