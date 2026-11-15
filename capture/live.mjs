#!/usr/bin/env node
// The live whisper loop: Argmax hears a voice → memory says who it is → Argmax speaks the reminder.
//
//   capture serve ──{"event":"speaker","final":false,"voiceprint":[…]}──▶ LiveWhisper
//   LiveWhisper ──POST /identify──▶ memory server (memory/src/server.mjs, :8787)
//   memory ──{"name":"Maya","whisper":"This is Maya, your neighbour…"}──▶ LiveWhisper ──speak──▶ TTSKit
//   on stop: session JSONL ──POST /ingest──▶ memory (and /dock with --dock)
//
// Run (memory server first:  cd memory && npm run server):
//   node capture/live.mjs [--place "porch"] [--dock]          press Enter to stop
//   node capture/live.mjs --simulate conversation.wav         play a WAV in as the mic (testing)
// Env: KINDRED_MEMORY_URL (default http://127.0.0.1:8787). Use earbuds: a whisper played on the
// laptop speakers is picked up by the mic and ends up in the transcript.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CaptureBridge } from './bridge.mjs';

export class LiveWhisper {
  constructor({ bridge, memoryUrl = process.env.KINDRED_MEMORY_URL || 'http://127.0.0.1:8787', fetchImpl = globalThis.fetch, onEvent = () => {} } = {}) {
    Object.assign(this, { bridge, memoryUrl: memoryUrl.replace(/\/$/, ''), fetchImpl, onEvent });
    this.reset();
  }

  /** New recording: forget which live labels were resolved and who was already announced. */
  reset() {
    this.resolved = new Set();   // live labels that are a known person or the owner
    this.pending = new Set();    // live labels with an /identify in flight
    this.announced = new Set();  // personIds already whispered this recording
    this.speaking = Promise.resolve();
  }

  async post(route, body) {
    const res = await this.fetchImpl(`${this.memoryUrl}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `memory ${route} failed (${res.status})`);
    return data;
  }

  async healthy() {
    try { return (await this.fetchImpl(`${this.memoryUrl}/health`)).ok; } catch { return false; }
  }

  /** Handle one capture event. Returns the identity (or null if skipped). */
  async handleSpeaker(event) {
    if (event?.final !== false || !Array.isArray(event.voiceprint) || !event.speaker) return null;
    const label = event.speaker;
    // A refreshed voiceprint (after ~8 s) retries only voices that weren't recognised yet.
    if (this.resolved.has(label) || this.pending.has(label)) return null;
    this.pending.add(label);
    try {
      const identity = await this.post('/identify', { speaker: label, voiceprint: event.voiceprint });
      this.onEvent({ type: 'identity', speaker: label, name: identity.name ?? null, score: identity.score, owner: !!identity.owner, engine: event.engine });
      if (identity.owner) { this.resolved.add(label); return identity; }
      if (!identity.personId) return identity; // unknown voice: allow a retry on refresh
      this.resolved.add(label);
      if (identity.whisper && !this.announced.has(identity.personId)) {
        this.announced.add(identity.personId);
        // Queue whispers so two people recognised at once don't cut each other off.
        this.speaking = this.speaking.then(() => this.bridge.speak(identity.whisper)).catch((e) => this.onEvent({ type: 'speak-error', message: e.message }));
        this.onEvent({ type: 'whisper', speaker: label, name: identity.name, text: identity.whisper });
      }
      return identity;
    } catch (error) {
      this.onEvent({ type: 'identify-error', speaker: label, message: error.message });
      return null;
    } finally {
      this.pending.delete(label);
    }
  }

  /** After a recording: give memory the session file (and optionally dock it). */
  async ingest(result, { dock = false } = {}) {
    const ingested = await this.post('/ingest', { file: result.jsonl });
    return dock ? { ...ingested, dock: await this.post('/dock', {}) } : ingested;
  }
}

async function main(argv) {
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const log = (...a) => console.log(...a);
  let live;
  const bridge = new CaptureBridge({
    onEvent: (e) => {
      if (e.type === 'speaker') { live.handleSpeaker(e); log(`  · voice ${e.speaker} (${e.seconds}s, ${e.engine})`); }
      else if (e.type === 'log') console.error(`  ${e.message}`);
      else if (['mic-live', 'mic-fallback', 'live', 'processing', 'tts-unavailable', 'live-error', 'exit'].includes(e.type)) log(`  · ${e.type} ${JSON.stringify(e)}`);
    },
  });
  live = new LiveWhisper({
    bridge,
    onEvent: (e) => {
      if (e.type === 'whisper') log(`  🔈 ${e.name}: "${e.text}"`);
      else if (e.type === 'identity') log(`  · ${e.speaker} → ${e.owner ? 'owner' : e.name ?? 'unknown'} (score ${e.score?.toFixed?.(2) ?? e.score})`);
      else log(`  · ${e.type}: ${e.message}`);
    },
  });
  if (!(await live.healthy())) log(`warning: memory server not reachable at ${live.memoryUrl} — recording only, no whispers. Start it: cd memory && npm run server`);
  log('loading Argmax models…');
  await bridge.whenReady();
  const recording = bridge.startRecording({ place: flag('place'), simulate: flag('simulate') });
  log(flag('simulate') ? `● simulating the mic with ${flag('simulate')} (stops at its end, or press Enter)` : '● recording — press Enter to stop');
  process.stdin.once('data', () => { log('stopping, transcribing…'); bridge.stopRecording(); });
  try {
    const result = await recording;
    log(`session ${result.session}: ${result.utterances} utterances, ${result.speakers} speakers → ${result.jsonl}`);
    if (await live.healthy()) {
      const r = await live.ingest(result, { dock: argv.includes('--dock') });
      log(`memory: ingested ${JSON.stringify(r.sessions)}${r.dock ? `, docked → ${r.dock.episodes} episodes, ${r.dock.facts} facts` : ' (run dock later)'}`);
    }
    await live.speaking;
  } finally {
    bridge.close();
    process.stdin.pause();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
