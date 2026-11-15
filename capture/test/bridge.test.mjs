// Protocol tests for bridge.mjs against a fake `kindred-capture serve` (no models, no mic).
// Proves the Node⇄Swift plumbing only; real audio must be checked with the built binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureBridge } from '../bridge.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kindred-bridge-'));
const fake = path.join(dir, 'fake-capture');
writeFileSync(fake, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ event: 'ready', stt: true, diarize: true, tts: true });
let rec = null;
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const c = JSON.parse(l);
  if (c.cmd === 'record-start') { rec = c.id; out({ event: 'recording', id: c.id, session: c.session || 's1' }); out({ event: 'mic-live', id: c.id, device: 'Fake Mic' }); }
  else if (c.cmd === 'record-stop') { out({ event: 'processing', id: rec }); out({ id: rec, session: 's1', jsonl: '/x/s1.jsonl', audio: '/x/s1.wav', utterances: 3, speakers: 2 }); }
  else if (c.cmd === 'record-cancel') out({ id: rec, error: 'Recording cancelled.' });
  else if (c.cmd === 'speak') out({ id: c.id, spoken: true, text: c.text });
  else if (c.cmd === 'process') out({ id: c.id, error: 'Existing audio file is required.' });
  else if (c.cmd === 'die') process.exit(3);
});
`);
chmodSync(fake, 0o755);

const make = (events = []) => new CaptureBridge({ binary: fake, sayBinary: '/nonexistent', onEvent: (e) => events.push(e) });

test('record → stop resolves with the session file and forwards events', async () => {
  const events = [];
  const b = make(events);
  const rec = b.startRecording({ place: 'porch' });
  b.stopRecording(); // before the helper is ready: must be queued, not lost
  const r = await rec;
  assert.equal(r.jsonl, '/x/s1.jsonl');
  assert.equal(r.utterances, 3);
  assert.ok(events.some((e) => e.type === 'mic-live' && e.device === 'Fake Mic'));
  assert.ok(events.some((e) => e.type === 'processing'));
  assert.equal(b.status().recording, false);
  b.close();
});

test('cancel rejects the recording', async () => {
  const b = make();
  await b.whenReady();
  const rec = b.startRecording();
  await new Promise((r) => setTimeout(r, 50));
  b.cancelRecording();
  await assert.rejects(rec, /cancelled/);
  b.close();
});

test('speak uses Argmax TTS once loaded', async () => {
  const b = make();
  await b.whenReady();
  const r = await b.speak('  This is Maya,\n your neighbour. ');
  assert.equal(r.spoken, true);
  assert.equal(r.text, 'This is Maya, your neighbour.');
  b.close();
});

test('helper errors and crashes reject pending requests', async () => {
  const b = make();
  await assert.rejects(b.processFile('/missing.wav'), /audio file/);
  const pending = b.request({ cmd: 'die' }).promise;
  await assert.rejects(pending, /exited \(3\)/);
  b.close();
});

test('missing binary fails clearly', () => {
  assert.throws(() => new CaptureBridge({ binary: '/nope' }).warm(), /not built/);
});
