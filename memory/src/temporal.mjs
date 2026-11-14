// Resolve explicit relative calendar dates against the recording date, never ask date.
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const iso = (date) => date.toISOString().slice(0, 10);

export function resolveWhen(when, observedAt) {
  if (!when || !observedAt) return null;
  const base = new Date(`${observedAt.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  const t = when.toLowerCase().trim();
  if (/^today\b/.test(t)) return iso(base);
  if (/^tomorrow\b/.test(t)) { base.setUTCDate(base.getUTCDate() + 1); return iso(base); }
  const weekday = t.match(/\b(?:(this|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (weekday) {
    let delta = (DAYS.indexOf(weekday[2]) - base.getUTCDay() + 7) % 7;
    if (delta === 0 || weekday[1] === 'next') delta += 7;
    base.setUTCDate(base.getUTCDate() + delta);
    return iso(base);
  }
  const month = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}|first|second|third|fourth|fifth)(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/);
  if (month) {
    const day = ORDINALS[month[2]] ?? Number(month[2]);
    const year = Number(month[3]) || base.getUTCFullYear();
    const date = new Date(Date.UTC(year, MONTHS.indexOf(month[1]), day, 12));
    if (!month[3] && date < base) date.setUTCFullYear(year + 1);
    return date.getUTCMonth() === MONTHS.indexOf(month[1]) ? iso(date) : null;
  }
  return null;
}
