// Resolve explicit relative calendar dates against the recording date, never ask date.
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };
const iso = (date) => date.toISOString().slice(0, 10);

function makeDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? iso(date) : null;
}

export function resolveWhen(when, observedAt) {
  if (!when || !observedAt) return null;
  const base = new Date(`${observedAt.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  const t = String(when).toLowerCase().trim();
  if (/^today\b/.test(t)) return iso(base);
  if (/^tomorrow\b/.test(t)) { base.setUTCDate(base.getUTCDate() + 1); return iso(base); }
  if (/^yesterday\b/.test(t)) { base.setUTCDate(base.getUTCDate() - 1); return iso(base); }
  const weekday = t.match(/\b(?:(this|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (weekday) {
    let delta = (DAYS.indexOf(weekday[2]) - base.getUTCDay() + 7) % 7;
    if (delta === 0 || weekday[1] === 'next') delta += 7;
    base.setUTCDate(base.getUTCDate() + delta);
    return iso(base);
  }
  const month = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/);
  if (month) {
    const day = ORDINALS[month[2]] ?? Number(month[2]);
    const year = Number(month[3]) || base.getUTCFullYear();
    const date = new Date(Date.UTC(year, MONTHS.indexOf(month[1]), day, 12));
    if (!month[3] && date < base) date.setUTCFullYear(year + 1);
    return date.getUTCMonth() === MONTHS.indexOf(month[1]) ? iso(date) : null;
  }
  // "3 December" / "the third of December"
  const dayMonth = t.match(/\b(?:the\s+)?(\d{1,2}|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)(?:st|nd|rd|th)?\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(20\d{2}))?\b/);
  if (dayMonth) {
    const day = ORDINALS[dayMonth[1]] ?? Number(dayMonth[1]);
    const year = Number(dayMonth[3]) || base.getUTCFullYear();
    const date = new Date(Date.UTC(year, MONTHS.indexOf(dayMonth[2]), day, 12));
    if (!dayMonth[3] && date < base) date.setUTCFullYear(year + 1);
    return date.getUTCMonth() === MONTHS.indexOf(dayMonth[2]) ? iso(date) : null;
  }
  // ISO and US numeric dates: 2026-12-03, 12/3, 12/3/2026, 12/3/26
  const numeric = t.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/) ?? t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}|\d{2}))?\b/);
  if (numeric) {
    let year, mon, day;
    if (numeric[1].length === 4) [year, mon, day] = [Number(numeric[1]), Number(numeric[2]), Number(numeric[3])];
    else {
      [mon, day] = [Number(numeric[1]), Number(numeric[2])];
      const y = numeric[3];
      year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : base.getUTCFullYear();
    }
    return makeDate(year, mon, day);
  }
  // "the 15th" / "on the 3rd" — this month if still ahead, otherwise next month
  const dom = t.match(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/);
  if (dom) {
    const day = Number(dom[1]);
    const thisMonth = makeDate(base.getUTCFullYear(), base.getUTCMonth() + 1, day);
    if (thisMonth && thisMonth >= iso(base)) return thisMonth;
    const next = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1, 12));
    return makeDate(next.getUTCFullYear(), next.getUTCMonth() + 1, day);
  }
  return null;
}
