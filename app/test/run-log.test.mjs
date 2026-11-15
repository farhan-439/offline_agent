import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunLog } from '../run-log.mjs';

test('run log: keeps its own event type, never writes voiceprints, skips capture chatter', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kindred-log-'));
  const log = new RunLog({ repoRoot: root, enabled: true });
  log.write('capture-speaker', { type: 'speaker', speaker: 'L1', seconds: 2.6, voiceprint: [0.1, 0.2] });
  log.write('capture-log', { message: 'loading tokenizer…' });
  log.write('capture-log', { message: 'translate #1 1.2-2.9s fr (0.99): 1340 ms after speech ended' });
  log.write('ask', { question: 'Where is the key?', ms: 812, grounded: true });
  const lines = readFileSync(log.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ['capture-speaker', 'capture-log', 'ask']);
  assert.equal(lines[0].voiceprint, undefined);
  assert.equal(lines[0].speaker, 'L1');
  assert.match(lines[1].message, /translate #1/);
  assert.ok(log.file.startsWith(path.join(root, 'data/logs/run-')));
});

test('run log: KINDRED_LOG=0 / enabled:false writes nothing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kindred-log-'));
  const log = new RunLog({ repoRoot: root, enabled: false });
  log.write('ask', { question: 'x' });
  assert.throws(() => readFileSync(log.file));
});
