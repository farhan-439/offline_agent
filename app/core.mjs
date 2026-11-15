// Main-process logic for the Kindred desktop app, kept free of Electron so it can be tested
// with fakes. main.cjs creates one KindredApp and forwards its events to the windows.
//
//   capture (Argmax, kindred-capture serve) ──events──▶ KindredApp ──▶ LiveWhisper ──/identify──▶ memory
//   memory (Bonsai, :8787) ◀──HTTP── KindredApp: /health /people /dock /ask, /ingest after a recording
import http from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
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
  }) {
    this.repoRoot = repoRoot;
    this.memoryUrl = memoryUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.emit = emit;
    this.bridge = new CaptureBridge({ ...bridgeOptions, onEvent: (e) => this.onCaptureEvent(e) });
    this.live = new LiveWhisper({ bridge: this.bridge, memoryUrl: this.memoryUrl, fetchImpl, onEvent: (e) => this.onLiveEvent(e) });
    this.memory = { ok: false, message: 'Checking memory…' };
    this.capture = { ...this.bridge.status(), message: this.bridge.status().available ? 'Loading Argmax models…' : 'kindred-capture is not built. Run: cd capture && npm run build' };
    this.recording = idleRecording();
    this.lastWhisper = null;
    this.recordingTask = null;
    this.lastCaptureError = '';
  }

  // ---------- status ----------
  snapshot() {
    return { memory: this.memory, capture: this.capture, recording: this.recording, whisper: this.lastWhisper };
  }
  changed() { this.emit('status', this.snapshot()); }

  start() {
    if (this.capture.available) {
      try { this.bridge.warm(); } catch (e) { this.capture = { ...this.capture, error: e.message, message: e.message }; }
    }
    this.changed();
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
      res = await this.fetchImpl(`${this.memoryUrl}${route}`, method === 'GET' ? { method } : {
        method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
      });
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

  // ---------- record ----------
  startRecording({ place, mode = 'conversation' } = {}) {
    if (this.recordingTask) throw new Error('Already recording.');
    if (!this.capture.available) throw new Error(this.capture.message);
    this.live.reset();
    this.lastWhisper = null;
    this.recording = { ...idleRecording(), mode, phase: 'starting', startedAt: Date.now() };
    this.changed();
    this.checkMemory(); // whispers need memory; recording works without it
    this.recordingTask = (mode === 'enroll' ? this.runEnrollment() : this.runRecording(place)).finally(() => { this.recordingTask = null; });
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

  async runRecording(place) {
    let result;
    try {
      result = await this.bridge.startRecording({ place });
    } catch (e) {
      const cancelled = /cancel/i.test(e.message);
      this.recording = { ...this.recording, phase: 'idle', error: cancelled ? null : e.message };
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
    this.recording = { ...this.recording, phase: 'idle', last: { ...summary, ingested: !!ingested, ingestError } };
    this.changed();
    this.emit('recording-done', { ok: true, ...summary, ingested: !!ingested, ingestError });
    return this.recording.last;
  }

  stopRecording() { return this.bridge.stopRecording(); }
  cancelRecording() { this.bridge.cancelRecording(); return true; }

  // ---------- dock / people ----------
  async people() { return this.request('/people', { method: 'GET' }); }

  async dock() {
    const report = await this.request('/dock');
    const roster = await this.people();
    return { report, ...roster };
  }

  // ---------- ask ----------
  async ask(question, { speak = true } = {}) {
    const q = String(question ?? '').trim();
    if (!q) throw new Error('Type a question first.');
    const out = await this.request('/ask', { body: { question: q } });
    const clips = (out.clips || []).map((c) => this.clip(c));
    if (speak && out.answer) this.speak(out.answer);
    return { question: q, answer: out.answer, grounded: !!out.grounded, clips };
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

  close() { this.bridge.close(); }
}

function idleRecording() {
  return { phase: 'idle', mode: 'conversation', session: null, device: null, engine: null, note: null, voices: [], error: null, startedAt: null, last: null };
}
