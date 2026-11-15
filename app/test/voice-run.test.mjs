import test from 'node:test';
import assert from 'node:assert/strict';
import { isRunPhrase, spokenTimes, spokenDate, spokenDetails } from '../voice-run.mjs';

test('only real "run" phrases start a run', () => {
  for (const phrase of ['run', 'Run it', 'hey Pebble, run', 'please run', 'do it', 'add it to my calendar', 'put it in reminders']) {
    assert.equal(isRunPhrase(phrase), true, phrase);
  }
  for (const phrase of ['what did the pharmacist say?', 'add sugar', 'running late', '']) {
    assert.equal(isRunPhrase(phrase), false, phrase);
  }
});

test('spoken times become HH:MM, and a bare number is not a time', () => {
  assert.deepEqual(spokenTimes('run at 8am'), ['08:00']);
  assert.deepEqual(spokenTimes('run tomorrow at 8'), ['08:00']);
  assert.deepEqual(spokenTimes('run at 8:30 pm'), ['20:30']);
  assert.deepEqual(spokenTimes('run at 8, 2 pm and 8 pm'), ['08:00', '14:00', '20:00']);
  assert.deepEqual(spokenTimes('run it 3 times a day'), []);
  assert.deepEqual(spokenTimes('add 5 apples'), []);
});

test('spoken days resolve against the day it was said', () => {
  const sunday = new Date('2026-11-15T10:00:00');
  assert.equal(spokenDate('run today', sunday), '2026-11-15');
  assert.equal(spokenDate('run tomorrow', sunday), '2026-11-16');
  assert.equal(spokenDate('run on monday', sunday), '2026-11-16');
  assert.equal(spokenDate('run it', sunday), null);
});

test('a spoken time lands in the right field for each kind of action', () => {
  const reminders = { target: 'reminders', timesPerDay: 3 };
  assert.deepEqual(spokenDetails('run tomorrow at 8, 2 pm and 8 pm', reminders),
    { date: '2026-11-16', times: ['08:00', '14:00', '20:00'] });
  const calendar = { target: 'calendar' };
  assert.deepEqual(spokenDetails('run at 9 am', calendar), { time: '09:00' });
  // nothing said, nothing invented
  assert.deepEqual(spokenDetails('run', calendar), {});
});
