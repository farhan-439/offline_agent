// The Pebble voice mark: five rounded bars, tilted 9°, sage.
// One source for the geometry. The motion lives in mark.css — bars breathe at rest,
// then wave up/down with a zoom while the stone is listening, recording or translating
// (the same motion as the earlier logo-speak test).

export const BARS = [
  { cls: 'b1', x: 4.1, y: 19, h: 26 },
  { cls: 'b2', x: 16.3, y: 11, h: 42 },
  { cls: 'b3', x: 28.5, y: 5, h: 54 },
  { cls: 'b4', x: 40.7, y: 12, h: 40 },
  { cls: 'b5', x: 52.9, y: 20, h: 24 },
];

/** The mark as an SVG string. Animate it by putting `.is-speaking` on any ancestor. */
export function markSVG(size = 64) {
  const rects = BARS.map((b) => `<rect class="bar ${b.cls}" x="${b.x}" y="${b.y}" width="7" height="${b.h}" rx="3.5"/>`).join('');
  return `<svg class="mark-svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false"><g transform="rotate(9 32 32)">${rects}</g></svg>`;
}

/** Put the mark inside an element that already exists (keeps the HTML free of duplicated geometry). */
export function mountMark(el, size = 64) {
  if (el) el.innerHTML = markSVG(size);
  return el;
}
