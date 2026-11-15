// One-orb menu states and the live-translation wiring in core. A stub bridge stands in for
// kindred-capture, so this tests the app's side of the translation interface only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { orbMenuState, languageName, elapsed } from '../view.mjs';
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

// ---------- two-way: replies ----------
import { replyButtonState, conversationLines } from '../view.mjs';
import { translateReply, replyLanguage, REPLY_LANGUAGES } from '../translate.mjs';

class ReplyBridge extends StubBridge {
  constructor(o) { super(o); this.replyCalls = []; this.spokenIn = []; }
  async replyStart() { this.replyCalls.push('start'); return { replying: true }; }
  async replyStop() { this.replyCalls.push('stop'); return { text: this.nextReply ?? 'Thank you, is it far?', seconds: 2.1 }; }
  async replyCancel() { this.replyCalls.push('cancel'); return { cancelled: true }; }
  async speakIn(text, language) { this.spokenIn.push([text, language]); return { spoken: true, language }; }
}
function replyApp(translate = async (t, l) => ({ translation: `[${l}] ${t}`, language: l })) {
  const events = [];
  const app = new KindredApp({ CaptureBridge: ReplyBridge, LiveWhisper: StubLive, repoRoot: '/tmp/kindred-orb-test',
    memoryUrl: 'http://127.0.0.1:9', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    emit: (type, payload) => events.push({ type, payload }), translate });
  return { app, events, bridge: app.bridge };
}
const heard = (bridge, seq, language) => bridge.onEvent({ type: 'translation', seq, language, text: `orig ${seq}`, translation: `english ${seq}` });

test('reply languages: only German, Chinese, Spanish and French', () => {
  assert.deepEqual(Object.keys(REPLY_LANGUAGES).sort(), ['de', 'es', 'fr', 'zh']);
  assert.equal(replyLanguage('fr-CA'), 'fr');
  assert.equal(replyLanguage('zh'), 'zh');
  for (const l of ['it', 'pt', 'ja', 'ko', 'ru', 'en', null]) assert.equal(replyLanguage(l), null, l);
});

test('reply: English → Bonsai → spoken in the language Kindred last heard', async () => {
  const { app, events, bridge } = replyApp();
  app.startRecording({ mode: 'translate' });
  bridge.onEvent({ type: 'mic-live' });
  heard(bridge, 1, 'fr');
  await app.startReply();
  assert.equal(app.snapshot().recording.reply.phase, 'listening');
  assert.equal(app.snapshot().recording.reply.language, 'fr');
  const item = await app.stopReply();
  assert.deepEqual(bridge.replyCalls, ['start', 'stop']);
  assert.equal(item.english, 'Thank you, is it far?');
  assert.equal(item.translated, '[fr] Thank you, is it far?');
  assert.deepEqual(bridge.spokenIn, [['[fr] Thank you, is it far?', 'fr']]);
  assert.equal(app.snapshot().recording.reply.phase, 'idle');
  assert.ok(events.some((e) => e.type === 'reply'));
  const lines = conversationLines(app.snapshot().recording);
  assert.equal(lines[0].kind, 'reply', 'newest first');
  bridge.stopRecording(); await app.recordingTask;
});

test('reply: unsupported or no language yet → refused with the reason', async () => {
  const { app, bridge } = replyApp();
  app.startRecording({ mode: 'translate' });
  bridge.onEvent({ type: 'mic-live' });
  await assert.rejects(app.startReply(), /German, Chinese, Spanish, French/);
  heard(bridge, 1, 'it');
  await assert.rejects(app.startReply(), /once Kindred has heard/, 'Italian is heard but not a reply language');
  heard(bridge, 2, 'es');
  heard(bridge, 3, 'ja');
  assert.equal(app.replyTarget(), 'es', 'falls back to the last supported language');
  bridge.stopRecording(); await app.recordingTask;
});

test('reply: only during Live translation, and errors leave it usable', async () => {
  const { app, bridge } = replyApp(async () => { throw new Error("Bonsai isn't reachable for translation"); });
  app.startRecording({});
  bridge.onEvent({ type: 'mic-live' });
  await assert.rejects(app.startReply(), /during Live translation/);
  bridge.stopRecording(); await app.recordingTask;
  app.startRecording({ mode: 'translate' });
  bridge.onEvent({ type: 'mic-live' });
  heard(bridge, 1, 'de');
  await app.startReply();
  assert.equal(await app.stopReply(), null);
  const reply = app.snapshot().recording.reply;
  assert.equal(reply.phase, 'idle');
  assert.match(reply.error, /Bonsai isn't reachable/);
  assert.deepEqual(bridge.spokenIn, []);
  await app.startReply();  // can try again
  app.stopRecording();     // stopping mid-reply cancels the reply
  assert.ok(bridge.replyCalls.includes('cancel'));
  await app.recordingTask;
});

test('reply button states', () => {
  const rec = (reply, translations = [{ language: 'zh', at: 1 }]) => ({ mode: 'translate', phase: 'recording', translations, reply });
  assert.equal(replyButtonState({ mode: 'conversation', phase: 'recording' }).hidden, true);
  assert.deepEqual([replyButtonState(rec({ phase: 'idle' }, [])).disabled, replyButtonState(rec({ phase: 'idle' }, [{ language: 'ru' }])).disabled], [true, true]);
  assert.equal(replyButtonState(rec({ phase: 'idle' })).label, '🎙 Reply in Chinese');
  const l = replyButtonState(rec({ phase: 'listening', language: 'zh' }));
  assert.deepEqual([l.label, l.listening, l.disabled], ['■ Done, say it in Chinese', true, false]);
  assert.equal(replyButtonState(rec({ phase: 'translating', language: 'zh' })).disabled, true);
  assert.match(replyButtonState(rec({ phase: 'idle', error: 'Reply failed: x' })).hint, /Reply failed/);
});

test('translateReply sends the strict interpreter prompt to Bonsai and parses the result', async () => {
  let sent;
  const fetchImpl = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ translation: 'Merci beaucoup. Est-ce loin ?' }) } }] }) }; };
  const r = await translateReply('Thank you so much. Is it far?', 'fr', { url: 'http://bonsai.test/v1/', fetchImpl });
  assert.equal(r.translation, 'Merci beaucoup. Est-ce loin ?');
  assert.equal(sent.url, 'http://bonsai.test/v1/chat/completions');
  assert.equal(sent.body.temperature, 0);
  assert.match(sent.body.messages[0].content, /French/);
  assert.equal(sent.body.messages.at(-1).content, 'Thank you so much. Is it far?');
  await assert.rejects(translateReply('hi', 'it', { fetchImpl }), /Replies work in/);
  await assert.rejects(translateReply('hi', 'fr', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), /isn't reachable/);
});
