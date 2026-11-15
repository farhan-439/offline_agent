// MemorySupervisor against a fake memory/src/server.mjs (a tiny HTTP server) in a temp repo root.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemorySupervisor } from '../memory-supervisor.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'kindred-sup-'));
mkdirSync(path.join(root, 'memory/src'), { recursive: true });
writeFileSync(path.join(root, 'memory/src/server.mjs'), `
import http from 'node:http';
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, db: process.env.KINDRED_DB || null, pid: process.pid })); })
  .listen(Number(process.env.KINDRED_PORT), '127.0.0.1', () => console.log('fake memory up', process.env.KINDRED_DB));
`);
const port = () => 18000 + Math.floor(Math.random() * 2000);
const until = async (cond, ms = 8000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); } };
const health = async (url) => (await fetch(`${url}/health`)).json();

test('starts memory with the chosen database, restarts it when it dies, stops it on quit', async () => {
  const url = `http://127.0.0.1:${port()}`;
  const events = [];
  const sup = new MemorySupervisor({ repoRoot: root, url, db: 'data/demo.sqlite', onEvent: (e) => events.push(e), backoffMs: [50] });
  assert.equal(await sup.start(), true);
  assert.equal(sup.state, 'running');
  const first = await health(url);
  assert.equal(first.db, path.join(root, 'data/demo.sqlite'), 'KINDRED_DB passed through, resolved from the repo root');
  process.kill(first.pid, 'SIGKILL');                       // it crashes…
  await until(() => events.some((e) => e.state === 'restarting'));
  await until(() => sup.state === 'running');               // …and comes back
  const second = await health(url);
  assert.notEqual(second.pid, first.pid);
  assert.equal(sup.restarts, 1);
  sup.stop();
  await until(() => sup.state === 'stopped');
  await assert.rejects(fetch(`${url}/health`), 'port closed after stop');
  assert.match(readFileSync(path.join(root, 'data/logs/memory.log'), 'utf8'), /fake memory up/);
});

test('an already-running memory server is used and never stopped', async () => {
  const p = port();
  const url = `http://127.0.0.1:${p}`;
  const server = http.createServer((req, res) => res.end('{"ok":true}'));
  await new Promise((r) => server.listen(p, '127.0.0.1', r));
  let spawned = false;
  const sup = new MemorySupervisor({ repoRoot: root, url, spawnImpl: () => { spawned = true; } });
  assert.equal(await sup.start(), true);
  assert.equal(sup.state, 'external');
  assert.equal(spawned, false);
  sup.stop();
  assert.equal((await fetch(`${url}/health`)).ok, true, 'still running');
  await new Promise((r) => server.close(r));
});

test('a memory that never answers is reported as failed, not hung', async () => {
  const bad = mkdtempSync(path.join(os.tmpdir(), 'kindred-sup-bad-'));
  mkdirSync(path.join(bad, 'memory/src'), { recursive: true });
  writeFileSync(path.join(bad, 'memory/src/server.mjs'), 'setInterval(() => {}, 1000);');
  const sup = new MemorySupervisor({ repoRoot: bad, url: `http://127.0.0.1:${port()}`, readyTimeoutMs: 600 });
  assert.equal(await sup.start(), false);
  assert.equal(sup.state, 'failed');
  sup.stop();
});
