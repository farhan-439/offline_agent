// "Run" said out loud. Pure text parsing so it can be tested without Electron:
// which phrases mean run, and which clock times or day the owner actually said.
// Nothing here invents a dose, a time or a date the owner did not speak.

const RUN = /^\s*(?:(?:hey|ok|okay)[\s,]+pebble[\s,]*)?(?:please\s+)?(?:run|do it|go ahead|add it|add this|put it in)\b/i;

export function isRunPhrase(text) {
  return RUN.test(String(text ?? ''));
}

const HOURS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** Every clock time in the phrase, normalised to HH:MM, in spoken order. */
export function spokenTimes(text) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  const re = /\b(1[0-2]|0?[1-9]|1[3-9]|2[0-3]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\b/g;
  for (const m of s.matchAll(re)) {
    const word = m[1];
    let hour = HOURS[word] ?? Number(word);
    if (!hour && hour !== 0) continue;
    const suffix = m[3];
    if (suffix) {
      if (hour > 12) continue;
      hour = (hour % 12) + (/^p/.test(suffix) ? 12 : 0);
    } else {
      // A bare hour only counts as a time when it is part of "at 8" / "8 o'clock".
      const before = s.slice(Math.max(0, m.index - 4), m.index);
      const after = s.slice(m.index + m[0].length, m.index + m[0].length + 9);
      const clockish = /\bat\s*$/.test(before) || /^\s*o'?clock/.test(after) || Boolean(m[2]);
      if (!clockish) continue;
    }
    const mm = m[2] ?? '00';
    const value = `${String(hour % 24).padStart(2, '0')}:${mm}`;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** "today", "tomorrow", a weekday, or nothing at all. */
export function spokenDate(text, now = new Date()) {
  const s = String(text ?? '').toLowerCase();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (/\btoday\b/.test(s)) return iso(now);
  if (/\btomorrow\b/.test(s)) { const d = new Date(now); d.setDate(d.getDate() + 1); return iso(d); }
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const hit = days.find((d) => new RegExp(`\\b(?:on |next )?${d}\\b`).test(s));
  if (hit) {
    const target = days.indexOf(hit);
    const d = new Date(now);
    d.setDate(d.getDate() + ((target - d.getDay() + 7) % 7 || 7));
    return iso(d);
  }
  return null;
}

/** "for an hour", "for 45 minutes" — the length of one event, if it was said. */
export function spokenLength(text) {
  const s = String(text ?? '').toLowerCase();
  if (/\bhalf an hour\b/.test(s)) return 30;
  if (/\ban hour\b|\bone hour\b/.test(s)) return 60;
  const m = s.match(/\bfor (\d{1,3}) ?(?:minutes?|mins?)\b/);
  if (m) return Number(m[1]);
  const words = { fifteen: 15, twenty: 20, thirty: 30, forty: 40, fortyfive: 45, fifty: 50, sixty: 60, ninety: 90 };
  const w = s.match(/\bfor (fifteen|twenty|thirty|forty|forty five|fifty|sixty|ninety) minutes?\b/);
  return w ? words[w[1].replace(/\s+/g, '')] ?? null : null;
}

/** "for five days", "for two weeks" — how many repeats, if the owner said it. */
export function spokenCount(text) {
  const s = String(text ?? '').toLowerCase();
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14, twenty: 20, thirty: 30, sixty: 60, ninety: 90 };
  const m = s.match(/\bfor (one|two|three|four|five|six|seven|ten|fourteen|twenty|thirty|sixty|ninety|\d{1,3})\s+(days?|weeks?)\b/);
  if (!m) return null;
  const n = words[m[1]] ?? Number(m[1]);
  if (!n) return null;
  const total = m[2].startsWith('week') ? n * 7 : n;
  return total >= 1 && total <= 366 ? total : null;
}

/** What the owner said, applied on top of a draft — never anything they did not say. */
export function spokenDetails(text, draft = {}) {
  const times = spokenTimes(text);
  const date = spokenDate(text);
  const out = {};
  if (date) out.date = date;
  const length = spokenLength(text);
  if (length && draft.target === 'calendar') out.durationMinutes = length;
  if (draft.target === 'reminders' && draft.repeat && draft.repeat !== 'none') {
    const count = spokenCount(text);
    if (count) out.occurrences = count;
  }
  if (!times.length) return out;
  if (draft.target === 'reminders' && Number(draft.timesPerDay || 1) > 1) out.times = times.slice(0, 8);
  else out.time = times[0];
  return out;
}
