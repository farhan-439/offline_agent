// Small text helpers for deterministic duplicate detection (no model involved).
const STOP = new Set('a an the and or but of to in on at for with about from by is are was were be been am do does did what when where who whom which how why that this these those i me my mine you your he she it they them his her their we our us said say says tell told'.split(' '));

export function tokens(text) {
  // keep single-digit numbers: "5 mg" and "10 mg" must not collapse into the same tokens
  return (String(text ?? '').toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)?/g) ?? []).filter((t) => (t.length > 1 || /^\d+$/.test(t)) && !STOP.has(t));
}

export function jaccard(a, b) {
  const x = new Set(tokens(a));
  const y = new Set(tokens(b));
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

/** Two facts of the same person and kind saying the same thing. */
export function sameFact(a, b, threshold = 0.8) {
  return jaccard(a, b) >= threshold;
}

const ORDINAL_NUMBERS = { first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10', eleventh: '11', twelfth: '12' };

/** Numbers (doses, dates, times, ordinals) that must not be silently merged away. */
export function numbersIn(text) {
  const s = String(text ?? '').toLowerCase();
  const digits = s.match(/\b\d+(?:\.\d+)?\b/g) ?? [];
  const ordinals = (s.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\b/g) ?? []).map((w) => ORDINAL_NUMBERS[w]);
  return new Set([...digits, ...ordinals]);
}

/** True when `next` contradicts `prev` by changing a number in a near-identical sentence. */
export function contradicts(prev, next) {
  if (jaccard(prev, next) < 0.5) return false;
  const a = numbersIn(prev);
  const b = numbersIn(next);
  if (!a.size || !b.size) return false;
  for (const n of b) if (!a.has(n)) return true;
  return false;
}
