// Main-process wiring tests. The real CaptureBridge drives a fake `kindred-capture serve` script
// (same pattern as capture/test/bridge.test.mjs), the real LiveWhisper talks to a fake memory HTTP
// server on a random port. Plumbing only: no models, mic, Bonsai or Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync, chmodSync, mkdtempSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureBridge } from '../../capture/bridge.mjs';
import { LiveWhisper } from '../../capture/live.mjs';
import { KindredApp, MEMORY_DOWN, localFetch, voiceFromSession } from '../core.mjs';
import { voiceLabel, dockSummary, recordButtonState, formatClipTime, enrollButtonState } from '../view.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kindred-app-'));
mkdirSync(path.join(dir, 'data/audio'), { recursive: true });
writeFileSync(path.join(dir, 'data/audio/s1.wav'), 'RIFF');
const fake = path.join(dir, 'fake-capture');
writeFileSync(fake, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ event: 'ready', stt: true, diarize: true, tts: true });
let rec = null;
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const c = JSON.parse(l);
  if (c.cmd === 'record-start' && c.live === false) {
    // Enrollment: like real serve with live:false — no live speaker events; on stop, a real session
    // file under data/ whose speakers come from FAKE_ENROLL (JSON array of {seconds, voiceprint}).
    rec = { id: c.id, session: c.session, outDir: c.outDir, audioDir: c.audioDir };
    out({ event: 'recording', id: c.id, session: c.session });
    out({ event: 'mic-live', id: c.id, device: 'Fake AirPods' });
  } else if (c.cmd === 'record-stop' && rec && rec.session) {
    const fs = require('node:fs'), path = require('node:path');
    if (process.env.FAKE_ENROLL_ERROR) { out({ id: rec.id, error: process.env.FAKE_ENROLL_ERROR }); rec = null; return; }
    const root = ${JSON.stringify(dir)};
    const jsonl = path.join(rec.outDir || path.join(root, 'data/inbox'), rec.session + '.jsonl');
    const wav = path.join(rec.audioDir || path.join(root, 'data/audio'), rec.session + '.wav');
    fs.mkdirSync(path.dirname(jsonl), { recursive: true });
    fs.mkdirSync(path.dirname(wav), { recursive: true });
    const speakers = JSON.parse(process.env.FAKE_ENROLL || '[]');
    const lines = rec.session.startsWith('ask-')
      ? [{ type: 'utterance', session: rec.session, id: rec.session + '#0001', speaker: 'S0', start: 0, end: 2, text: 'Where is my spare key?' }]
      : speakers.map((s, i) => ({ type: 'speaker', session: rec.session, speaker: 'S' + i, voiceprint: s.voiceprint, seconds: s.seconds, final: true }));
    fs.writeFileSync(jsonl, lines.map((line) => JSON.stringify(line)).join('\\n'));
    fs.writeFileSync(wav, 'RIFF');
    out({ event: 'processing', id: rec.id });
    out({ id: rec.id, session: rec.session, jsonl, audio: wav, utterances: 3, speakers: speakers.length });
    rec = null;
  } else if (c.cmd === 'record-start') {
    rec = c.id;
    out({ event: 'recording', id: c.id, session: 's1' });
    out({ event: 'mic-live', id: c.id, device: 'Fake AirPods' });
    out({ event: 'live', id: c.id, engine: 'sortformer' });
    out({ event: 'speaker', id: c.id, speaker: 'L1', voiceprint: [0.1, 0.9], seconds: 2.6, final: false, engine: 'sortformer' });
    out({ event: 'speaker', id: c.id, speaker: 'L2', voiceprint: [0.9, 0.1], seconds: 2.7, final: false, engine: 'sortformer' });
    out({ event: 'speaker', id: c.id, speaker: 'L1', voiceprint: [0.1, 0.9], seconds: 8.1, final: false, engine: 'sortformer' });
  } else if (c.cmd === 'record-stop') { out({ event: 'processing', id: rec }); out({ id: rec, session: 's1', jsonl: '/x/s1.jsonl', audio: '/x/s1.wav', utterances: 4, speakers: 2 }); }
  else if (c.cmd === 'record-cancel') out({ id: rec, error: 'Recording cancelled.' });
  else if (c.cmd === 'speak') { out({ event: 'speaking', id: c.id, device: 'Fake AirPods' }); out({ id: c.id, spoken: true, text: c.text }); }
});
`);
chmodSync(fake, 0o755);

const MAYA = { type: 'identity', personId: 'p_maya', name: 'Maya', score: 0.93, whisper: 'This is Maya, your neighbour. You promised to water her tomatoes.' };

/** Fake memory service. Routes can be overridden per test. */
async function fakeMemory(overrides = {}) {
  const calls = [];
  const routes = {
    'GET /health': () => ({ ok: true }),
    'POST /identify': (b) => (b.voiceprint[0] < 0.5 ? MAYA : { type: 'identity', personId: null, score: 0.3, whisper: null }),
    'POST /ingest': () => ({ sessions: ['s1'] }),
    'POST /dock': () => ({ sessions: ['s1'], episodes: 2, facts: 3, people: ['Maya'] }),
    // Same shape as memory's real peopleGraph(): is_owner / voice_samples.
    'GET /people': () => ({ people: [{ id: 'p_me', name: 'Me', relation: 'device owner', is_owner: 1, core: null, facts: 0, voice_samples: 2 },
      { id: 'p_maya', name: 'Maya', relation: 'neighbour', is_owner: 0, core: 'Maya lives next door.', facts: 3, voice_samples: 1 }], relations: [] }),
    'POST /ask': () => ({ answer: 'Dr. Patel raised lisinopril to 10 mg.', grounded: true, cites: [1],
      sources: [{ ref: 'F1', layer: 'fact', text: 'Dr. Patel raised lisinopril to 10 mg.', when: '2026-11-14T16:02:11Z' }],
      photos: [{ id: 'P1', caption: 'The prescription label', taken_at: '2026-11-14T16:02:11Z' }],
      clips: [{ id: 'd1#2', speaker: 'Dr. Patel', text: "Let's go to 10 mg.", audio: 'data/audio/s1.wav', start: 31.4, end: 36.1, started_at: '2026-11-14T16:02:11Z' },
        { id: 'd1#3', speaker: 'Dr. Patel', text: 'Every morning.', audio: 'data/audio/gone.wav', start: 40, end: 42 }] }),
    ...overrides,
  };
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const c of req) text += c;
    const body = text ? JSON.parse(text) : null;
    calls.push({ route: `${req.method} ${req.url}`, body });
    const fn = routes[`${req.method} ${req.url}`];
    const data = fn ? await fn(body) : { error: 'unknown route' };
    const status = !fn ? 404 : data instanceof Error ? 500 : 200;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data instanceof Error ? { error: data.message } : data));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

function makeApp(memoryUrl, extra = {}) {
  const events = [];
  const app = new KindredApp({
    CaptureBridge, LiveWhisper, repoRoot: dir, memoryUrl,
    bridgeOptions: { binary: fake, sayBinary: '/nonexistent', outDir: dir, audioDir: dir },
    emit: (type, payload) => events.push({ type, payload }),
    ...extra,
  });
  return { app, events };
}
const until = async (cond, ms = 2000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

test('record: mic name, live voices, whisper for a known voice, ingest after stop', async () => {
  const mem = await fakeMemory();
  const { app, events } = makeApp(mem.url);
  await app.start();
  assert.equal(app.snapshot().memory.ok, true);
  app.startRecording({ place: 'porch' });
  await until(() => events.some((e) => e.type === 'whisper'));
  const snap = app.snapshot();
  assert.equal(snap.recording.phase, 'recording');
  assert.equal(snap.recording.device, 'Fake AirPods');
  assert.equal(snap.recording.engine, 'sortformer');
  await until(() => app.snapshot().recording.voices.every((v) => v.checked));
  const voices = app.snapshot().recording.voices;
  assert.deepEqual(voices.map((v) => v.speaker), ['L1', 'L2']);
  assert.equal(voices[0].name, 'Maya');
  assert.equal(voices[0].seconds, 8.1, 'refreshed seconds are kept');
  assert.match(voices[0].whisper, /^This is Maya/);
  assert.equal(voices[1].name, null);
  const whisper = events.find((e) => e.type === 'whisper').payload;
  assert.equal(whisper.name, 'Maya');
  assert.equal(mem.calls.filter((c) => c.route === 'POST /identify').length, 2, 'Maya identified once, unknown L2 once');

  app.stopRecording();
  await until(() => events.some((e) => e.type === 'recording-done'));
  const done = events.find((e) => e.type === 'recording-done').payload;
  assert.equal(done.ok, true);
  assert.equal(done.ingested, true);
  assert.deepEqual(mem.calls.find((c) => c.route === 'POST /ingest').body, { file: '/x/s1.jsonl' });
  assert.equal(app.snapshot().recording.phase, 'idle');
  assert.equal(app.snapshot().recording.last.utterances, 4);
  await app.live.speaking;
  assert.ok(events.some((e) => e.type === 'speaking'), 'whisper went to Argmax TTS');
  app.close(); await mem.close();
});

test('recording still works when memory is down, and says how to start it', async () => {
  const { app, events } = makeApp('http://127.0.0.1:9');
  await app.start();
  assert.equal(app.snapshot().memory.ok, false);
  assert.equal(app.snapshot().memory.message, MEMORY_DOWN);
  app.startRecording();
  await until(() => app.snapshot().recording.voices.length === 2 && app.snapshot().recording.voices.every((v) => v.error));
  app.stopRecording();
  await until(() => events.some((e) => e.type === 'recording-done'));
  const done = events.find((e) => e.type === 'recording-done').payload;
  assert.equal(done.ok, true);
  assert.equal(done.ingested, false);
  assert.match(done.ingestError, /npm run server/);
  assert.ok(!events.some((e) => e.type === 'whisper'));
  app.close();
});

test('dock, people and ask reject with MEMORY_DOWN instead of crashing', async () => {
  const { app } = makeApp('http://127.0.0.1:9');
  for (const call of [() => app.dock(), () => app.people(), () => app.ask('hi')]) {
    await assert.rejects(call(), (e) => e.code === 'MEMORY_DOWN' && /cd memory && npm run server/.test(e.message));
  }
  app.close();
});

test('dock calls /dock then returns the people roster', async () => {
  const mem = await fakeMemory();
  const { app } = makeApp(mem.url);
  const r = await app.dock();
  assert.equal(r.report.facts, 3);
  const [me, maya] = r.people;
  assert.equal(maya.name, 'Maya');
  assert.equal(maya.relation, 'neighbour');
  assert.deepEqual([me.owner, me.voiceSamples, maya.owner, maya.voiceSamples], [true, 2, false, 1], 'is_owner/voice_samples normalised');
  assert.deepEqual(mem.calls.map((c) => c.route), ['POST /dock', 'GET /people']);
  app.close(); await mem.close();
});

test('ask returns the answer, speaks it, and maps clips to playable file URLs', async () => {
  const mem = await fakeMemory();
  const { app, events } = makeApp(mem.url);
  await app.bridge.whenReady();
  const r = await app.ask('  What did the doctor change?  ');
  assert.deepEqual(mem.calls.at(-1), { route: 'POST /ask', body: { question: 'What did the doctor change?' } });
  assert.equal(r.answer, 'Dr. Patel raised lisinopril to 10 mg.');
  assert.deepEqual(r.cites, [1]);
  assert.equal(r.sources[0].ref, 'F1');
  assert.equal(r.photos[0].url, `${mem.url}/photo/P1`);
  assert.equal(r.clips.length, 2);
  const [a, b] = r.clips;
  assert.equal(a.audio, path.join(dir, 'data/audio/s1.wav'), 'relative audio path resolved from repo root');
  assert.ok(a.url.startsWith('file://') && a.url.endsWith('s1.wav#t=31.4,36.1'));
  assert.equal(a.speaker, 'Dr. Patel');
  assert.equal(b.exists, false);
  assert.equal(b.url, null, 'missing audio is not offered for playback');
  await until(() => events.some((e) => e.type === 'speaking'));
  app.close(); await mem.close();
});

test('orb voice question is transcribed, answered aloud, and discarded without ingest', async () => {
  const mem = await fakeMemory({ 'POST /ask': (body) => ({ answer: `The saved answer to ${body.question}`, grounded: true,
    cites: ['N1'], sources: [{ ref: 'N1', layer: 'input', text: 'The spare key is under the flower pot.' }] }) });
  const { app, events } = makeApp(mem.url);
  await app.start();
  assert.deepEqual(app.startAskListening(), { started: true });
  await until(() => app.snapshot().ask.phase === 'listening');
  assert.throws(() => app.startRecording(), /Already recording/);
  assert.equal(app.stopAskListening(), true);
  await until(() => events.some((event) => event.type === 'ask-answer'));
  const answer = events.find((event) => event.type === 'ask-answer').payload;
  assert.equal(answer.question, 'Where is my spare key?');
  assert.deepEqual(answer.cites, ['N1']);
  assert.ok(!mem.calls.some((call) => call.route === 'POST /ingest'), 'the question is not saved as a conversation');
  await until(() => app.snapshot().ask.phase === 'idle');
  assert.equal(readdirSync(path.join(dir, 'data/ask-tmp')).some((name) => name.startsWith('ask-')), false);
  app.close(); await mem.close();
});

test('interrupted voice-question files are cleared when the app starts again', () => {
  const folder = path.join(dir, 'data/ask-tmp');
  mkdirSync(folder, { recursive: true });
  const stale = path.join(folder, 'ask-2026-11-15T03-53-02-681Z.wav');
  writeFileSync(stale, 'RIFF');
  const { app } = makeApp('http://127.0.0.1:8787');
  assert.equal(existsSync(stale), false);
  app.close();
});

test('memory errors are surfaced, not swallowed', async () => {
  const mem = await fakeMemory({ 'POST /ask': () => new Error('Bonsai is not reachable at http://127.0.0.1:8080/v1') });
  const { app } = makeApp(mem.url);
  await assert.rejects(app.ask('hi'), /Bonsai is not reachable/);
  await assert.rejects(app.ask('   '), /Type a question/);
  app.close(); await mem.close();
});

test('missing capture binary disables recording with a build hint', async () => {
  const mem = await fakeMemory();
  const { app } = makeApp(mem.url, { bridgeOptions: { binary: '/nope/kindred-capture' } });
  await app.start();
  assert.equal(app.snapshot().capture.available, false);
  assert.match(app.snapshot().capture.message, /npm run build/);
  assert.throws(() => app.startRecording(), /not built/);
  assert.equal(recordButtonState('idle', app.snapshot().capture).disabled, true);
  app.close(); await mem.close();
});

test('a crashed helper reports its last error line', async () => {
  const crash = path.join(dir, 'crash-capture');
  writeFileSync(crash, `#!/usr/bin/env node
process.stderr.write('whisper ready\\nerror: The model is not found at URL: file:///x/SpeakerSegmenter.mlmodelc\\n');
setTimeout(() => process.exit(1), 50);
`);
  chmodSync(crash, 0o755);
  const { app, events } = makeApp('http://127.0.0.1:9', { bridgeOptions: { binary: crash } });
  await app.start();
  app.startRecording();
  await until(() => events.some((e) => e.type === 'recording-done'));
  assert.match(app.snapshot().capture.message, /exited \(1\)\. error: The model is not found/);
  assert.match(events.find((e) => e.type === 'recording-done').payload.error, /exited \(1\)/);
  app.close();
});

test('cancel ends the recording without ingesting', async () => {
  const mem = await fakeMemory();
  const { app, events } = makeApp(mem.url);
  app.startRecording();
  await until(() => app.snapshot().recording.phase === 'recording');
  assert.throws(() => app.startRecording(), /Already recording/);
  app.cancelRecording();
  await until(() => events.some((e) => e.type === 'recording-done'));
  assert.equal(events.find((e) => e.type === 'recording-done').payload.cancelled, true);
  assert.ok(!mem.calls.some((c) => c.route === 'POST /ingest'));
  assert.equal(app.snapshot().recording.error, null);
  app.close(); await mem.close();
});

test('localFetch times out a hung /health', async () => {
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await assert.rejects(localFetch(`http://127.0.0.1:${server.address().port}/health`, { timeoutMs: 100 }), /timed out/);
  server.closeAllConnections(); server.close();
});

test('view helpers', () => {
  assert.equal(voiceLabel({ speaker: 'L1', name: 'Maya' }), 'Maya');
  assert.equal(voiceLabel({ speaker: 'L1', owner: true, name: 'Me' }), 'You');
  assert.match(voiceLabel({ speaker: 'L2', checked: true }), /not someone I know/);
  assert.match(voiceLabel({ speaker: 'L2' }), /listening/);
  assert.equal(dockSummary({ sessions: ['a', 'b'], episodes: 3, facts: 1 }), 'Docked 2 conversations: 3 topics, 1 new fact.');
  assert.match(dockSummary({ sessions: [] }), /Nothing new/);
  assert.equal(formatClipTime({ date: '2026-11-14T16:02:11Z', start: 61.2, end: 66 }), '2026-11-14 · 1:01–1:06');
  assert.equal(recordButtonState('recording', { available: true }).label, 'Stop');
  assert.equal(recordButtonState('processing', { available: true }).disabled, true);
});

// ---------- "Teach Kindred my voice" ----------
async function enrollWith(speakers, memOverrides = {}, env = {}) {
  process.env.FAKE_ENROLL = JSON.stringify(speakers);
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const enrolled = [];
  const mem = await fakeMemory({ 'POST /enroll-owner': (b) => { enrolled.push(b); return { personId: 'p_me', samples: enrolled.length }; }, ...memOverrides });
  const { app, events } = makeApp(mem.url);
  await app.start();
  app.enrollOwner();
  await until(() => app.snapshot().recording.phase === 'recording');
  const during = app.snapshot().recording;
  app.stopRecording();
  await until(() => events.some((e) => e.type === 'enroll-done'));
  for (const k of ['FAKE_ENROLL', ...Object.keys(env)]) delete process.env[k];
  const done = events.find((e) => e.type === 'enroll-done').payload;
  return { app, events, mem, enrolled, done, during };
}

test('enroll: the longest voice is sent to /enroll-owner, live whisper stays off, the sample is deleted', async () => {
  const { app, events, mem, enrolled, done, during } = await enrollWith([{ seconds: 17.5, voiceprint: [0.6, 0.8] }, { seconds: 1.2, voiceprint: [0.9, 0.1] }]);
  assert.equal(during.mode, 'enroll');
  assert.equal(done.ok, true);
  assert.equal(done.samples, 1);
  assert.equal(done.seconds, 17.5);
  assert.equal(done.note, null, 'a stray 1 s fragment is not "more than one voice"');
  assert.deepEqual(enrolled, [{ voiceprint: [0.6, 0.8] }]);
  assert.equal(mem.calls.filter((c) => c.route === 'POST /identify').length, 0, 'no identify while enrolling');
  assert.equal(mem.calls.filter((c) => c.route === 'POST /ingest').length, 0, 'the sample is not stored as a conversation');
  assert.ok(!events.some((e) => e.type === 'recording-done'));
  const inbox = readdirSync(path.join(dir, 'data/inbox')).filter((f) => f.startsWith('enroll-'));
  const audio = readdirSync(path.join(dir, 'data/audio')).filter((f) => f.startsWith('enroll-'));
  assert.deepEqual([inbox, audio], [[], []], 'enrollment files deleted');
  assert.equal(app.snapshot().recording.phase, 'idle');
  assert.equal(app.snapshot().recording.last.enrolled, true);
  app.close(); await mem.close();
});

test('enroll: too little speech is refused with a clear message and nothing is enrolled', async () => {
  const { app, mem, enrolled, done } = await enrollWith([{ seconds: 3.1, voiceprint: [0.6, 0.8] }]);
  assert.equal(done.ok, false);
  assert.match(done.error, /only heard 3 s/);
  assert.equal(enrolled.length, 0);
  app.close(); await mem.close();
});

test('enroll: two real voices still enroll the main one, with a "record alone" note', async () => {
  const { app, mem, done } = await enrollWith([{ seconds: 12, voiceprint: [0.6, 0.8] }, { seconds: 9, voiceprint: [0.9, 0.1] }]);
  assert.equal(done.ok, true);
  assert.match(done.note, /record alone/);
  app.close(); await mem.close();
});

test('enroll: no speech and memory down give useful errors', async () => {
  let r = await enrollWith([], {}, { FAKE_ENROLL_ERROR: 'No speech was heard.' });
  assert.equal(r.done.ok, false);
  assert.match(r.done.error, /didn't hear you/);
  r.app.close(); await r.mem.close();
  r = await enrollWith([{ seconds: 15, voiceprint: [0.6, 0.8] }], { 'POST /enroll-owner': () => new Error('db locked') });
  assert.equal(r.done.ok, false);
  assert.match(r.done.error, /db locked/);
  r.app.close(); await r.mem.close();
});

test('enroll: refused while a conversation is recording', async () => {
  const mem = await fakeMemory();
  const { app } = makeApp(mem.url);
  await app.start();
  app.startRecording();
  assert.throws(() => app.enrollOwner(), /Stop the current recording/);
  await until(() => app.snapshot().recording.phase === 'recording');
  app.cancelRecording();
  await until(() => app.snapshot().recording.phase === 'idle');
  app.close(); await mem.close();
});

test('voiceFromSession picks the longest voice and reports its share', () => {
  const lines = [
    { type: 'utterance', speaker: 'S0', text: 'hi' },
    { type: 'speaker', speaker: 'S0', voiceprint: [1, 0], seconds: 4 },
    { type: 'speaker', speaker: 'S1', voiceprint: [0, 1], seconds: 12 },
    { type: 'speaker', speaker: 'S2', voiceprint: null, seconds: 30 },
  ].map((e) => JSON.stringify(e)).join('\n');
  const v = voiceFromSession(lines);
  assert.deepEqual(v.voiceprint, [0, 1]);
  assert.equal(v.seconds, 12);
  assert.equal(v.voices, 2, 'speakers without a voiceprint are ignored');
  assert.equal(v.share, 0.75);
  assert.equal(voiceFromSession(''), null);
});

test('enroll button states', () => {
  const cap = { available: true };
  assert.equal(enrollButtonState({ phase: 'idle' }, cap, false).label, 'Teach Kindred my voice');
  assert.equal(enrollButtonState({ phase: 'idle' }, cap, true).label, 'Record my voice again');
  const reading = enrollButtonState({ phase: 'recording', mode: 'enroll' }, cap);
  assert.deepEqual([reading.label, reading.reading, reading.disabled], ['Done reading', true, false]);
  assert.equal(enrollButtonState({ phase: 'processing', mode: 'enroll' }, cap).disabled, true);
  assert.equal(enrollButtonState({ phase: 'recording', mode: 'conversation' }, cap).disabled, true, 'not during a conversation');
  assert.equal(enrollButtonState({ phase: 'idle' }, { available: false, message: 'not built' }).disabled, true);
});

test('after enrolling (success or failure), Record works again', async () => {
  for (const speakers of [[{ seconds: 15, voiceprint: [0.6, 0.8] }], [{ seconds: 2, voiceprint: [0.6, 0.8] }]]) {
    const { app, events, mem, done } = await enrollWith(speakers);
    const rec = app.snapshot().recording;
    assert.equal(rec.phase, 'idle');
    assert.equal(rec.mode, 'conversation', `mode reset after ${done.ok ? 'success' : 'failure'}`);
    assert.equal(recordButtonState(rec.phase, app.snapshot().capture).disabled, false, 'Record button enabled');
    app.startRecording({ place: 'porch' });
    await until(() => app.snapshot().recording.phase === 'recording');
    assert.equal(app.snapshot().recording.mode, 'conversation');
    app.stopRecording();
    await until(() => events.some((e) => e.type === 'recording-done'));
    assert.equal(events.find((e) => e.type === 'recording-done').payload.ok, true);
    app.close(); await mem.close();
  }
});
