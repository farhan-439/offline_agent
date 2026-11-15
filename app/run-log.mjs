// A JSON-lines record of a real-world run, for calibration and debugging: recognition scores, whispers,
// translations, replies, questions, errors, with timestamps. data/logs/run-YYYY-MM-DD.jsonl (gitignored,
// stays on this Mac). Voiceprints themselves are never written, only scores. KINDRED_LOG=0 turns it off.
// Read it with: node scripts/analyze-run.mjs
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DROP = new Set(['voiceprint', 'vector', 'embedding']);
// Capture's own stderr lines worth keeping (timings and problems), not its chatter.
const KEEP_LOG = /translate #|muted|dropped \d|wrote \d+ utterances|error|failed|unavailable|ready in|license|mic|exited/i;

export class RunLog {
  constructor({ repoRoot, enabled = process.env.KINDRED_LOG !== '0', file = null, now = () => new Date() } = {}) {
    this.enabled = enabled;
    this.now = now;
    this.file = file || path.join(repoRoot, 'data/logs', `run-${now().toISOString().slice(0, 10)}.jsonl`);
    if (enabled) { try { mkdirSync(path.dirname(this.file), { recursive: true }); } catch { this.enabled = false; } }
  }

  write(type, data = {}) {
    if (!this.enabled) return;
    if ((type === 'log' || type === 'capture-log') && !KEEP_LOG.test(String(data.message ?? data))) return;
    const clean = typeof data === 'object' && data ? Object.fromEntries(Object.entries(data).filter(([k]) => !DROP.has(k))) : { message: String(data) };
    try { appendFileSync(this.file, `${JSON.stringify({ t: this.now().toISOString(), ...clean, type })}\n`); } catch { /* never break the app over a log line */ }
  }
}
