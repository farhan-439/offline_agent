// Node side of `kindred-capture serve`: keeps ONE capture process running so WhisperKit,
// SpeakerKit and Qwen3-TTS load once. Ported from local_ai/speech.mjs (SpeechBridge).
//
//   const capture = new CaptureBridge({ onEvent: console.log });
//   capture.warm();
//   const rec = capture.startRecording({ place: 'porch' });  // resolves after stopRecording()
//   ...; capture.stopRecording(); const { jsonl } = await rec; // → feed jsonl to memory ingest/dock
//   await capture.speak('This is Maya, your neighbour.');      // Argmax TTSKit, macOS `say` fallback
//   capture.startRecording({ translate: true });               // + live {type:'translation',…} events via onEvent
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const here = import.meta.dirname;
const repoRoot = path.resolve(here, '..');

export class CaptureBridge {
  constructor({
    binary = process.env.KINDRED_CAPTURE_BIN || path.join(here, '.build/release/kindred-capture'),
    outDir = path.join(repoRoot, 'data/inbox'),
    audioDir = path.join(repoRoot, 'data/audio'),
    voice = process.env.KINDRED_VOICE || 'ryan',
    sayBinary = '/usr/bin/say',
    tts = process.env.KINDRED_TTS !== 'system',
    onEvent = () => {},
  } = {}) {
    Object.assign(this, { binary, outDir, audioDir, voice, sayBinary, tts, onEvent });
    this.server = null;
    this.ready = { stt: false, tts: false };
    this.pending = new Map();
    this.nextId = 1;
    this.recordingId = null;
    this.speakingId = null;
    this.say = null;
    this.lastError = '';
  }

  status() {
    return { available: existsSync(this.binary), ...this.ready, recording: this.recordingId !== null, error: this.lastError };
  }

  /** Start the helper and load models in the background. Safe to call repeatedly. */
  warm() {
    if (this.server) return this.server;
    if (!existsSync(this.binary)) throw new Error(`kindred-capture not built (${this.binary}). Run: cd capture && swift build -c release`);
    const args = ['serve', '--out', this.outDir, '--audio-dir', this.audioDir];
    if (!this.tts) args.push('--no-tts', '1');
    const child = spawn(this.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.server = child;
    this.ready = { stt: false, tts: false };
    this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve; });
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => { const line = String(d).trim(); if (line) this.onEvent({ type: 'log', message: line }); });
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.receive(line));
    const fail = (message) => {
      if (this.server !== child) return;
      this.server = null;
      this.ready = { stt: false, tts: false };
      this.lastError = message;
      this.resolveReady?.(false);
      for (const { reject } of this.pending.values()) reject(new Error(message));
      this.pending.clear();
      this.recordingId = null; this.speakingId = null;
      this.onEvent({ type: 'exit', message });
    };
    child.on('error', (e) => fail(`Capture helper could not start: ${e.message}`));
    child.on('close', (code) => fail(code === 0 || code === null ? 'Capture helper stopped.' : `Capture helper exited (${code}).`));
    return child;
  }

  async whenReady() {
    this.warm();
    if (!this.ready.stt && !(await this.readyPromise)) throw new Error(this.lastError || 'Capture helper could not start.');
  }

  receive(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.event === 'ready') {
      this.ready = { stt: !!msg.stt, tts: !!msg.tts };
      this.lastError = '';
      this.resolveReady?.(true);
      this.onEvent({ type: 'ready', ...this.ready });
      return;
    }
    if (msg.event) { const { event, ...rest } = msg; this.onEvent({ type: event, ...rest }); return; }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.error) entry.reject(Object.assign(new Error(msg.error), { reason: msg.reason }));
    else entry.resolve(msg);
  }

  request(command) {
    const server = this.warm();
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    server.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    return { id, promise };
  }

  send(command) { this.server?.stdin.write(`${JSON.stringify(command)}\n`); }

  /** Record a conversation. Resolves with {session, jsonl, audio, utterances, speakers} after stopRecording(). */
  /** `simulate`: path to a WAV played in as the mic (testing); recording stops at its end. */
  /** `translate`: multilingual Whisper. Emits live {type:'translation', language, text, translation, start, end, seq}
   *  events for foreign speech while recording, and adds `language` + `translation` to the session file. */
  async startRecording({ session, place, live, simulate, translate, outDir, audioDir } = {}) {
    if (this.recordingId) throw new Error('Already recording.');
    this.recordingId = -1; // reserve while models load
    try {
      await this.whenReady();
      const { id, promise } = this.request({ cmd: 'record-start', session, place, live, translate, simulate: simulate && path.resolve(simulate),
        outDir: outDir && path.resolve(outDir), audioDir: audioDir && path.resolve(audioDir) });
      this.recordingId = id;
      if (this.stopRequested) { this.stopRequested = false; this.send({ cmd: 'record-stop' }); }
      return await promise;
    } finally { this.recordingId = null; this.stopRequested = false; }
  }

  stopRecording() {
    if (this.recordingId === -1) { this.stopRequested = true; return true; }
    if (!this.recordingId) return false;
    this.send({ cmd: 'record-stop' });
    return true;
  }

  cancelRecording() { if (this.recordingId) this.send({ cmd: 'record-cancel' }); }

  /** Transcribe + diarize an existing WAV into contract JSONL. `translate`: add `language` + English `translation`. */
  async processFile(audio, { session, place, translate } = {}) {
    await this.whenReady();
    return this.request({ cmd: 'process', audio: path.resolve(audio), session, place, translate }).promise;
  }

  /** Speak a whisper line. Argmax TTSKit when loaded, macOS voice otherwise. Resolves when done. */
  async speak(text) {
    const line = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!line) return false;
    this.stopSpeaking();
    if (this.tts && this.server && this.ready.tts) {
      const { id, promise } = this.request({ cmd: 'speak', text: line, voice: this.voice });
      this.speakingId = id;
      try { return await promise; } catch (e) {
        this.onEvent({ type: 'speak-error', message: e.message });
        if (/Stopped/.test(e.message)) return false;
      } finally { if (this.speakingId === id) this.speakingId = null; }
    }
    return this.speakWithSystemVoice(line);
  }

  speakWithSystemVoice(text) {
    if (!existsSync(this.sayBinary)) return false;
    return new Promise((resolve) => {
      const child = spawn(this.sayBinary, [], { stdio: ['pipe', 'ignore', 'ignore'] });
      this.say = child;
      const done = (ok) => { if (this.say === child) this.say = null; resolve(ok); };
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0 ? { spoken: true, system: true } : false));
      child.stdin.on('error', () => {});
      child.stdin.end(text.slice(0, 2000));
    });
  }

  stopSpeaking() {
    if (this.speakingId) this.send({ cmd: 'stop-speaking' });
    this.say?.kill();
  }

  close() {
    this.cancelRecording();
    this.stopSpeaking();
    const server = this.server;
    this.server = null;
    server?.stdin.end();
    setTimeout(() => server?.kill(), 500).unref?.();
  }
}
