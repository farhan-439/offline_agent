// LiveWhisper against a fake memory server and a fake capture bridge. Plumbing only:
// whether real Argmax voiceprints match real people must be checked on real recordings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveWhisper } from '../live.mjs';

const vp = [0.1, 0.9, 0.2];
const MAYA = { type: 'identity', personId: 'p_maya', name: 'Maya', score: 0.93, whisper: 'This is Maya, your neighbour.' };

function setup(identify) {
  const calls = [];
  const spoken = [];
  const fetchImpl = async (url, opts = {}) => {
    const route = new URL(url).pathname;
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ route, body });
    if (route === '/health') return { ok: true, json: async () => ({ ok: true }) };
    const data = route === '/identify' ? identify(body, calls) : route === '/ingest' ? { sessions: ['s1'] } : { episodes: 2, facts: 3 };
    if (data instanceof Error) return { ok: false, status: 500, json: async () => ({ error: data.message }) };
    return { ok: true, json: async () => data };
  };
  const bridge = { speak: async (text) => { spoken.push(text); return { spoken: true }; } };
  const events = [];
  const live = new LiveWhisper({ bridge, fetchImpl, memoryUrl: 'http://mem.test', onEvent: (e) => events.push(e) });
  return { live, calls, spoken, events };
}

const speaker = (label, extra = {}) => ({ type: 'speaker', speaker: label, voiceprint: vp, final: false, seconds: 2.6, engine: 'sortformer', ...extra });

test('a recognised voice is whispered once, even when refreshed', async () => {
  const { live, spoken, calls } = setup(() => MAYA);
  await live.handleSpeaker(speaker('L1'));
  await live.handleSpeaker(speaker('L1', { seconds: 8.2 }));
  await live.speaking;
  assert.deepEqual(spoken, ['This is Maya, your neighbour.']);
  assert.equal(calls.filter((c) => c.route === '/identify').length, 1);
  assert.deepEqual(calls[0].body, { speaker: 'L1', voiceprint: vp });
});

test('the same person under a second live label is not whispered twice', async () => {
  const { live, spoken } = setup(() => MAYA);
  await live.handleSpeaker(speaker('L1'));
  await live.handleSpeaker(speaker('L3'));
  await live.speaking;
  assert.equal(spoken.length, 1);
});

test('the owner is never whispered and not re-identified', async () => {
  const { live, spoken, calls } = setup(() => ({ type: 'identity', personId: 'p_me', name: 'Me', score: 0.97, whisper: null, owner: true }));
  await live.handleSpeaker(speaker('L1'));
  await live.handleSpeaker(speaker('L1', { seconds: 8 }));
  assert.equal(spoken.length, 0);
  assert.equal(calls.filter((c) => c.route === '/identify').length, 1);
});

test('an unknown voice is retried with the refreshed voiceprint', async () => {
  let n = 0;
  const { live, spoken } = setup(() => (++n === 1 ? { type: 'identity', personId: null, score: 0.4, whisper: null } : MAYA));
  assert.equal((await live.handleSpeaker(speaker('L2'))).personId, null);
  await live.handleSpeaker(speaker('L2', { seconds: 8 }));
  await live.speaking;
  assert.deepEqual(spoken, ['This is Maya, your neighbour.']);
});

test('final speaker lines, missing voiceprints and in-flight duplicates are ignored', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { live, calls } = setup(() => MAYA);
  assert.equal(await live.handleSpeaker(speaker('L1', { final: true })), null);
  assert.equal(await live.handleSpeaker(speaker('L1', { voiceprint: null })), null);
  // Slow identify: a second event for the same label while the first is pending is dropped.
  live.fetchImpl = async (url, opts) => { await gate; return { ok: true, json: async () => MAYA }; };
  const first = live.handleSpeaker(speaker('L1'));
  assert.equal(await live.handleSpeaker(speaker('L1')), null);
  release();
  assert.equal((await first).name, 'Maya');
  assert.equal(calls.length, 0);
});

test('memory errors are reported, not thrown, and the label can retry', async () => {
  let n = 0;
  const { live, events, spoken } = setup(() => (++n === 1 ? new Error('db locked') : MAYA));
  assert.equal(await live.handleSpeaker(speaker('L1')), null);
  assert.ok(events.some((e) => e.type === 'identify-error' && /db locked/.test(e.message)));
  await live.handleSpeaker(speaker('L1'));
  await live.speaking;
  assert.equal(spoken.length, 1);
});

test('after recording, the session file is ingested and optionally docked', async () => {
  const { live, calls } = setup(() => MAYA);
  const r = await live.ingest({ jsonl: '/data/inbox/s1.jsonl' }, { dock: true });
  assert.deepEqual(calls.map((c) => c.route), ['/ingest', '/dock']);
  assert.deepEqual(calls[0].body, { file: '/data/inbox/s1.jsonl' });
  assert.equal(r.dock.facts, 3);
});

test('reset() starts a new recording fresh', async () => {
  const { live, spoken } = setup(() => MAYA);
  await live.handleSpeaker(speaker('L1'));
  live.reset();
  await live.handleSpeaker(speaker('L1'));
  await live.speaking;
  assert.equal(spoken.length, 2);
});
