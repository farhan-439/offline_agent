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
      if (req.method !== 'POST') return send(404, { error: 'unknown route' });
      const input = await bodyOf(req);
      if (req.url === '/identify' || req.url === '/who') {
        if (!Array.isArray(input.voiceprint)) return send(400, { error: 'voiceprint array required' });
        const result = await whoIsThis(db, null, input.voiceprint);
        return send(200, { type: 'identity', speaker: input.speaker ?? null, ...result });
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
