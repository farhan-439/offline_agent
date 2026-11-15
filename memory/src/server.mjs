// Long-running localhost bridge for capture and UI. Dock/ingest/ask/photo are serialized;
// voice identification reads the already-docked cards immediately.
//
// Two kinds of typed memory live side by side and stay visibly distinct:
//   N<id>  exact Inputs typed in the lab        (/input, /inputs)
//   F<id>  Ledger facts, inferred or user-saved (/memories, /memory)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from './db.mjs';
import { Bonsai } from './bonsai.mjs';
import { ingestEvents, ingestFile } from './ingest.mjs';
import { recoverCapturedSessions } from './capture-sync.mjs';
import { dock } from './dock.mjs';
import { ask } from './recall.mjs';
import { whoIsThis } from './whisper.mjs';
import { enrollOwner } from './identity.mjs';
import { resolveMode, describeMode, MODES } from './capabilities.mjs';
import { ingestPhoto, askPhoto, uploadPhoto } from './photos.mjs';
import { runAction, pendingActions } from './actions.mjs';
import { addInput, listInputs } from './inputs.mjs';
import { listMemories, rememberMemory } from './memories.mjs';

const PUBLIC = path.resolve(import.meta.dirname, '../public');
const ROOT = path.resolve(import.meta.dirname, '../..');
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/lab.css', ['lab.css', 'text/css; charset=utf-8']],
  ['/lab.js', ['lab.js', 'text/javascript; charset=utf-8']],
]);

const MAX_JSON_BODY = 5_000_000;

async function bodyOf(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_JSON_BODY) throw new Error('request body too large');
  }
  return text ? JSON.parse(text) : {};
}

/** Raw bytes for the photo upload; the browser cannot hand the server a filesystem path. */
async function rawBodyOf(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('image too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function peopleGraph(db) {
  const people = db.prepare(`SELECT p.id, p.name, p.relation, p.core, p.is_owner, p.last_seen,
      (SELECT count(*) FROM facts f WHERE f.person_id = p.id AND f.status = 'active') AS facts,
      (SELECT samples FROM voices v WHERE v.person_id = p.id) AS voice_samples
    FROM people p ORDER BY p.is_owner DESC, p.last_seen DESC NULLS LAST, p.name`).all();
  const relations = db.prepare('SELECT a, b, label FROM relations ORDER BY label').all();
  return { people, relations };
}

export function createHandler(db, bonsai, { inbox = path.join(ROOT, 'data/inbox') } = {}) {
  let queue = Promise.resolve();
  const serial = (fn) => {
    const task = queue.then(fn);
    queue = task.catch(() => {});
    return task;
  };
  let syncTask = null;
  const syncCaptured = () => {
    if (syncTask) return syncTask;
    syncTask = serial(async () => {
      const files = recoverCapturedSessions(db, inbox);
      const pending = db.prepare('SELECT count(*) AS n FROM sessions WHERE docked = 0').get().n;
      const report = pending && bonsai ? await dock(db, bonsai) : null;
      return { ...files, report };
    }).finally(() => { syncTask = null; });
    return syncTask;
  };
  const handler = async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const sendAsset = (name, type) => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'" });
      res.end(readFileSync(path.join(PUBLIC, name)));
    };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && ASSETS.has(url.pathname)) return sendAsset(...ASSETS.get(url.pathname));

      // cited images: the stored original, served read-only from the ignored data directory
      const photoMatch = url.pathname.match(/^\/photo\/([A-Za-z0-9_-]+)$/);
      if (req.method === 'GET' && photoMatch) {
        const row = db.prepare('SELECT path, mime FROM photos WHERE id = ?').get(photoMatch[1]);
        if (!row) return send(404, { error: 'photo not found' });
        const abs = path.resolve(ROOT, row.path);
        if (!abs.startsWith(path.join(ROOT, 'data') + path.sep)) return send(403, { error: 'photo outside data directory' });
        try {
          const bytes = readFileSync(abs);
          res.writeHead(200, { 'content-type': row.mime || 'application/octet-stream', 'cache-control': 'no-store', 'content-length': bytes.length });
          return res.end(bytes);
        } catch { return send(404, { error: 'photo file missing on disk' }); }
      }

      if (req.method === 'GET' && url.pathname === '/inputs') return send(200, { inputs: listInputs(db) });
      if (req.method === 'GET' && url.pathname === '/health') {
        const mode = await resolveMode(bonsai);
        return send(200, { ok: true, model: bonsai?.model ?? null, retrievalMode: mode.mode,
          requestedMode: mode.requested, degraded: mode.degraded, embeddings: mode.caps, detail: describeMode(mode) });
      }
      if (req.method === 'GET' && url.pathname === '/people') return send(200, peopleGraph(db));
      if (req.method === 'GET' && url.pathname === '/memories') {
        const memories = listMemories(db, {
          q: url.searchParams.get('q'),
          person: url.searchParams.get('person'),
          status: url.searchParams.get('status') ?? 'active',
          limit: Number(url.searchParams.get('limit') ?? 200),
        });
        return send(200, { memories });
      }
      if (req.method === 'GET' && url.pathname === '/traces') {
        const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 20));
        const traces = db.prepare('SELECT id, question, answer, mode, grounded, trace, created_at FROM recall_traces ORDER BY id DESC LIMIT ?').all(limit)
          .map((t) => ({ ...t, trace: JSON.parse(t.trace) }));
        return send(200, { traces });
      }
      if (req.method === 'GET' && url.pathname === '/actions') return send(200, { pending: pendingActions(db) });
      if (req.method !== 'POST') return send(404, { error: 'unknown route' });

      // Raw image upload: the browser cannot supply a filesystem path, so it posts the bytes.
      if (url.pathname === '/upload-photo') {
        const limit = Number(process.env.KINDRED_MAX_UPLOAD_BYTES || 12 * 1024 * 1024);
        const buffer = await rawBodyOf(req, limit);
        const people = (url.searchParams.get('people') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const note = url.searchParams.get('note') || null;
        const takenAt = url.searchParams.get('takenAt') || null;
        const mime = (req.headers['content-type'] ?? '').split(';')[0].trim();
        return send(200, await serial(() => uploadPhoto(db, bonsai, { buffer, mime, note, takenAt, people })));
      }

      const input = await bodyOf(req);
      if (url.pathname === '/input') {
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000)
          return send(400, { error: 'Input must contain 1–4,000 characters' });
        return send(200, await serial(() => addInput(db, bonsai, input.text)));
      }
      if (url.pathname === '/identify' || url.pathname === '/who') {
        if (!Array.isArray(input.voiceprint)) return send(400, { error: 'voiceprint array required' });
        const result = await whoIsThis(db, null, input.voiceprint);
        return send(200, { type: 'identity', speaker: input.speaker ?? null, ...result });
      }
      // Register the device owner's voice (the app's "Teach Kindred my voice"). Each call folds one
      // more sample into the owner's voice centroid, so recording again improves it.
      if (url.pathname === '/enroll-owner') {
        if (!Array.isArray(input.voiceprint) || !input.voiceprint.length || !input.voiceprint.every(Number.isFinite)) return send(400, { error: 'voiceprint array required' });
        const personId = await serial(() => enrollOwner(db, input.voiceprint, typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined));
        const voice = db.prepare('SELECT samples FROM voices WHERE person_id = ?').get(personId);
        return send(200, { personId, samples: voice?.samples ?? 0 });
      }
      if (url.pathname === '/ingest') {
        if (!Array.isArray(input.events) && typeof input.file !== 'string') return send(400, { error: 'events array or file required' });
        const sessions = await serial(() => input.events ? ingestEvents(db, input.events) : ingestFile(db, input.file));
        send(200, { sessions });
        // Let recording stop return promptly; facts and vectors are built in the background.
        if (bonsai) setImmediate(() => syncCaptured().catch((error) => console.error(`memory sync: ${error.message}`)));
        return;
      }
      if (url.pathname === '/dock') return send(200, await serial(() => dock(db, bonsai)));
      if (url.pathname === '/ask') {
        if (typeof input.question !== 'string' || !input.question.trim()) return send(400, { error: 'question required' });
        if (input.mode && !MODES.includes(input.mode)) return send(400, { error: 'invalid retrieval mode' });
        const history = Array.isArray(input.history) ? input.history.slice(-3).map((turn) => ({
          question: typeof turn?.question === 'string' ? turn.question.slice(0, 500) : '',
          cites: Array.isArray(turn?.cites) ? turn.cites.slice(0, 4) : [],
        })) : [];
        return send(200, await serial(() => ask(db, bonsai, input.question, { ...(input.mode ? { mode: input.mode } : {}), history })));
      }
      if (url.pathname === '/ask-photo') {
        if (typeof input.id !== 'string' || typeof input.question !== 'string' || !input.question.trim())
          return send(400, { error: 'photo id and question required' });
        return send(200, await serial(() => askPhoto(db, bonsai, input.id, input.question)));
      }
      if (url.pathname === '/ingest-photo' || url.pathname === '/photo') {
        if (typeof input.file !== 'string') return send(400, { error: 'file (local path) required' });
        return send(200, await serial(() => ingestPhoto(db, bonsai, input)));
      }
      if (url.pathname === '/memory') return send(200, { memory: await serial(() => rememberMemory(db, bonsai, input)) });
      if (url.pathname === '/action') return send(200, await serial(() => runAction(db, bonsai, input, { confirm: input.confirm === true })));
      return send(404, { error: 'unknown route' });
    } catch (error) {
      send(error.statusCode ?? 500, { error: error.message });
    }
  };
  handler.syncCaptured = syncCaptured;
  return handler;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const db = openDb();
  const bonsai = new Bonsai();
  const port = Number(process.env.KINDRED_PORT || 8787);
  const handler = createHandler(db, bonsai);
  http.createServer(handler).listen(port, '127.0.0.1', async () => {
    console.log(`Kindred memory listening on http://127.0.0.1:${port}`);
    const mode = await resolveMode(bonsai);
    console.log(`retrieval: ${describeMode(mode)}`);
    const sync = () => handler.syncCaptured().catch((error) => console.error(`memory sync: ${error.message}`));
    sync();
    setInterval(sync, 30_000).unref();
  });
}
