// Memory map: the whole memory on one screen.
//   pipeline  — heard → filtered → summarized → remembered → in mind (counts from /layers)
//   people    — a constellation: you in the middle, each person around you, their facts orbiting them
//   recall    — how much memory has been used, and what the last question pulled from disk
//   kinds     — what kind of things are kept
//   trace     — click anything: the exact words → episode → fact → person card (+ play the clip)
//   activity  — the last 14 days
// Everything is read from memory endpoints; nothing is invented.

const SVGNS = 'http://www.w3.org/2000/svg';
const ICON = {
  mic: '<rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  filter: '<path d="M3.5 4.5h17l-6.5 8v6l-4 2v-8z"/>',
  layers: '<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
  database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  users: '<circle cx="9" cy="8" r="3.6"/><path d="M2.5 20.5c0-3.7 2.9-6.4 6.5-6.4s6.5 2.7 6.5 6.4"/><path d="M15.8 4.6a3.6 3.6 0 0 1 0 6.8"/><path d="M21.5 20.5c0-2.9-1.7-5.1-4.4-6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20.5 20.5-4.7-4.7"/>',
  sparkle: '<path d="M12 3.5l1.8 4.8 4.7 1.7-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.7z"/><path d="M18.5 15v4.5M16.3 17.3h4.4"/>',
  check: '<path d="M20 6.5 9.5 17 4 11.5"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  route: '<circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="5.5" r="2.5"/><path d="M8.5 18.5H17a3.3 3.3 0 0 0 0-6.6H7a3.3 3.3 0 0 1 0-6.6h8.5"/>',
  ring: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v8.5l6 3"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  pulse: '<path d="M3 12h4l2.5-6 3.5 12 2.5-6H21"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5s1.2-6.1 3.6-8.5z"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
};
// kind → [label, glyph, colour]
const KIND = {
  health: ['Health', '✚', '#B4503C'], medication: ['Medication', '℞', '#B4503C'],
  plan: ['Plans', '◷', '#3C6B78'], promise_by_owner: ['Your promises', '✓', '#4E6B57'], promise_by_them: ['Their promises', '✓', '#4E6B57'],
  family: ['Family', '⌂', '#8A5A86'], personal: ['Personal', '●', '#8A5A86'], preference: ['Likes', '♥', '#8A5A86'],
  directions: ['Directions', '➚', '#A07A2C'], travel: ['Travel', '✈', '#A07A2C'],
  miscellaneous: ['Other', '◆', '#837E74'], other: ['Other', '◆', '#837E74'],
};
const kindOf = (k) => KIND[k] ?? KIND.other;
const PEOPLE_COLORS = ['#4E6B57', '#B4503C', '#3C6B78', '#8A5A86', '#A07A2C', '#5E6B8C', '#7A6A55', '#4F7F7A'];

let state = { selected: null };
let ctx = null; // { root, data, opts }

// ---------- tiny DOM helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
function icon(name, cls = 'ai') {
  const el = document.createElementNS(SVGNS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('class', cls); el.setAttribute('aria-hidden', 'true');
  el.innerHTML = ICON[name]; // static, trusted markup
  return el;
}
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const initials = (name = '?') => name.replace(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?)\s+/i, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const clip = (t, n) => (t && t.length > n ? `${t.slice(0, n - 1)}…` : t ?? '');

// ---------- links between layers ----------
function utterances(d) { return d.sessions.flatMap((x) => x.utterances.map((u) => ({ ...u, place: x.place ?? x.id, at: x.startedAt }))); }
function lineage(d, ref) {
  const set = new Set([ref]);
  const addFact = (f) => { set.add(f.ref); f.evidence.forEach((u) => set.add(`U:${u}`)); if (f.episode) set.add(f.episode); f.people.forEach((p) => set.add(`P:${p}`)); };
  if (/^F\d+$/.test(ref)) { const f = d.facts.find((x) => x.ref === ref); if (f) addFact(f); }
  else if (ref.startsWith('P:')) { const pid = ref.slice(2); d.facts.filter((f) => f.people.includes(pid)).forEach(addFact); }
  else if (/^E\d+$/.test(ref)) { d.episodes.find((e) => e.ref === ref)?.utterances.forEach((u) => set.add(`U:${u}`)); d.facts.filter((f) => f.episode === ref).forEach(addFact); }
  return set;
}
function recallSets(recall) {
  const ok = (r) => typeof r === 'string';
  const c = new Set(), k = new Set(), cited = new Set();
  for (const step of recall?.trace ?? []) {
    [...(step.candidates ?? []), ...(step.loaded ?? [])].filter(ok).forEach((r) => c.add(r));
    (step.selected ?? []).filter(ok).forEach((r) => k.add(r));
    (step.cite ?? []).filter(ok).forEach((r) => cited.add(r));
  }
  return { candidates: c, kept: k, cited };
}

// ---------- 1 · pipeline ----------
function pipeline(t) {
  const stage = (ic, n, label, cls = '') => h('div', { class: `pl-stage ${cls}` },
    h('span', { class: 'pl-tile' }, icon(ic)),
    h('div', {}, h('strong', { text: n }), h('span', { class: 'pl-label', text: label })));
  const arrow = () => h('span', { class: 'pl-arrow', 'aria-hidden': 'true', text: '→' });
  return h('section', { class: 'at-pipeline', 'aria-label': 'How memory is built' },
    stage('mic', t.utterances, 'lines heard'), arrow(),
    stage('filter', t.filtered, 'skipped as filler', 'warm'), arrow(),
    stage('layers', t.episodes, 'moments summarized'), arrow(),
    stage('database', t.facts, 'facts saved'), arrow(),
    stage('users', t.people, 'people known'));
}

// ---------- 2 · people constellation ----------
function constellation(d, lit, size) {
  const W = Math.max(320, size?.w ?? 460), H = Math.max(260, size?.h ?? 400);
  const cx = W / 2, cy = H / 2;
  const people = d.people;
  const owner = people.find((p) => p.isOwner);
  const others = people.filter((p) => !p.isOwner);
  const ownerId = owner?.id;
  const factsOf = (pid) => d.facts.filter((f) => f.status === 'active' && ((f.people[0] ?? ownerId) === pid));
  const pos = new Map();
  if (owner) pos.set(owner.id, { x: cx, y: cy });
  const rx = W / 2 - 64, ry = H / 2 - 64;
  const twoRings = others.length > 8;
  others.forEach((p, i) => {
    const inner = twoRings && i % 2 === 1;
    const a = -Math.PI / 2 + (i / Math.max(1, others.length)) * Math.PI * 2;
    const k = inner ? 0.62 : 1;
    pos.set(p.id, { x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k, a });
  });
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'at-constellation', role: 'img', 'aria-label': 'People and the facts kept about them' });
  const dim = (ref) => (lit && !lit.has(ref) ? ' dim' : '');

  svg.append(s('ellipse', { cx, cy, rx, ry, class: 'orbit' }));
  if (twoRings) svg.append(s('ellipse', { cx, cy, rx: rx * 0.62, ry: ry * 0.62, class: 'orbit' }));
  for (const p of others) {
    const q = pos.get(p.id);
    svg.append(s('line', { x1: cx, y1: cy, x2: q.x, y2: q.y, class: `edge${dim(`P:${p.id}`)}` }));
  }
  for (const p of people) {
    const q = pos.get(p.id); if (!q) continue;
    const list = factsOf(p.id);
    const isCenter = p.isOwner;
    const ring = isCenter ? 62 : 44;
    const base = isCenter ? -Math.PI / 2 : (q.a ?? 0);
    const spread = isCenter ? Math.PI * 2 : Math.min(Math.PI * 1.3, 0.55 * list.length);
    const slots = [];
    if (isCenter) {
      let r = 50, left = list.length;
      while (left > 0) { const cap = Math.max(6, Math.floor((2 * Math.PI * r) / 27)); const n = Math.min(cap, left);
        for (let k = 0; k < n; k++) slots.push({ r, a: -Math.PI / 2 + (k / n) * Math.PI * 2 + (r > 50 ? Math.PI / n : 0) }); left -= n; r += 26; }
    }
    list.forEach((f, i) => {
      const a = isCenter ? slots[i].a : base - spread / 2 + (list.length === 1 ? spread / 2 : (i / (list.length - 1)) * spread);
      const rr = isCenter ? slots[i].r : ring;
      const x = q.x + Math.cos(a) * rr, y = q.y + Math.sin(a) * rr;
      const [label, glyph, col] = kindOf(f.kind);
      svg.append(s('g', { class: `sat${dim(f.ref)}${state.selected === f.ref ? ' picked' : ''}`, tabindex: '0', role: 'button', 'aria-label': `${label}: ${f.text}`,
        onclick: (e) => { e.stopPropagation(); select(f.ref); }, onkeydown: (e) => { if (e.key === 'Enter') select(f.ref); } },
      s('title', {}, `${label} · ${f.text}`),
      s('circle', { cx: x, cy: y, r: 11.5, fill: '#FFFDFA', stroke: col, 'stroke-width': f.uses ? 2.4 : 1.4 }),
      s('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'sat-glyph', fill: col }, glyph)));
    });
  }
  for (const p of people) {
    const q = pos.get(p.id); if (!q) continue;
    const r = p.isOwner ? 27 : 22;
    const name = p.isOwner ? 'You' : p.name;
    svg.append(s('g', { class: `node${p.isOwner ? ' owner' : ''}${dim(`P:${p.id}`)}${state.selected === `P:${p.id}` ? ' picked' : ''}`, tabindex: '0', role: 'button', 'aria-label': name,
      onclick: (e) => { e.stopPropagation(); select(`P:${p.id}`); }, onkeydown: (e) => { if (e.key === 'Enter') select(`P:${p.id}`); } },
    s('title', {}, `${name}${p.relation && !p.isOwner ? ` · ${p.relation}` : ''}\n${p.core ?? 'No card yet'}`),
    s('circle', { cx: q.x, cy: q.y, r: r + 5, class: 'halo' }),
    s('circle', { cx: q.x, cy: q.y, r, class: 'disc' }),
    s('text', { x: q.x, y: q.y + 4.5, 'text-anchor': 'middle', class: 'node-text' }, p.isOwner ? 'You' : initials(p.name)),
    p.voiceSamples ? s('circle', { cx: q.x + r * 0.72, cy: q.y + r * 0.72, r: 5.5, class: 'voice-dot' }) : null,
    !p.isOwner ? s('text', { x: q.x, y: q.y + r + 15, 'text-anchor': 'middle', class: 'node-name' }, clip(p.name, 16)) : null,
    !p.isOwner && p.relation ? s('text', { x: q.x, y: q.y + r + 27, 'text-anchor': 'middle', class: 'node-rel' }, clip(p.relation, 18)) : null));
  }
  return svg;
}

// ---------- 2b · flow graph: recordings → moments → facts → people ----------
const LANGS = new Set(['zh', 'es', 'fr', 'de', 'id', 'ja', 'ko', 'it', 'pt']);
function flowGraph(d, lit, size) {
  const W = Math.max(380, size?.w ?? 520), H = Math.max(300, size?.h ?? 460);
  const top = 52, bottom = 30, tile = 24, step = 31;
  const rows = Math.max(4, Math.floor((H - top - bottom) / step));
  const ownerId = d.people.find((p) => p.isOwner)?.id;

  // pick what fits: the most recent conversations, then everything that grew out of them
  const epBySession = new Map();
  for (const e of d.episodes) { if (!epBySession.has(e.session)) epBySession.set(e.session, []); epBySession.get(e.session).push(e); }
  const sessions = d.sessions.filter((x) => epBySession.has(x.id))
    .sort((a, b) => (!!b.place - !!a.place) || String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, rows);
  const sesIds = new Set(sessions.map((x) => x.id));
  const episodes = d.episodes.filter((e) => sesIds.has(e.session)).sort((a, b) => sessions.findIndex((x) => x.id === a.session) - sessions.findIndex((x) => x.id === b.session)).slice(0, rows);
  const epIds = new Set(episodes.map((e) => e.ref));
  const facts = d.facts.filter((f) => f.status === 'active' && epIds.has(f.episode))
    .sort((a, b) => episodes.findIndex((e) => e.ref === a.episode) - episodes.findIndex((e) => e.ref === b.episode)).slice(0, rows);
  const pid = (f) => f.people[0] ?? ownerId;
  const peopleIds = [...new Set(facts.flatMap((f) => (f.people.length ? f.people : [ownerId])).filter(Boolean))];
  const people = d.people.filter((p) => peopleIds.includes(p.id)).sort((a, b) => (b.isOwner - a.isOwner) || (facts.findIndex((f) => pid(f) === a.id) - facts.findIndex((f) => pid(f) === b.id))).slice(0, rows);

  const c1 = Math.min(150, Math.round(W * 0.22)), c4 = W - Math.min(110, Math.round(W * 0.24)), gap = (c4 - c1) / 3;
  const X = [c1, c1 + gap, c1 + gap * 2, c4];
  const colY = (n) => { const span = (n - 1) * step; const y0 = top + Math.max(0, ((H - top - bottom) - span - tile) / 2); return (i) => y0 + i * step; };
  const pos = new Map();
  const y1 = colY(sessions.length), y2 = colY(episodes.length), y3 = colY(facts.length), y4 = colY(people.length);
  sessions.forEach((x, i) => pos.set(`S:${x.id}`, { x: X[0], y: y1(i) }));
  episodes.forEach((e, i) => pos.set(e.ref, { x: X[1], y: y2(i) }));
  facts.forEach((f, i) => pos.set(f.ref, { x: X[2], y: y3(i) }));
  people.forEach((p, i) => pos.set(`P:${p.id}`, { x: X[3], y: y4(i) }));

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'at-flow', role: 'img', 'aria-label': 'How recordings become moments, facts and people' });
  const on = (ref) => !lit || lit.has(ref);
  const sessionLit = (sid) => !lit || [...lit].some((r) => r.startsWith('U:') && d.sessions.find((x) => x.id === sid)?.utterances.some((u) => `U:${u.id}` === r));

  // column headers
  const head = (x, n, label) => { svg.append(s('text', { x, y: 16, 'text-anchor': 'middle', class: 'fl-n' }, n)); svg.append(s('text', { x, y: 30, 'text-anchor': 'middle', class: 'fl-head' }, label)); };
  head(X[0] + tile / 2, d.totals.sessions, 'RECORDINGS'); head(X[1] + tile / 2, d.totals.episodes, 'MOMENTS');
  head(X[2] + tile / 2, d.totals.facts, 'FACTS'); head(X[3] + tile / 2, d.totals.people, 'PEOPLE');
  svg.append(s('line', { x1: 10, x2: W - 10, y1: 40, y2: 40, class: 'fl-rule' }));

  // links (drawn first, under tiles)
  const link = (a, b, cls, w, col) => {
    const p = pos.get(a), q = pos.get(b); if (!p || !q) return;
    const xa = p.x + tile + 4, ya = p.y + tile / 2, xb = q.x - 2, yb = q.y + tile / 2, mx = (xa + xb) / 2;
    const el = s('path', { d: `M${xa},${ya} C${mx},${ya} ${mx},${yb} ${xb},${yb}`, class: `fl-link ${cls}`, 'stroke-width': w });
    if (col) el.style.setProperty('--c', col);
    svg.append(el);
  };
  for (const e of episodes) link(`S:${e.session}`, e.ref, (sessionLit(e.session) && on(e.ref)) ? (lit ? 'hot' : '') : 'dim', Math.min(3.2, 0.8 + e.utterances.length * 0.25));
  for (const f of facts) {
    const col = kindOf(f.kind)[2];
    link(f.episode, f.ref, on(f.ref) && on(f.episode) ? (lit ? 'hot' : 'kind') : 'dim', 1 + Math.min(3, f.uses), col);
    for (const p of (f.people.length ? f.people : [ownerId])) link(f.ref, `P:${p}`, on(f.ref) && on(`P:${p}`) ? (lit ? 'hot' : 'kind') : 'dim', 1 + Math.min(3, f.uses), col);
  }

  // tiles
  const tileG = (ref, x, y, cls, title, inner, onClick) => {
    const g = s('g', { class: `fl-tile ${cls}${state.selected === ref ? ' picked' : ''}${lit && !on(ref) ? ' dim' : ''}`, tabindex: '0', role: 'button', 'aria-label': title,
      onclick: (e) => { e.stopPropagation(); onClick(); }, onkeydown: (e) => { if (e.key === 'Enter') onClick(); } },
    s('title', {}, title), s('rect', { x, y, width: tile, height: tile, rx: 5, class: 'box' }), inner,
    s('path', { d: `M${x + tile + 1},${y + tile / 2 - 3.5} l4,3.5 -4,3.5z`, class: 'port' }));
    svg.append(g);
  };
  for (const x of sessions) {
    const p = pos.get(`S:${x.id}`);
    const lang = x.utterances.find((u) => LANGS.has(u.language) && u.translation)?.language;
    const firstEp = episodes.find((e) => e.session === x.id);
    const label = x.place ?? (lang ? 'Translated conversation' : 'Conversation');
    tileG(`S:${x.id}`, p.x, p.y, lang ? 'lang' : 'rec', `${label} · ${fmtDate(x.startedAt)} · ${x.utterances.length} lines`,
      lang ? s('text', { x: p.x + tile / 2, y: p.y + tile / 2 + 3.5, 'text-anchor': 'middle', class: 'fl-code' }, lang.toUpperCase())
        : s('g', {}, [0, 1, 2, 3].map((k) => s('rect', { x: p.x + 6 + k * 4, y: p.y + 13 - [3, 7, 9, 5][k] / 2, width: 2, height: [3, 7, 9, 5][k], rx: 1, class: 'bars' }))),
      () => firstEp && select(firstEp.ref));
    svg.append(s('text', { x: p.x - 10, y: p.y + 11, 'text-anchor': 'end', class: `fl-label${lit && !sessionLit(x.id) ? ' dim' : ''}` }, clip(label, Math.max(10, Math.floor(c1 / 7.2)))));
    svg.append(s('text', { x: p.x - 10, y: p.y + 23, 'text-anchor': 'end', class: `fl-sub${lit && !sessionLit(x.id) ? ' dim' : ''}` }, fmtDate(x.startedAt)));
  }
  for (const e of episodes) {
    const p = pos.get(e.ref);
    const n = Math.min(6, e.utterances.length);
    tileG(e.ref, p.x, p.y, 'moment', `${e.ref} · ${e.summary}`,
      s('g', {}, Array.from({ length: n }, (_, k) => s('rect', { x: p.x + 5, y: p.y + 5 + k * (16 / n), width: 16 - (k % 3) * 4, height: Math.max(1.6, 16 / n - 1.2), rx: 0.8, class: 'lines' }))),
      () => select(e.ref));
  }
  for (const f of facts) {
    const p = pos.get(f.ref);
    const [label, glyph, col] = kindOf(f.kind);
    const g = s('text', { x: p.x + tile / 2, y: p.y + tile / 2 + 4.5, 'text-anchor': 'middle', class: 'fl-glyph', fill: col }, glyph);
    tileG(f.ref, p.x, p.y, 'fact', `${label} · ${f.text}`, g, () => select(f.ref));
    const box = svg.lastChild.querySelector('.box'); box.style.setProperty('--c', col);
  }
  for (const p of people) {
    const q = pos.get(`P:${p.id}`);
    tileG(`P:${p.id}`, q.x, q.y, `person${p.isOwner ? ' owner' : ''}`, `${p.isOwner ? 'You' : p.name}${p.relation && !p.isOwner ? ` · ${p.relation}` : ''}\n${p.core ?? ''}`,
      s('g', {}, s('text', { x: q.x + tile / 2, y: q.y + tile / 2 + 4, 'text-anchor': 'middle', class: 'fl-init' }, p.isOwner ? 'Me' : initials(p.name)),
        p.voiceSamples ? s('circle', { cx: q.x + tile - 1, cy: q.y + tile - 1, r: 3.6, class: 'voice' }) : null),
      () => select(`P:${p.id}`));
    const dimCls = lit && !on(`P:${p.id}`) ? ' dim' : '';
    svg.append(s('text', { x: q.x + tile + 12, y: q.y + 11, class: `fl-label${dimCls}` }, p.isOwner ? 'You' : clip(p.name, 10)));
    svg.append(s('text', { x: q.x + tile + 12, y: q.y + 23, class: `fl-sub${dimCls}` }, p.isOwner ? 'owner' : clip(p.relation ?? '', 18)));
  }

  // one quiet annotation, playground-style, in the free corner under the people column
  if (!lit && facts.length) {
    const lastY = Math.max(...people.map((p) => pos.get(`P:${p.id}`).y)) + tile;
    const nx = X[2] + tile + 22, ny = Math.max(lastY + 48, H - 70);
    if (ny < H - 20) {
      svg.append(s('path', { d: `M${nx + 4},${ny - 13} q -10,-16 -${nx - X[2] - tile - 8},-28`, class: 'fl-note-arrow' }));
      svg.append(s('text', { class: 'fl-note' }, s('tspan', { x: nx, y: ny }, 'Each line traces a fact'), s('tspan', { x: nx, dy: 13 }, 'back to where it was heard.'),
        s('tspan', { x: nx, dy: 13 }, 'Thicker = used more.')));
    }
  }
  const more = d.totals.sessions - sessions.length;
  if (more > 0) svg.append(s('text', { x: X[0] + tile / 2, y: H - 10, 'text-anchor': 'middle', class: 'fl-sub' }, `+ ${more} older`));
  return svg;
}

// ---------- 2c · timeline: people × days, past facts and what's coming ----------
function timeline(d, lit, size) {
  const W = Math.max(380, size?.w ?? 560), H = Math.max(300, size?.h ?? 460);
  const DAY = 86400000;
  const dayKey = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const asDay = (iso) => { if (!iso) return null; const dt = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso); if (Number.isNaN(dt.getTime())) return null; dt.setHours(12, 0, 0, 0); return dt; };
  const ownerId = d.people.find((p) => p.isOwner)?.id;
  const facts = d.facts.filter((f) => f.status === 'active' && asDay(f.observedAt));
  const future = (f) => { const t = asDay(f.whenResolved); return t && t > today ? t : null; };

  // axis: only days that hold something (heard, today, happens) — evenly spaced, gaps marked
  const start = new Date(today.getTime() - 20 * DAY);
  const keys = new Set([dayKey(today)]);
  for (const f of facts) { const h0 = asDay(f.observedAt); if (h0 >= start) keys.add(dayKey(h0)); const t = future(f); if (t) keys.add(dayKey(t)); }
  const axis = [...keys].sort().map((k) => new Date(`${k}T12:00:00`));
  const days = axis.length;
  // rows: people with facts, owner first, most facts next
  const rowOf = (f) => f.people[0] ?? ownerId;
  const count = new Map();
  for (const f of facts) count.set(rowOf(f), (count.get(rowOf(f)) ?? 0) + 1);
  const rows = d.people.filter((p) => count.has(p.id)).sort((a, b) => (b.isOwner - a.isOwner) || (count.get(b.id) - count.get(a.id)));
  const labelW = 118, top = 40, bottom = 22, right = 14;
  const rowH = Math.min(58, (H - top - bottom) / Math.max(1, rows.length));
  const colW = (W - labelW - right) / days;
  const idx = new Map(axis.map((dt, i) => [dayKey(dt), i]));
  const x = (dt) => labelW + ((idx.get(dayKey(dt)) ?? 0) + 0.5) * colW;
  const y = (pid) => top + rows.findIndex((p) => p.id === pid) * rowH + rowH / 2;
  const utt = new Map(d.sessions.flatMap((s_) => s_.utterances.map((u) => [u.id, u])));
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'at-timeline', role: 'img', 'aria-label': 'Facts by person and day, with what is coming up' });
  const on = (ref) => !lit || lit.has(ref);

  // future region + day grid + axis
  const tx = x(today);
  svg.append(s('rect', { x: tx, y: top - 6, width: Math.max(0, W - right - tx), height: H - top - bottom + 6, class: 'tl-future' }));
  svg.append(s('text', { x: tx + 5, y: H - 6, class: 'tl-today-label' }, 'today →'));
  axis.forEach((dt, i) => {
    const cx = x(dt), isToday = dayKey(dt) === dayKey(today);
    if (i % 2 === 1) svg.append(s('rect', { x: cx - colW / 2, y: top - 6, width: colW, height: H - top - bottom + 6, class: 'tl-weekend' }));
    svg.append(s('text', { x: cx, y: 13, 'text-anchor': 'middle', class: 'tl-dow' }, dt.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()));
    svg.append(s('text', { x: cx, y: 28, 'text-anchor': 'middle', class: `tl-day${isToday ? ' now' : ''}` }, dt.getDate()));
    const prev = axis[i - 1];
    if (prev && Math.round((dt - prev) / DAY) > 1) {
      const gx = cx - colW / 2;
      svg.append(s('path', { d: `M${gx - 3},${top - 4} l3,-5 l3,5`, class: 'tl-gap' }, s('title', {}, `${Math.round((dt - prev) / DAY) - 1} quiet days`)));
    }
  });
  svg.append(s('line', { x1: tx, x2: tx, y1: top - 8, y2: H - bottom, class: 'tl-today' }));
  svg.append(s('text', { x: tx, y: top - 10 + 0, 'text-anchor': 'middle', class: 'tl-today-label' }, ''));

  // rows
  rows.forEach((p, i) => {
    const ry = top + i * rowH;
    if (i) svg.append(s('line', { x1: 8, x2: W - right, y1: ry, y2: ry, class: 'tl-row-rule' }));
    const cy = ry + rowH / 2;
    const g = s('g', { class: `tl-person${lit && !on(`P:${p.id}`) ? ' dim' : ''}${state.selected === `P:${p.id}` ? ' picked' : ''}`, tabindex: '0', role: 'button', 'aria-label': p.isOwner ? 'You' : p.name,
      onclick: (e) => { e.stopPropagation(); select(`P:${p.id}`); }, onkeydown: (e) => { if (e.key === 'Enter') select(`P:${p.id}`); } },
    s('title', {}, p.core ?? ''),
    s('circle', { cx: 22, cy, r: 13, class: `tl-av${p.isOwner ? ' owner' : ''}` }),
    s('text', { x: 22, y: cy + 4, 'text-anchor': 'middle', class: 'tl-av-text' }, p.isOwner ? 'Me' : initials(p.name)),
    p.voiceSamples ? s('circle', { cx: 32, cy: cy + 9, r: 3.5, class: 'tl-voice' }) : null,
    s('text', { x: 42, y: cy - 1, class: 'tl-name' }, p.isOwner ? 'You' : clip(p.name, 11)),
    s('text', { x: 42, y: cy + 11, class: 'tl-rel' }, p.isOwner ? `${count.get(p.id)} facts` : clip(p.relation ?? `${count.get(p.id)} facts`, 13)));
    svg.append(g);
  });

  // facts: stack chips that share a day in the same row; overflow becomes a "+N" badge
  const r = Math.max(7, Math.min(10.5, rowH / 4.6, colW / 2.6));
  const perCol = Math.max(1, Math.floor((rowH - 6) / (r * 2 + 3)));
  const perRow = Math.max(1, Math.floor(colW / (r * 2 + 2)));
  const cap = perCol * perRow;
  const cells = new Map();
  for (const f of facts) {
    const dt = asDay(f.observedAt); if (dt < start) continue;
    const k = `${rowOf(f)}|${dayKey(dt)}`;
    if (!cells.has(k)) cells.set(k, { dt, pid: rowOf(f), list: [] });
    cells.get(k).list.push(f);
  }
  const placed = [], overflow = [];
  const slot = (cell, n) => {
    const col = Math.floor(n / perCol), rowIdx = n % perCol;
    const used = Math.min(perCol, cell.list.length);
    return { x: x(cell.dt) + (col - (Math.min(perRow, Math.ceil(cell.list.length / perCol)) - 1) / 2) * (r * 2 + 2),
      y: y(cell.pid) + (rowIdx - (used - 1) / 2) * (r * 2 + 3), r };
  };
  for (const cell of cells.values()) {
    const sorted = [...cell.list].sort((a, b) => (!!future(b) - !!future(a)) || ((b.kind !== 'miscellaneous') - (a.kind !== 'miscellaneous')));
    const shown = sorted.length > cap ? sorted.slice(0, cap - 1) : sorted;
    shown.forEach((f, n) => placed.push([f, slot(cell, n), sorted.length <= cap]));
    if (sorted.length > cap) overflow.push({ ...slot(cell, cap - 1), more: sorted.slice(cap - 1) });
  }

  // arcs to the future date first (under chips)
  for (const [f, q] of placed) {
    const t = future(f); if (!t) continue;
    const fx = x(t), [, , col] = kindOf(f.kind);
    const lift = Math.min(rowH * 0.9, 18 + (fx - q.x) * 0.12);
    const arc = s('path', { d: `M${q.x},${q.y - q.r} C${q.x},${q.y - lift} ${fx},${q.y - lift} ${fx},${q.y - 7}`, class: `tl-arc${lit && !on(f.ref) ? ' dim' : ''}` });
    arc.style.setProperty('--c', col); svg.append(arc);
    const goal = s('g', { class: `tl-goal${lit && !on(f.ref) ? ' dim' : ''}`, onclick: (e) => { e.stopPropagation(); select(f.ref); } },
      s('title', {}, `${fmtDate(f.whenResolved)} · ${f.text}`),
      s('rect', { x: fx - 7, y: q.y - 7, width: 14, height: 14, rx: 3, transform: `rotate(45 ${fx} ${q.y})`, class: 'tl-goal-box' }),
      s('text', { x: fx, y: q.y + 20, 'text-anchor': 'middle', class: 'tl-goal-date' }, fmtDate(f.whenResolved)));
    goal.querySelector('.tl-goal-box').style.setProperty('--c', col);
    svg.append(goal);
  }
  for (const [f, q, roomy] of placed) {
    const [label, glyph, col] = kindOf(f.kind);
    const tagged = roomy ? f.evidence.map((id) => utt.get(id)).find((u) => u?.translation && u.language && u.language !== 'en')?.language : null;
    // The tag is drawn outside the chip's edge, so it only fits when no neighbouring chip
    // on the same day would sit under it (crowded days keep the map readable).
    const lang = tagged && !placed.some(([, o]) => o !== q && Math.hypot(o.x - q.x, o.y - q.y) < q.r + o.r + 7) ? tagged : null;
    const g = s('g', { class: `tl-fact${lit && !on(f.ref) ? ' dim' : ''}${state.selected === f.ref ? ' picked' : ''}`, tabindex: '0', role: 'button', 'aria-label': `${label}: ${f.text}`,
      onclick: (e) => { e.stopPropagation(); select(f.ref); }, onkeydown: (e) => { if (e.key === 'Enter') select(f.ref); } },
    s('title', {}, `${label} · heard ${fmtDate(f.observedAt)}\n${f.text}`),
    s('circle', { cx: q.x, cy: q.y, r: q.r, class: 'tl-chip', 'stroke-width': f.uses ? 2.2 : 1.3 }),
    s('text', { x: q.x, y: q.y + q.r * 0.38, 'text-anchor': 'middle', class: 'tl-glyph', fill: col, 'font-size': q.r * 1.05 }, glyph),
    lang ? s('text', { x: q.x + q.r - 1, y: q.y - q.r + 2, class: 'tl-lang' }, lang.toUpperCase()) : null);
    g.querySelector('.tl-chip').style.setProperty('--c', col);
    svg.append(g);
  }
  for (const o of overflow) {
    svg.append(s('g', { class: `tl-more${lit ? ' dim' : ''}` },
      s('title', {}, o.more.map((f) => `• ${f.text}`).join('\n')),
      s('circle', { cx: o.x, cy: o.y, r: o.r, class: 'tl-more-chip' }),
      s('text', { x: o.x, y: o.y + 3.2, 'text-anchor': 'middle', class: 'tl-more-text' }, `+${o.more.length}`)));
  }
  return svg;
}

// ---------- 3 · recall ----------
function donut(pct) {
  const r = 30, c = 2 * Math.PI * r;
  return s('svg', { viewBox: '0 0 80 80', class: 'at-donut', role: 'img', 'aria-label': `${pct}% of facts used in answers` },
    s('circle', { cx: 40, cy: 40, r, class: 'track' }),
    s('circle', { cx: 40, cy: 40, r, class: 'value', 'stroke-dasharray': `${(pct / 100) * c} ${c}`, transform: 'rotate(-90 40 40)' }),
    s('text', { x: 40, y: 45, 'text-anchor': 'middle', class: 'donut-text' }, `${pct}%`));
}
function recallCard(d, memories) {
  const facts = memories.length ? memories : d.facts;
  const used = facts.filter((m) => (m.uses ?? 0) > 0).length;
  const pct = facts.length ? Math.round((used / facts.length) * 100) : 0;
  const r = d.lastRecall;
  const sets = recallSets(r);
  const step = (ic, n, label, cls) => h('div', { class: `fn-step ${cls}` }, h('span', { class: 'fn-tile' }, icon(ic)), h('strong', { text: n }), h('span', { text: label }));
  return h('section', { class: 'at-card at-recall' },
    h('header', { class: 'at-head' }, icon('ring', 'ai sm'), h('span', { text: 'Recall' })),
    h('div', { class: 'rc-top' }, donut(pct), h('p', {}, h('strong', { text: `${used} of ${facts.length}` }), h('span', { text: ' facts have answered a question' }))),
    r ? h('div', { class: 'rc-last', title: r.question },
      h('p', { class: 'rc-q', text: `“${clip(r.question, 60)}”` }),
      h('div', { class: 'funnel' }, step('search', sets.candidates.size, 'found', 'c'), h('i', { text: '→' }), step('sparkle', sets.kept.size, 'kept', 'k'), h('i', { text: '→' }), step('check', sets.cited.size, 'cited', 'z')))
      : h('p', { class: 'muted', text: 'No questions yet.' }));
}

// ---------- 4 · coming up ----------
const TODAY = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function comingUpCard(d) {
  const today = TODAY();
  const nameOf = (pid) => { const p = d.people.find((x) => x.id === pid); return p ? (p.isOwner ? 'You' : p.name) : null; };
  const active = d.facts.filter((f) => f.status === 'active');
  const dated = active.filter((f) => /^\d{4}-\d{2}-\d{2}/.test(f.whenResolved ?? '') && f.whenResolved.slice(0, 10) >= today)
    .sort((a, b) => a.whenResolved.localeCompare(b.whenResolved));
  const promises = active.filter((f) => !dated.includes(f) && (f.kind === 'promise_by_owner' || (f.kind === 'plan' && (f.people[0] ?? null) && d.people.find((p) => p.id === f.people[0])?.isOwner)));
  const item = (f, dateChip) => {
    const [label, glyph, col] = kindOf(f.kind);
    const g = h('span', { class: 'cu-glyph', text: glyph }); g.style.setProperty('--c', col);
    return h('li', { class: `cu-item${state.selected === f.ref ? ' picked' : ''}`, tabindex: '0', title: f.text,
      onclick: (e) => { e.stopPropagation(); select(f.ref); }, onkeydown: (e) => { if (e.key === 'Enter') select(f.ref); } },
    dateChip, g, h('div', {}, h('p', { text: f.text }), h('small', { text: [label, nameOf(f.people[0])].filter(Boolean).join(' · ') })));
  };
  const chip = (iso) => {
    const dt = new Date(`${iso.slice(0, 10)}T12:00:00`);
    const days = Math.round((dt - new Date(`${today}T12:00:00`)) / 86400000);
    return h('span', { class: `cu-date${days <= 2 ? ' soon' : ''}` }, h('b', { text: dt.getDate() }), h('span', { text: dt.toLocaleDateString(undefined, { month: 'short' }) }),
      h('small', { text: days === 0 ? 'today' : days === 1 ? 'tmrw' : `${days}d` }));
  };
  const todo = () => h('span', { class: 'cu-date todo' }, icon('check', 'ai xs2'));
  return h('section', { class: 'at-card at-coming' },
    h('header', { class: 'at-head' }, icon('calendar', 'ai sm'), h('span', { text: 'Coming up' }), h('span', { class: 'count-pill', text: dated.length + promises.length })),
    dated.length || promises.length
      ? h('ul', { class: 'cu-list' }, dated.slice(0, 6).map((f) => item(f, chip(f.whenResolved))), promises.slice(0, 4).map((f) => item(f, todo())))
      : h('p', { class: 'muted', text: 'Nothing scheduled yet.' }));
}

// ---------- 5 · translations ----------
const LANG = { zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', id: 'Indonesian', ja: 'Japanese', ko: 'Korean', it: 'Italian', pt: 'Portuguese', en: 'English' };
function translationsCard(d) {
  const groups = d.sessions.map((x) => ({ s: x, lines: x.utterances.filter((u) => u.translation && u.translation.trim() && u.translation.trim() !== u.text.trim()) }))
    .filter((g) => g.lines.length).sort((a, b) => String(b.s.startedAt).localeCompare(String(a.s.startedAt)));
  const total = groups.reduce((n, g) => n + g.lines.length, 0);
  const langs = [...new Set(groups.flatMap((g) => g.lines.map((u) => u.language).filter(Boolean)))];
  return h('section', { class: 'at-card at-translations' },
    h('header', { class: 'at-head' }, icon('globe', 'ai sm'), h('span', { text: 'Translations' }),
      h('span', { class: 'lang-row' }, langs.map((l) => h('span', { class: 'lang', text: l.toUpperCase(), title: LANG[l] ?? l })))),
    total ? h('div', { class: 'tl-list' }, groups.slice(0, 8).map((g) => h('div', { class: 'tl-group' },
      h('div', { class: 'tl-place' }, icon('pin', 'ai xs3'), h('span', { text: g.s.place ?? 'Conversation' }), h('small', { text: fmtDate(g.s.startedAt) })),
      g.lines.slice(0, 4).map((u) => h('div', { class: `tl-line${u.who === 'Me' || u.who === 'You' ? ' mine' : ''}`, title: `${LANG[u.language] ?? u.language ?? ''}` },
        h('span', { class: 'lang', text: (u.language ?? '??').toUpperCase() }),
        h('div', {}, h('p', { class: 'orig', text: u.text }), h('p', { class: 'en', text: u.translation })))))))
      : h('p', { class: 'muted', text: 'Use Translate on Capture; every translated line lands here.' }));
}

// ---------- 5 · trace ----------
function traceCard(d, memories, lit, opts) {
  const head = h('header', { class: 'at-head' }, icon('route', 'ai sm'), h('span', { text: 'Trace' }),
    state.selected ? h('button', { class: 'at-clear', type: 'button', text: 'Clear', onclick: () => select(null) }) : null);
  if (!lit) {
    return h('section', { class: 'at-card at-trace' }, head,
      h('div', { class: 'tr-empty' }, icon('route', 'ai big'), h('p', { text: 'Tap a person or a fact on the map' })));
  }
  const f = d.facts.find((x) => lit.has(x.ref) && (state.selected === x.ref || !/^F/.test(state.selected)));
  const u = utterances(d).find((x) => lit.has(`U:${x.id}`) && (!f || f.evidence.includes(x.id)));
  const e = d.episodes.find((x) => lit.has(x.ref) && (!f || f.episode === x.ref));
  const pid = state.selected.startsWith('P:') ? state.selected.slice(2) : f?.people[0];
  const p = d.people.find((x) => x.id === pid);
  const mem = f ? memories.find((m) => m.ref === f.ref) : null;
  const audio = mem?.source?.quote?.audioUrl;
  const row = (ic, label, text, sub, extra) => h('li', { class: 'tr-row' }, h('span', { class: 'tr-tile' }, icon(ic)),
    h('div', {}, h('span', { class: 'tr-label', text: label }), h('p', { text }), sub ? h('small', { text: sub }) : null, extra ?? null));
  const steps = [
    u && row('mic', 'Heard', `“${u.text}”`, `${u.who} · ${u.place} · ${fmtDate(u.at)}`,
      audio ? h('button', { class: 'play', type: 'button', onclick: () => opts.play?.({ url: audio, start: mem.source.quote.start, end: mem.source.quote.end }) }, icon('play', 'ai xs'), 'Play') : null),
    e && row('layers', 'Episode', clip(e.summary, 140), e.ref),
    f && row('database', 'Fact', f.text, `${kindOf(f.kind)[0]}${f.whenResolved ? ` · ${fmtDate(f.whenResolved)}` : ''}${f.uses ? ` · used ${f.uses}×` : ''}`),
    p && row('users', 'In mind', clip(p.core ?? 'No card yet', 140), p.isOwner ? 'You' : p.name),
  ].filter(Boolean);
  return h('section', { class: 'at-card at-trace' }, head, h('ol', { class: 'tr-list' }, steps));
}

// ---------- render ----------
function select(ref) { state.selected = state.selected === ref ? null : ref; draw(); }

function draw() {
  const { root, data, opts } = ctx;
  const d = data.layers;
  if (!d) {
    root.replaceChildren(h('div', { class: 'at-offline' }, icon('database', 'ai big'),
      h('p', { text: data.offline ? 'Memory is not running.' : 'Restart the memory server to load the map (it needs the /layers route).' })));
    return;
  }
  const lit = state.selected ? lineage(d, state.selected) : null;
  root.replaceChildren(
    pipeline(d.totals),
    h('div', { class: 'at-main' },
      h('section', { class: 'at-card at-people' },
        h('header', { class: 'at-head' }, icon('users', 'ai sm'), h('span', { text: 'Memory over time' }),
          h('span', { class: 'legend' }, h('i', { class: 'lg-dot' }), 'heard', h('i', { class: 'lg-goal' }), 'happens', h('i', { class: 'lg-voice' }), 'voice known')),
        h('div', { class: 'at-graph' }, timeline(d, lit, state.size))),
      h('div', { class: 'at-side' }, traceCard(d, data.memories, lit, opts), recallCard(d, data.memories)),
      h('div', { class: 'at-side two' }, comingUpCard(d), translationsCard(d))));
  // size the map to its card, then redraw once if the shape changed
  const box = root.querySelector('.at-graph');
  if (box) {
    const w = Math.round(box.clientWidth), hgt = Math.round(box.clientHeight);
    if (w > 0 && hgt > 0 && (!state.size || Math.abs(state.size.w - w) > 4 || Math.abs(state.size.h - hgt) > 4)) {
      state.size = { w, h: hgt };
      box.replaceChildren(timeline(d, lit, state.size));
    }
  }
}

export function renderAtlas(root, data, opts = {}) {
  if (!root) return;
  ctx = { root, data, opts };
  if (state.selected && data.layers && !lineage(data.layers, state.selected).size) state.selected = null;
  if (!root.dataset.bound) {
    root.dataset.bound = '1';
    root.addEventListener('click', (e) => { if (state.selected && !e.target.closest('.at-trace')) select(null); });
    let t; new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => { if (ctx?.data?.layers) { state.size = null; draw(); } }, 120); }).observe(root);
  }
  draw();
}
