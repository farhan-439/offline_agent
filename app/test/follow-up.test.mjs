import test from 'node:test';
import assert from 'node:assert/strict';
import { KindredApp } from '../core.mjs';

test('text and voice questions share a short, grounded app session history', async () => {
  const requests = [];
  class Capture { status() { return { available: false }; } close() {} }
  class Live { constructor() {} }
  const app = new KindredApp({ CaptureBridge: Capture, LiveWhisper: Live,
    runLog: { write() {} },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return { ok: true, json: async () => ({ answer: 'The apple is blue.', grounded: true, cites: ['N1'], inputs: [{ id: 'N1', text: 'The apple is blue.' }] }) };
    },
  });
  try {
    await app.ask('What color is the apple?', { speak: false });
    await app.ask('What color again?', { speak: false });
    assert.deepEqual(requests[0], { question: 'What color is the apple?' });
    assert.deepEqual(requests[1].history, [{ question: 'What color is the apple?', cites: ['N1'] }]);
  } finally { app.close(); }
});
