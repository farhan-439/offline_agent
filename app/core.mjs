// Main-process logic for the Kindred desktop app, kept free of Electron so it can be tested
// with fakes. main.cjs creates one KindredApp and forwards its events to the windows.
//
//   capture (Argmax, kindred-capture serve) ──events──▶ KindredApp ──▶ LiveWhisper ──/identify──▶ memory
//   memory (Bonsai, :8787) ◀──HTTP── KindredApp: /health /people /dock /ask, /ingest after a recording
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { translateReply, replyLanguage, REPLY_LANGUAGES } from './translate.mjs';
import { MemorySupervisor } from './memory-supervisor.mjs';
import { RunLog } from './run-log.mjs';
import { pathToFileURL } from 'node:url';

export const MEMORY_DOWN = 'Memory server not running. Start it: cd memory && npm run server';

/** fetch()-shaped HTTP client for localhost without undici's 5-minute header timeout (dock can be slow). */
export function localFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        json: async () => JSON.parse(text || '{}'),
      }));
    });
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.end(body);
  });
}

/** "Teach Kindred my voice": speech needed for a usable voiceprint, and the recording's safety cap. */
export const ENROLL_MIN_SECONDS = 6;
/** Live translation lines kept for the orb. */
export const MAX_TRANSLATIONS = 12;
export const ENROLL_MAX_MS = 40_000;

/** The owner's voiceprint from an enrollment session file: the voice that talked longest. */
export function voiceFromSession(jsonlText) {
  const speakers = String(jsonlText).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === 'speaker' && Array.isArray(e.voiceprint) && e.voiceprint.length);
  if (!speakers.length) return null;
  const total = speakers.reduce((s, e) => s + (e.seconds || 0), 0);
  const best = speakers.reduce((a, b) => ((b.seconds || 0) > (a.seconds || 0) ? b : a));
  return { voiceprint: best.voiceprint, seconds: best.seconds || 0, voices: speakers.length, share: total ? (best.seconds || 0) / total : 1 };
}

export class MemoryDownError extends Error {
  constructor(cause) { super(MEMORY_DOWN); this.code = 'MEMORY_DOWN'; this.cause = cause; }
}

export class KindredApp {
  constructor({
    CaptureBridge, LiveWhisper,
    repoRoot = path.resolve(import.meta.dirname, '..'),
    memoryUrl = process.env.KINDRED_MEMORY_URL || 'http://127.0.0.1:8787',
    fetchImpl = localFetch,
    bridgeOptions = {},
    emit = () => {},
    translate = translateReply,
    superviseMemory = false,
    runLog = null,
    supervisorOptions = {},
  }) {
    this.translate = translate;
    this.repoRoot = repoRoot;
    this.purgeAskTemps();
    this.memoryUrl = memoryUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.runLog = runLog ?? new RunLog({ repoRoot: this.repoRoot });
    this.emit = (type, payload) => {
      if (type !== 'status' && type !== 'ask-state') this.runLog.write(type === 'log' ? 'capture-log' : type, type === 'log' ? { message: payload } : payload);
      emit(type, payload);
    };
    this.bridge = new CaptureBridge({ ...bridgeOptions, onEvent: (e) => this.onCaptureEvent(e) });
    this.live = new LiveWhisper({ bridge: this.bridge, memoryUrl: this.memoryUrl, fetchImpl, onEvent: (e) => this.onLiveEvent(e) });
    this.memory = { ok: false, message: 'Checking memory…' };
    this.capture = { ...this.bridge.status(), message: this.bridge.status().available ? 'Loading Argmax models…' : 'kindred-capture is not built. Run: cd capture && npm run build' };
    this.recording = idleRecording();
    this.lastWhisper = null;
    this.recordingTask = null;
    this.lastCaptureError = '';
    this.askState = { phase: 'idle', question: null, error: null };
    this.askListeningTask = null;
    // The app starts memory itself (and restarts it) unless one is already running.
    this.supervisor = superviseMemory ? new MemorySupervisor({ repoRoot: this.repoRoot, url: this.memoryUrl, ...supervisorOptions,
      onEvent: (e) => this.onSupervisorEvent(e) }) : null;
  }

  onSupervisorEvent(e) {
    this.emit('log', `memory: ${e.state}${e.message ? ` (${e.message})` : ''}${e.inMs ? ` in ${e.inMs} ms` : ''}`);
    if (e.state === 'starting' || e.state === 'restarting') { this.memory = { ok: false, message: e.state === 'starting' ? 'Starting memory…' : 'Memory stopped; restarting it…' }; this.changed(); }
    if (e.state === 'running' || e.state === 'external') this.checkMemory();
    if (e.state === 'failed') { this.memory = { ok: false, message: e.message }; this.changed(); }
  }

  // ---------- status ----------
  snapshot() {
    return { memory: this.memory, capture: this.capture, recording: this.recording, whisper: this.lastWhisper, ask: this.askState };
  }
  changed() { this.emit('status', this.snapshot()); }
  setAskState(patch) {
    this.askState = { ...this.askState, ...patch };
    this.emit('ask-state', this.askState);
    this.changed();
  }

  start() {
    if (this.capture.available) {
      try { this.bridge.warm(); } catch (e) { this.capture = { ...this.capture, error: e.message, message: e.message }; }
    }
    this.changed();
    if (this.supervisor) this.supervisor.start(); // memory comes up in the background; checkMemory follows it
    return this.checkMemory();
  }

  async checkMemory() {
    let ok = false, message = MEMORY_DOWN;
    try {
      const res = await this.fetchImpl(`${this.memoryUrl}/health`, { timeoutMs: 1500 });
      ok = !!res.ok;
      if (ok) message = `Memory ready (${this.memoryUrl})`;
    } catch { /* not running */ }
    if (ok !== this.memory.ok || message !== this.memory.message) { this.memory = { ok, message }; this.changed(); }
    return this.memory;
  }

  async request(route, { method = 'POST', body } = {}) {
    let res;
    try {
      const timeoutMs = route === '/dock' ? 180000 : route === '/ask' ? 90000 : 15000;
      const options = { method, timeoutMs, signal: AbortSignal.timeout(timeoutMs) };
      if (method !== 'GET') Object.assign(options, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
      res = await this.fetchImpl(`${this.memoryUrl}${route}`, options);
    } catch (e) {
      if (this.memory.ok) { this.memory = { ok: false, message: MEMORY_DOWN }; this.changed(); }
      throw new MemoryDownError(e);
    }
    const data = await res.json().catch(() => ({}));
    if (!this.memory.ok) { this.memory = { ok: true, message: `Memory ready (${this.memoryUrl})` }; this.changed(); }
    if (!res.ok) throw new Error(data.error || `memory ${route} failed (${res.status})`);
    return data;
  }

  // ---------- capture events ----------
  onCaptureEvent(e) {
    if (['speaker', 'live', 'mic-live', 'mic-fallback', 'recording', 'processing', 'exit', 'tts-unavailable', 'translate-unavailable', 'translating'].includes(e.type)) this.runLog.write(`capture-${e.type}`, e);
    if (this.askState.phase !== 'idle' && ['recording', 'mic-live', 'processing'].includes(e.type)) {
      if (e.type === 'mic-live') this.setAskState({ phase: 'listening', device: e.device ?? null });
      if (e.type === 'processing') this.setAskState({ phase: 'processing' });
      return;
    }
    switch (e.type) {
      case 'ready':
        this.capture = { ...this.bridge.status(), message: e.tts ? 'Argmax ready (listening + voice)' : 'Argmax ready (voice still loading)' };
        break;
      case 'tts-unavailable':
        this.capture = { ...this.bridge.status(), message: 'Argmax voice unavailable; using the Mac voice' };
        break;
      case 'exit':
        // Surface the helper's own last error (e.g. a missing model folder) next to "exited (1)".
        this.capture = { ...this.bridge.status(), message: [e.message, this.lastCaptureError].filter(Boolean).join(' ') };
        break;
      case 'recording':
        this.recording = { ...this.recording, session: e.session ?? this.recording.session };
        break;
      case 'mic-live':
        this.recording = { ...this.recording, phase: 'recording', device: e.device ?? null };
        break;
      case 'mic-fallback':
        this.recording = { ...this.recording, device: e.device ?? null, note: `${e.from || 'Headset'} mic was silent, switched to ${e.device}` };
        break;
      case 'live':
        this.recording = { ...this.recording, engine: e.engine };
        break;
      case 'speaker':
        // While enrolling it's only the owner reading: no live identify/whisper.
        if (e.final === false && this.recording.mode !== 'enroll') {
          this.upsertVoice(e.speaker, { seconds: e.seconds ?? null });
          this.live.handleSpeaker(e);
        }
        break;
      case 'processing':
        this.recording = { ...this.recording, phase: 'processing' };
        break;
      case 'translation':
        this.addTranslation(e);
        break;
      case 'speaking':
        this.emit('speaking', { device: e.device ?? null });
        return;
      case 'log':
        for (const line of String(e.message).split('\n')) if (/^error:/i.test(line.trim())) this.lastCaptureError = line.trim().slice(0, 300);
        this.emit('log', e.message);
        return;
      default:
        return;
    }
    this.changed();
  }

  onLiveEvent(e) {
    this.runLog.write(`live-${e.type}`, e);
    if (e.type === 'identity') {
      this.upsertVoice(e.speaker, { name: e.name ?? null, owner: !!e.owner, score: e.score ?? null, checked: true });
      this.changed();
    } else if (e.type === 'whisper') {
      this.lastWhisper = { speaker: e.speaker, name: e.name, text: e.text, at: Date.now() };
      this.upsertVoice(e.speaker, { whisper: e.text });
      this.emit('whisper', this.lastWhisper);
      this.changed();
    } else if (e.type === 'identify-error') {
      this.upsertVoice(e.speaker, { error: e.message });
      this.changed();
    } else {
      this.emit('log', `${e.type}: ${e.message ?? ''}`);
    }
  }

  upsertVoice(speaker, patch) {
    if (!speaker) return;
    const voices = [...this.recording.voices];
    const i = voices.findIndex((v) => v.speaker === speaker);
    if (i < 0) voices.push({ speaker, name: null, owner: false, score: null, seconds: null, ...patch });
    else voices[i] = { ...voices[i], ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null && v !== undefined)) };
    this.recording = { ...this.recording, voices };
  }

  /** Live translation: keep the latest lines for the orb, and speak each English translation in order. */
  addTranslation(e) {
    const translation = typeof e.translation === 'string' ? e.translation.trim() : '';
    if (!translation && !e.text) return;
    const item = { seq: e.seq ?? null, language: e.language ?? null, text: e.text ?? '', translation: translation || null,
      start: e.start ?? null, end: e.end ?? null, at: Date.now() };
    const translations = [...this.recording.translations.filter((t) => t.seq === null || t.seq !== item.seq), item].slice(-MAX_TRANSLATIONS);
    this.recording = { ...this.recording, translations };
    this.emit('translation', item);
    if (translation) {
      // Queue so consecutive lines don't cut each other off.
      this.translationSpeech = (this.translationSpeech || Promise.resolve())
        .then(() => this.bridge.speak(translation)).catch((err) => this.emit('log', `speak failed: ${err.message}`));
    }
  }

  // ---------- two-way: reply in their language ----------
  /** The language to reply in: the most recent one Kindred heard that replies support (de/zh/es/fr). */
  replyTarget() {
    for (const t of [...(this.recording.translations || [])].reverse()) {
      const lang = replyLanguage(t.language);
      if (lang) return lang;
    }
    return null;
  }

  setReply(patch) {
    this.recording = { ...this.recording, reply: { ...this.recording.reply, ...patch } };
    this.changed();
  }

  /** Start recording the owner's English reply (cut from the live translation recording). */
  async startReply() {
    const rec = this.recording;
    if (rec.mode !== 'translate' || rec.phase !== 'recording') throw new Error('Reply works during Live translation.');
    if (rec.reply.phase !== 'idle') throw new Error('Finish the current reply first.');
    const language = this.replyTarget();
    if (!language) throw new Error(`Reply works once Kindred has heard ${Object.values(REPLY_LANGUAGES).join(', ').replace('Simplified ', '')}.`);
    this.bridge.stopSpeaking();
    this.setReply({ phase: 'listening', language, english: null, translated: null, error: null });
    try { await this.bridge.replyStart(); } catch (e) { this.setReply({ phase: 'idle', error: e.message }); throw e; }
    return { language };
  }

  /** Done speaking: transcribe (Argmax) → translate (Bonsai) → say it in their language (Argmax). */
  async stopReply() {
    const { phase, language } = this.recording.reply;
    if (phase !== 'listening') return false;
    let english = null, translated = null;
    try {
      this.setReply({ phase: 'transcribing' });
      english = (await this.bridge.replyStop()).text;
      this.setReply({ phase: 'translating', english });
      const t0 = Date.now();
      translated = (await this.translate(english, language)).translation;
      const item = { kind: 'reply', language, english, translated, at: Date.now(), translateMs: Date.now() - t0 };
      this.recording = { ...this.recording, replies: [...this.recording.replies, item].slice(-MAX_TRANSLATIONS) };
      this.emit('reply', item);
      this.setReply({ phase: 'speaking', translated });
      // After any English translations still queued, so the two voices don't overlap.
      await (this.translationSpeech || Promise.resolve());
      await this.bridge.speakIn(translated, language);
      this.setReply({ phase: 'idle', error: null });
      return item;
    } catch (e) {
      this.setReply({ phase: 'idle', error: /didn't|reply/i.test(e.message) ? e.message : `Reply failed: ${e.message}`, english, translated });
      return null;
    }
  }

  cancelReply() {
    if (this.recording.reply.phase === 'listening') this.bridge.replyCancel().catch(() => {});
    this.setReply({ phase: 'idle' });
    return true;
  }

  // ---------- record ----------
  startRecording({ place, mode = 'conversation' } = {}) {
    if (this.recordingTask || this.askListeningTask) throw new Error('Already recording.');
    if (!this.capture.available) throw new Error(this.capture.message);
    this.live.reset();
    this.lastWhisper = null;
    this.recording = { ...idleRecording(), mode, phase: 'starting', startedAt: Date.now() };
    this.runLog.write('recording-start', { mode });
    this.changed();
    this.checkMemory(); // whispers need memory; recording works without it
    this.translationSpeech = Promise.resolve();
    this.recordingTask = (mode === 'enroll' ? this.runEnrollment() : this.runRecording(place, { translate: mode === 'translate' })).finally(() => { this.recordingTask = null; });
    return { started: true };
  }

  /** "Teach Kindred my voice": record the owner reading, enroll the voiceprint, keep no recording. */
  enrollOwner() {
    if (this.recordingTask) throw new Error('Stop the current recording first.');
    return this.startRecording({ mode: 'enroll' });
  }

  async runEnrollment() {
    if (!this.memory.ok) await this.checkMemory();
    const cap = setTimeout(() => this.bridge.stopRecording(), ENROLL_MAX_MS);
    cap.unref?.();
    let result;
    const fail = (error, extra = {}) => {
      this.recording = { ...this.recording, mode: 'conversation', phase: 'idle', error: null, last: { enrolled: false, error } };
      this.changed();
      this.emit('enroll-done', { ok: false, error, ...extra });
      return null;
    };
    try {
      // live:false: no Sortformer/identify while it's only you reading.
      result = await this.bridge.startRecording({ place: 'voice enrollment', session: `enroll-${new Date().toISOString().replace(/[:.]/g, '-')}`, live: false });
    } catch (e) {
      clearTimeout(cap);
      const cancelled = /cancel/i.test(e.message);
      return fail(cancelled ? 'Cancelled.' : /speech/i.test(e.message) ? "I didn't hear you. Read the passage aloud, a little closer to the Mac." : e.message, { cancelled });
    }
    clearTimeout(cap);
    try {
      let voice = null;
      try { voice = voiceFromSession(readFileSync(result.jsonl, 'utf8')); } catch { /* unreadable → handled below */ }
      if (!voice) return fail("I couldn't get a voiceprint from that. Try again and read the whole passage.");
      if (voice.seconds < ENROLL_MIN_SECONDS) return fail(`I only heard ${Math.round(voice.seconds)} s of you. Read the whole passage (about 20 s) and try again.`);
      let enrolled;
      try { enrolled = await this.request('/enroll-owner', { body: { voiceprint: voice.voiceprint } }); } catch (e) { return fail(e.message, { code: e.code || null }); }
      const note = voice.voices > 1 && voice.share < 0.8 ? 'I heard more than one voice and used the one that talked most. For the best result, record alone.' : null;
      this.recording = { ...this.recording, mode: 'conversation', phase: 'idle', last: { enrolled: true, samples: enrolled.samples, seconds: voice.seconds } };
      this.changed();
      this.emit('enroll-done', { ok: true, samples: enrolled.samples, seconds: voice.seconds, note });
      return this.recording.last;
    } finally {
      this.discard(result); // the sample is only for the voiceprint; never keep it as a conversation
    }
  }

  /** Delete a capture session's files, but only inside this repo's data/ folder. */
  discard(result) {
    const data = path.resolve(this.repoRoot, 'data') + path.sep;
    for (const f of [result?.jsonl, result?.audio]) {
      if (!f) continue;
      const abs = path.resolve(this.repoRoot, f);
      if (abs.startsWith(data)) rmSync(abs, { force: true });
    }
  }

  /** Remove temporary voice questions left behind if the app was interrupted mid-transcription. */
  purgeAskTemps() {
    const dir = path.join(this.repoRoot, 'data/ask-tmp');
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) if (/^ask-[A-Za-z0-9_-]+\.(?:jsonl|wav)$/.test(name))
      rmSync(path.join(dir, name), { force: true });
  }

  /** A conversation, or (translate: true) a live-translation session: capture sends `translation`
   *  events while it records, and the saved session carries language + translation per line. */
  async runRecording(place, { translate = false } = {}) {
    let result;
    const mode = this.recording.mode;
    try {
      result = await this.bridge.startRecording(translate ? { place, translate: true } : { place });
    } catch (e) {
      const cancelled = /cancel/i.test(e.message);
      this.recording = { ...this.recording, mode: 'conversation', phase: 'idle', error: cancelled ? null : e.message };
      this.changed();
      this.emit('recording-done', { ok: false, cancelled, error: e.message });
      return null;
    }
    const summary = { session: result.session, jsonl: result.jsonl, audio: result.audio, utterances: result.utterances, speakers: result.speakers };
    let ingested = null, ingestError = null;
    await this.checkMemory();
    if (this.memory.ok) {
      try { ingested = await this.live.ingest(result); } catch (e) { ingestError = e.message; }
    } else ingestError = MEMORY_DOWN;
    this.recording = { ...this.recording, mode: 'conversation', phase: 'idle', last: { ...summary, mode, ingested: !!ingested, ingestError } };
    this.changed();
    this.emit('recording-done', { ok: true, ...summary, mode, ingested: !!ingested, ingestError });
    return this.recording.last;
  }

  stopRecording() {
    if (this.recording.reply?.phase === 'listening') this.cancelReply();
    return this.bridge.stopRecording();
  }
  cancelRecording() { this.bridge.cancelRecording(); return true; }

  // ---------- dock / people ----------
  /** Memory's /people (peopleGraph: is_owner, voice_samples) → the shape the People screen uses. */
  async people() {
    const r = await this.request('/people', { method: 'GET' });
    return { ...r, people: (r.people || []).map(normalisePerson) };
  }

  async dock() {
    const report = await this.request('/dock');
    const roster = await this.people();
    return { report, ...roster };
  }

  // ---------- ask ----------
  /** Record one spoken question without sending its transcript or audio to long-term memory. */
  startAskListening({ simulate } = {}) {
    if (this.recordingTask || this.askListeningTask) throw new Error('Finish the current recording first.');
    if (!this.capture.available) throw new Error(this.capture.message);
    this.stopSpeaking();
    this.setAskState({ phase: 'starting', question: null, error: null, device: null });
    this.askListeningTask = this.runAskListening(simulate).finally(() => { this.askListeningTask = null; });
    return { started: true };
  }

  stopAskListening() {
    if (!this.askListeningTask) return false;
    this.setAskState({ phase: 'processing' });
    return this.bridge.stopRecording();
  }

  async runAskListening(simulate) {
    let result;
    try {
      const tempDir = path.join(this.repoRoot, 'data/ask-tmp');
      mkdirSync(tempDir, { recursive: true });
      result = await this.bridge.startRecording({ place: 'voice question',
        session: `ask-${new Date().toISOString().replace(/[:.]/g, '-')}`, live: false,
        outDir: tempDir, audioDir: tempDir, simulate });
      const events = readFileSync(result.jsonl, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const question = events.filter((event) => event.type === 'utterance' && event.text?.trim())
        .sort((a, b) => (a.start ?? 0) - (b.start ?? 0)).map((event) => event.text.trim()).join(' ').trim();
      if (!question) throw new Error("I couldn't hear a question. Please try again.");
      this.setAskState({ phase: 'answering', question, error: null });
      await this.ask(question);
      this.setAskState({ phase: 'idle' });
    } catch (error) {
      const message = /speech/i.test(error.message) ? "I couldn't hear a question. Please try again." : error.message;
      this.setAskState({ phase: 'idle', error: message });
    } finally {
      if (result) this.discard(result);
    }
  }

  async ask(question, { speak = true } = {}) {
    const q = String(question ?? '').trim();
    if (!q) throw new Error('Type a question first.');
    const askedAt = Date.now();
    const out = await this.request('/ask', { body: { question: q } });
    this.runLog.write('ask', { question: q, ms: Date.now() - askedAt, grounded: !!out.grounded, cites: out.cites ?? [], answer: out.answer });
    const clips = (out.clips || []).map((c) => this.clip(c));
    const photos = (out.photos || []).map((p) => this.photo(p));
    const sources = out.sources?.length ? out.sources : (out.inputs || []).map((input) => ({
      ref: input.id, layer: 'input', text: input.text, when: input.createdAt,
    }));
    const answer = { question: q, answer: out.answer, grounded: !!out.grounded,
      cites: out.cites || [], sources, photos, clips, mode: out.mode ?? null };
    this.emit('ask-answer', answer);
    if (speak && out.answer) this.speak(out.answer);
    return answer;
  }

  photo(p) {
    return { id: p.id, caption: p.caption ?? null, takenAt: p.taken_at ?? null,
      url: p.id ? `${this.memoryUrl}/photo/${encodeURIComponent(p.id)}` : null };
  }

  /** Audio paths in session files are relative to the repo root; give the renderer a playable file:// URL. */
  clip(c) {
    const file = c.audio ? (path.isAbsolute(c.audio) ? c.audio : path.resolve(this.repoRoot, c.audio)) : null;
    const start = Number.isFinite(c.start) ? c.start : null;
    const end = Number.isFinite(c.end) ? c.end : null;
    const fragment = start !== null ? `#t=${start}${end !== null ? `,${end}` : ''}` : '';
    const exists = !!file && existsSync(file);
    return {
      id: c.id ?? null, speaker: c.speaker ?? null, text: c.text ?? '', translation: c.translation ?? null,
      date: c.started_at ?? null, start, end, audio: file, exists,
      url: exists ? `${pathToFileURL(file).href}${fragment}` : null,
    };
  }

  speak(text) {
    return this.bridge.speak(text).catch((e) => { this.emit('log', `speak failed: ${e.message}`); return false; });
  }
  stopSpeaking() { this.bridge.stopSpeaking(); return true; }

  close() { this.bridge.close(); this.supervisor?.stop(); }
}

export function normalisePerson(p) {
  return {
    ...p,
    owner: p.owner ?? !!p.is_owner,
    voiceSamples: p.voiceSamples ?? p.voice_samples ?? 0,
    relation: p.relation ?? null,
    core: p.core ?? null,
    facts: p.facts ?? 0,
  };
}

function idleRecording() {
  return { phase: 'idle', mode: 'conversation', session: null, device: null, engine: null, note: null, voices: [], translations: [], replies: [],
    reply: { phase: 'idle', language: null, english: null, translated: null, error: null }, error: null, startedAt: null, last: null };
}
