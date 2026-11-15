import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { scanActionSuggestions, actionSuggestions, reserveActionSuggestion, finishActionSuggestion, statedTime, statedSchedule } from '../src/action-suggestions.mjs';

test('Bonsai proposals stay tied to saved facts and require a separate export state', async () => {
  const db = openDb(':memory:');
  try {
    db.prepare(`INSERT INTO facts (kind, text, when_text, when_resolved, evidence, observed_at)
      VALUES ('plan', ?, 'next Saturday at ten', '2026-11-21', '[]', '2026-11-15')`)
      .run("Leo's soccer game is next Saturday at ten at Riverside Park; he is number seven.");
    const bonsai = { json: async () => ({ actions: [{ target: 'calendar', title: "Leo's soccer game", details: 'Leo is number seven.', place: 'Riverside Park' }] }) };
    const result = await scanActionSuggestions(db, bonsai);
    assert.equal(result.scanned, 1);
    assert.equal(result.added, 1);
    assert.equal(result.suggestions[0].source.ref, 'F1');
    assert.equal(result.suggestions[0].payload.date, '2026-11-21');
    assert.equal(result.suggestions[0].payload.place, 'Riverside Park');
    assert.equal(result.suggestions[0].payload.details, "Leo's soccer game is next Saturday at ten at Riverside Park; he is number seven.");
    assert.equal(result.suggestions[0].payload.time, null); // “at ten” has no AM/PM
    assert.equal((await scanActionSuggestions(db, bonsai)).scanned, 0);
    const reserved = reserveActionSuggestion(db, result.suggestions[0].id);
    assert.equal(reserved.status, 'exporting');
    assert.throws(() => reserveActionSuggestion(db, reserved.id), /already added or is being added/);
    finishActionSuggestion(db, reserved.id, { externalId: 'local-calendar-1' });
    assert.equal(actionSuggestions(db)[0].status, 'added');
  } finally { db.close(); }
});

test('medical clock times and duration are never inferred from dose frequency', () => {
  assert.deepEqual(statedSchedule('Three times a day, ten milliliters.'), { timesPerDay: 3, duration: null, repeat: 'daily' });
  assert.equal(statedTime('Three times a day, ten milliliters.'), null);
  assert.equal(statedTime('at 8:00 am'), '08:00');
  assert.equal(statedSchedule('Recycling moved to Thursdays.').repeat, 'weekly');
});

test('compilation can scan every saved fact in bounded batches', async () => {
  const db = openDb(':memory:');
  try {
    const insert = db.prepare("INSERT INTO facts (kind, text, evidence, observed_at) VALUES ('miscellaneous', ?, '[]', '2026-11-15')");
    for (let i = 0; i < 9; i++) insert.run(`Fact number ${i}`);
    const model = { json: async () => ({ actions: [] }) };
    assert.equal((await scanActionSuggestions(db, model)).scanned, 8);
    assert.equal((await scanActionSuggestions(db, model)).scanned, 1);
    assert.equal((await scanActionSuggestions(db, model)).scanned, 0);
  } finally { db.close(); }
});
