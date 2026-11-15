import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExport } from '../native-actions.mjs';
import { KindredApp } from '../core.mjs';

test('Calendar needs reviewed date, time, and duration before local export', () => {
  const draft = { title: "Leo's game", date: '2026-11-21', time: '10:00' };
  assert.throws(() => validateExport('calendar', draft), /Choose an event length/);
  assert.equal(validateExport('calendar', { ...draft, durationMinutes: 90 }).durationMinutes, 90);
  assert.throws(() => validateExport('calendar', { ...draft, durationMinutes: 90, date: '2026-02-30' }), /valid date/);
});

test('a multi-dose reminder needs exact times and an end count', () => {
  const draft = { title: 'Cough syrup 10 ml', date: '2026-11-15', repeat: 'daily', timesPerDay: 3, times: ['08:00', '14:00', '20:00'] };
  assert.throws(() => validateExport('reminders', draft), /number of occurrences/);
  assert.deepEqual(validateExport('reminders', { ...draft, occurrences: 5 }).times, draft.times);
  assert.throws(() => validateExport('reminders', { ...draft, occurrences: 5, times: ['08:00', '14:00'] }), /every daily time/);
});

test('Contacts needs an explicit actual birth year', () => {
  assert.throws(() => validateExport('contacts', { title: "Rosa's birthday", date: '2026-11-20', person: 'Rosa' }), /birth year/);
});

test('queue review validates the current proposal before Run can export it', async () => {
  const app = { actionSuggestions: async () => ({ suggestions: [
    { id: 7, target: 'calendar', status: 'proposed', payload: { title: "Leo's game", date: '2026-11-21', time: '10:00' } },
  ] }) };
  await assert.rejects(KindredApp.prototype.validateActionSuggestion.call(app, 7, {}), /event length/);
  const checked = await KindredApp.prototype.validateActionSuggestion.call(app, 7, { durationMinutes: '90' });
  assert.equal(checked.details.durationMinutes, 90);
  await assert.rejects(KindredApp.prototype.validateActionSuggestion.call(app, 8, { durationMinutes: 90 }), /no longer available/);
});
