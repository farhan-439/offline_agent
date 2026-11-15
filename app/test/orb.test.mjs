// One-orb menu states and the live-translation wiring in core. A stub bridge stands in for
// kindred-capture, so this tests the app's side of the translation interface only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { orbMenuState, languageName, elapsed, routeIntent } from '../view.mjs';
import { KindredApp, MAX_TRANSLATIONS } from '../core.mjs';

const cap = { available: true };
const snap = (recording = {}, ask = { phase: 'idle' }) => ({ capture: cap, recording: { phase: 'idle', mode: 'conversation', ...recording }, ask });

test('menu: idle offers all three choices', () => {
  const m = orbMenuState(snap());
  assert.equal(m.active, null);
  assert.deepEqual([m.record.label, m.ask.label, m.translate.label], ['Start recording', 'Ask a question', 'Live translation']);
  assert.ok(!m.record.disabled && !m.ask.disabled && !m.translate.disabled);
});

test('menu: while recording, only Stop recording is available', () => {
  const m = orbMenuState(snap({ phase: 'recording', mode: 'conversation' }));
  assert.equal(m.active, 'conversation');
  assert.deepEqual([m.record.label, m.record.disabled, m.record.stop], ['Stop recording', false, true]);
  assert.ok(m.ask.disabled && m.translate.disabled);
  assert.match(m.ask.hint, /Stop recording first/);
});

test('menu: while translating, only Stop translating is available', () => {
  const m = orbMenuState(snap({ phase: 'recording', mode: 'translate' }));
  assert.equal(m.active, 'translate');
  assert.deepEqual([m.translate.label, m.translate.disabled], ['Stop translating', false]);
  assert.ok(m.record.disabled && m.ask.disabled);
  assert.match(m.record.hint, /Stop translating first/);
});

test('menu: saving, voice questions, enrollment and missing capture', () => {
  let m = orbMenuState(snap({ phase: 'processing', mode: 'conversation' }));
  assert.deepEqual([m.record.label, m.record.disabled], ['Saving the conversation…', true]);
  m = orbMenuState(snap({}, { phase: 'listening' }));
  assert.equal(m.active, 'ask');
  assert.ok(m.record.disabled && m.translate.disabled && !m.ask.disabled);
  m = orbMenuState(snap({ phase: 'recording', mode: 'enroll' }));
  assert.match(m.record.hint, /voice first/);
  m = orbMenuState({ capture: { available: false, message: 'not built' }, recording: { phase: 'idle' } });
  assert.ok(m.record.disabled && m.translate.disabled);
  assert.equal(m.record.hint, 'not built');
});

test('intent: one tap is routed by what it heard', () => {
  assert.equal(routeIntent('Can you translate this for me?').kind, 'translate');
  assert.equal(routeIntent('start recording').kind, 'record');
  assert.equal(routeIntent('remember this conversation').kind, 'record');
  assert.equal(routeIntent('What did Maya ask me to do?').kind, 'ask');
  assert.equal(routeIntent('what did maya ask me').kind, 'ask');
  assert.equal(routeIntent('I went to the market and bought plums').kind, 'ask');
  assert.equal(routeIntent('hello').kind, null, 'one unclear word leaves the three choices up');
  assert.equal(routeIntent('').kind, null);
  assert.equal(routeIntent('Translate').text, 'Translate', 'the words are kept for the next step');
});

test('helpers: language names and timer', () => {
  assert.equal(languageName('fr'), 'French');
  assert.equal(languageName('es'), 'Spanish');
  assert.equal(languageName(null), 'Another language');
  assert.equal(elapsed(65_400), '1:05');
  assert.equal(elapsed(-5), '0:00');
});

// ---------- core: live translation ----------
class StubBridge {
  constructor({ onEvent }) { this.onEvent = onEvent; this.calls = []; this.spoken = []; this.ingested = []; }
  status() { return { available: true, stt: true, tts: true }; }
  warm() {}
  startRecording(opts) {
    this.calls.push(opts);
    return new Promise((resolve, reject) => { this.finish = resolve; this.fail = reject; });
  }
  stopRecording() { this.finish({ session: 't1', jsonl: '/x/t1.jsonl', audio: '/x/t1.wav', utterances: 3, speakers: 2 }); return true; }
  async speak(text) { this.spoken.push(text); await new Promise((r) => setTimeout(r, 5)); return { spoken: true }; }
  stopSpeaking() {}
  close() {}
}
class StubLive { constructor() {} reset() {} handleSpeaker() {} async ingest(r) { return { sessions: [r.session] }; } }

function makeApp() {
  const events = [];
  const app = new KindredApp({ CaptureBridge: StubBridge, LiveWhisper: StubLive, repoRoot: '/tmp/kindred-orb-test',
    memoryUrl: 'http://127.0.0.1:9', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    emit: (type, payload) => events.push({ type, payload }) });
  return { app, events, bridge: app.bridge };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('live translation: starts capture with translate:true, shows and speaks each translation in order', async () => {
  const { app, events, bridge } = makeApp();
  app.startRecording({ mode: 'translate' });
  assert.equal(app.snapshot().recording.mode, 'translate');
  assert.deepEqual(bridge.calls[0], { place: undefined, translate: true });
  bridge.onEvent({ type: 'mic-live', device: 'AirPods' });
  bridge.onEvent({ type: 'translation', seq: 1, language: 'fr', text: 'Où est la gare ?', translation: 'Where is the station?', start: 0, end: 1.4, final: false });
  bridge.onEvent({ type: 'translation', seq: 2, language: 'fr', text: 'Tournez à gauche.', translation: 'Turn left.', start: 2, end: 3, final: false });
  bridge.onEvent({ type: 'translation', seq: 3, language: 'en', text: 'Thank you!', translation: null });
  const rec = app.snapshot().recording;
  assert.equal(rec.phase, 'recording');
  assert.deepEqual(rec.translations.map((t) => [t.language, t.translation]), [['fr', 'Where is the station?'], ['fr', 'Turn left.'], ['en', null]]);
  assert.equal(events.filter((e) => e.type === 'translation').length, 3);
  await app.translationSpeech;
  assert.deepEqual(bridge.spoken, ['Where is the station?', 'Turn left.'], 'English lines are not spoken; order kept');
  app.stopRecording();
  await app.recordingTask;
  const done = events.find((e) => e.type === 'recording-done').payload;
  assert.equal(done.mode, 'translate');
  assert.equal(done.ingested, true, 'the translated conversation is saved to memory like any other');
  assert.equal(app.snapshot().recording.mode, 'conversation', 'back to normal afterwards');
});

test('live translation: a repeated seq replaces the earlier line, and only the latest lines are kept', async () => {
  const { app, bridge } = makeApp();
  app.startRecording({ mode: 'translate' });
  bridge.onEvent({ type: 'translation', seq: 1, language: 'es', text: 'Hola', translation: 'Hello' });
  bridge.onEvent({ type: 'translation', seq: 1, language: 'es', text: 'Hola, ¿qué tal?', translation: 'Hello, how are you?' });
  assert.deepEqual(app.snapshot().recording.translations.map((t) => t.translation), ['Hello, how are you?']);
  for (let i = 2; i < 30; i++) bridge.onEvent({ type: 'translation', seq: i, language: 'es', text: `x${i}`, translation: `y${i}` });
  const kept = app.snapshot().recording.translations;
  assert.equal(kept.length, MAX_TRANSLATIONS);
  assert.equal(kept.at(-1).translation, 'y29');
  bridge.stopRecording(); await app.recordingTask; await tick();
});

test('a normal recording does not ask capture to translate', async () => {
  const { app, bridge } = makeApp();
  app.startRecording({});
  assert.deepEqual(bridge.calls[0], { place: undefined });
  bridge.stopRecording(); await app.recordingTask;
});
