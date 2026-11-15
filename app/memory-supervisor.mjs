// Keeps the memory service (memory/src/server.mjs, Farhan's code, run unchanged) alive for the app:
//   - if one is already answering /health, use it and leave it alone ("external");
//   - otherwise start it with the app's own Node (Electron runs as Node 24: ELECTRON_RUN_AS_NODE),
//     restart it if it dies (backoff 1 → 2 → 4 … 15 s), and stop it when the app quits.
// Its output goes to data/logs/memory.log. KINDRED_DB picks the database (the launcher sets it).
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';

export class MemorySupervisor {
  constructor({
    repoRoot,
    url = process.env.KINDRED_MEMORY_URL || 'http://127.0.0.1:8787',
    db = process.env.KINDRED_DB || null,
    execPath = process.execPath,
    spawnImpl = spawn,
    fetchImpl = globalThis.fetch,
    logFile = path.join(repoRoot, 'data/logs/memory.log'),
    onEvent = () => {},
    readyTimeoutMs = 30000,
    backoffMs = [1000, 2000, 4000, 8000, 15000],
  }) {
    Object.assign(this, { repoRoot, url: url.replace(/\/$/, ''), db, execPath, spawnImpl, fetchImpl, logFile, onEvent, readyTimeoutMs, backoffMs });
    this.child = null;
    this.state = 'idle'; // idle | external | starting | running | restarting | stopped | failed
    this.restarts = 0;
    this.stopping = false;
    this.timer = null;
  }

  async healthy(timeoutMs = 1500) {
    try { return (await this.fetchImpl(`${this.url}/health`, { signal: AbortSignal.timeout(timeoutMs) })).ok; } catch { return false; }
  }

  set(state, extra = {}) { this.state = state; this.onEvent({ type: 'memory-supervisor', state, ...extra }); }

  /** Resolves once memory answers /health (or with false if it never did). Never throws. */
  async start() {
    this.stopping = false;
    if (await this.healthy()) { this.set('external', { message: `Using the memory server already running at ${this.url}` }); return true; }
    return this.launch();
  }

  async launch() {
    const port = new URL(this.url).port || '8787';
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', KINDRED_PORT: port };
    if (this.db) env.KINDRED_DB = path.resolve(this.repoRoot, this.db);
    let log = null;
    try { mkdirSync(path.dirname(this.logFile), { recursive: true }); log = createWriteStream(this.logFile, { flags: 'a' }); } catch { /* logging is optional */ }
    log?.write(`\n--- ${new Date().toISOString()} starting memory (db: ${env.KINDRED_DB || 'default data/kindred.sqlite'})\n`);
    this.set(this.restarts ? 'restarting' : 'starting', { db: env.KINDRED_DB || null });
    const child = this.spawnImpl(this.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.mjs'],
      { cwd: path.join(this.repoRoot, 'memory'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout?.on('data', (d) => log?.write(d));
    child.stderr?.on('data', (d) => log?.write(d));
    child.on('error', (e) => log?.write(`spawn error: ${e.message}\n`));
    child.on('exit', (code, signal) => {
      log?.write(`--- memory exited (${signal || code})\n`);
      log?.end();
      if (this.child === child) this.child = null;
      if (this.stopping) { this.set('stopped'); return; }
      // Died on its own: restart with backoff, unless another server took the port meanwhile.
      const wait = this.backoffMs[Math.min(this.restarts, this.backoffMs.length - 1)];
      this.restarts += 1;
      this.set('restarting', { code, signal, inMs: wait, restarts: this.restarts });
      this.timer = setTimeout(async () => {
        if (this.stopping) return;
        if (await this.healthy()) { this.set('external', { message: 'Another memory server answered; using it' }); return; }
        this.launch();
      }, wait);
      this.timer.unref?.();
    });
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline && this.child === child && !this.stopping) {
      if (await this.healthy(1000)) { this.set('running', { pid: child.pid }); return true; }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (this.child === child && !this.stopping) this.set('failed', { message: `Memory did not answer within ${this.readyTimeoutMs / 1000} s. See data/logs/memory.log` });
    return false;
  }

  /** Stop memory only if we started it. */
  stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    const child = this.child;
    if (!child) return;
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000).unref?.();
  }
}
