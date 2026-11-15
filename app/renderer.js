// Pebble's main window: the stone that records, the conversation, and the memory workspace.
import { recordButtonState, enrollButtonState, dockSummary, formatClipTime, languageName } from './view.mjs';
import { markSVG, mountMark } from './mark.mjs';

const api = window.kindred;
const $ = (s) => document.querySelector(s);
const app = $('#app');
const thread = $('#thread');
const empty = $('#empty');

mountMark($('#brand-mark'), 22);
mountMark($('#mic-mark'), 26);
mountMark($('#stone-mark'), 124);

let snap = null;
let mode = 'record';           // 'record' | 'ask' | 'translate' — what the stone does when tapped
let ownerVoiceKnown = false;
let pendingTurn = null;
let lastAnswer = '';

// memory workspace
let people = [];
let relations = [];
let memories = [];
let inputs = [];
let traces = [];
let selectedPerson = null;
let selectedMemory = null;
let layer = 'facts';
let search = '';

// live transcript
const liveRows = new Map();    // seq (or reply index) → row
let liveSession = null;
let liveState = 'idle';

// ---------- navigation ----------
function show(view) {
  app.dataset.view = view;
  for (const nav of document.querySelectorAll('.nav')) {
    const on = nav.dataset.view === view;
    if (on) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
  }
  for (const v of ['capture', 'chat', 'memory']) $(`#view-${v}`).hidden = v !== view;
  if (view === 'memory') loadMemory();
  if (view === 'chat') $('#ask-input').focus();
  if (view === 'capture' && mode === 'ask') $('#quick-input').focus();
}
for (const nav of document.querySelectorAll('.nav')) nav.addEventListener('click', () => show(nav.dataset.view));
api.onNavigate((view) => show(typeof view === 'string' ? view : 'capture'));

// ---------- the stone: what it does when you tap it ----------
function setMode(next) {
  mode = next;
  app.dataset.mode = mode;
  for (const b of document.querySelectorAll('.mode')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  $('#ask-panel').hidden = mode !== 'ask';
  if (mode === 'ask') $('#quick-input').focus();
  renderMode();
}
for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => setMode(b.dataset.mode));

function capturing(rec = {}) { return rec.phase === 'starting' || rec.phase === 'recording'; }

function clock(rec) {
  if (!rec.startedAt) return '';
  const s = Math.max(0, Math.floor((Date.now() - rec.startedAt) / 1000));
  return ` · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderMode() {
  const rec = snap?.recording || {};
  const busy = ['starting', 'recording', 'processing'].includes(rec.phase) && rec.mode !== 'enroll';
  // A recording started anywhere (orb, shortcut) owns the switch while it runs.
  const shown = busy ? (rec.mode === 'translate' ? 'translate' : 'record') : mode;
  const translating = rec.mode === 'translate' && busy;

  const line = $('#mode-line');
  if (shown === 'ask') line.textContent = 'Type a question, or speak it';
  else if (shown === 'translate') line.textContent = translating ? `Translating${clock(rec)}` : rec.phase === 'processing' ? 'Saving…' : 'Tap to translate';
  else line.textContent = capturing(rec) ? `Recording${clock(rec)}` : rec.phase === 'processing' ? 'Saving…' : 'Tap to record';

  const enrolling = rec.mode === 'enroll' && rec.phase !== 'idle';
  $('#record-btn').disabled = rec.phase === 'processing' || enrolling;
  $('#record-btn').setAttribute('aria-pressed', String(capturing(rec)));
  $('#record-btn').classList.toggle('is-speaking', ['starting', 'recording', 'processing'].includes(rec.phase));

  // While the microphone is busy the other modes are unavailable — say why, don't just grey out.
  for (const b of document.querySelectorAll('.mode')) {
    b.setAttribute('aria-selected', String(b.dataset.mode === shown));
    b.disabled = busy || enrolling;
  }
  $('#mode-busy').dataset.mode = shown;
  const busyLine = $('#mode-busy');
  busyLine.hidden = !(busy || enrolling);
  busyLine.textContent = enrolling ? 'Learning your voice — finish that first.'
    : rec.phase === 'processing' ? 'Saving this conversation…'
    : translating ? 'Translating — tap the stone to stop.'
    : 'Recording — tap the stone to stop.';
}

$('#record-btn').addEventListener('click', async () => {
  const phase = snap?.recording?.phase || 'idle';
  if (phase === 'starting' || phase === 'recording') { await api.stopRecording(); return; }
  if (phase === 'processing') return;
  if (mode === 'ask') { $('#quick-input').focus(); return; }
  const r = await api.startRecording(mode === 'translate' ? { mode: 'translate' } : {});
  if (!r.ok) result(r.error);
});

// ---------- status ----------
function render(next) {
  if (!next) return;
  if (next.error && !next.memory) return;
  if (!next.memory) return;
  snap = next;
  const { memory, capture, recording } = next;

  $('#status').dataset.ok = String(!!memory.ok);
  $('#status-text').textContent = memory.ok ? 'Local' : 'Memory offline';

  app.dataset.phase = recording.phase;
  document.title = capturing(recording) ? '● Recording — Pebble' : 'Pebble';
  renderMode();
  renderEnroll(recording, capture);
  renderLive(recording);

  if (next.whisper && capturing(recording)) {
    $('#whisper').hidden = false;
    $('#whisper').textContent = next.whisper.text;
  } else if (!capturing(recording)) {
    $('#whisper').hidden = true;
  }
}
api.onStatus(render);
api.status().then(render);
api.onWhisper((w) => { $('#whisper').hidden = false; $('#whisper').textContent = w.text; });
$('#status').addEventListener('click', () => api.checkMemory());
setInterval(() => { if (snap && capturing(snap.recording)) renderMode(); }, 1000);

function result(text) { $('#record-result').hidden = !text; $('#record-result').textContent = text; }

// ---------- live transcript (Translate) ----------
function renderLive(rec) {
  const translating = rec.mode === 'translate';
  if (!translating && liveRows.size === 0) { $('#live-panel').hidden = true; return; }

  // A new session starts clean; the last session stays visible after Stop.
  if (rec.session && rec.session !== liveSession) {
    liveSession = rec.session;
    liveRows.clear();
    liveState = 'idle';
  }
  if (translating) {
    for (const t of rec.translations || []) {
      if (t.seq == null) continue;
      liveRows.set(`t${t.seq}`, { kind: 'heard', language: t.language, text: t.text, translation: t.translation });
    }
    for (const [i, r] of (rec.replies || []).entries()) {
      liveRows.set(`r${i}`, { kind: 'reply', english: r.english, translated: r.translated, language: r.language });
    }
    liveState = rec.phase === 'processing' ? 'saving'
      : rec.reply?.phase === 'listening' ? 'listening'
      : rec.reply?.phase === 'speaking' ? 'speaking'
      : rec.phase === 'recording' ? 'translating' : 'starting';
  } else if (rec.phase === 'idle') {
    liveState = 'stopped';
  }

  const panel = $('#live-panel');
  panel.hidden = false;
  const stateEl = $('#live-state');
  stateEl.textContent = { translating: 'Translating', listening: 'Listening to you', speaking: 'Speaking your reply', saving: 'Saving', starting: 'Starting', stopped: 'Saved', idle: 'Ready' }[liveState] || 'Live';
  $('#live-meta').textContent = rec.session ? `${liveRows.size} ${liveRows.size === 1 ? 'line' : 'lines'}` : '';

  const list = $('#live-list');
  const rows = [...liveRows.values()].slice(-40);
  if (!rows.length) {
    list.replaceChildren(Object.assign(document.createElement('p'), { className: 't-empty', textContent: 'Nothing translated yet. Speak, and each line appears here.' }));
    return;
  }
  list.replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    li.className = 'trow';
    if (r.kind === 'reply') {
      const you = document.createElement('span'); you.className = 't-you'; you.textContent = 'You replied';
      const orig = document.createElement('span'); orig.className = 't-orig'; orig.textContent = `“${r.english || ''}”`;
      const said = document.createElement('span'); said.className = 't-eng'; said.textContent = r.translated || '';
      li.append(you, orig, said);
    } else {
      const orig = document.createElement('span'); orig.className = 't-orig';
      orig.textContent = `${languageName(r.language)}: “${r.text || ''}”`;
      const eng = document.createElement('span'); eng.className = 't-eng'; eng.textContent = r.translation || r.text || '';
      li.append(orig, eng);
    }
    return li;
  }));
  list.scrollTop = list.scrollHeight;
}

// ---------- your voice ----------
function renderEnroll(recording, capture) {
  const st = enrollButtonState(recording, capture, ownerVoiceKnown);
  $('#enroll-btn').textContent = st.label === 'Teach Kindred my voice' ? 'My voice' : st.label;
  $('#enroll-btn').disabled = st.disabled;
}
$('#enroll-btn').addEventListener('click', async () => {
  const r = snap?.recording;
  if (r?.mode === 'enroll' && (r.phase === 'starting' || r.phase === 'recording')) { await api.stopRecording(); return; }
  const res = await api.enrollOwner();
  if (!res.ok) dockStatus(res.error);
});
api.onEnrollDone((r) => {
  if (!r.ok) { if (!r.cancelled) dockStatus(r.error); return; }
  ownerVoiceKnown = true;
  dockStatus(`Your voice is saved (${r.samples} ${r.samples === 1 ? 'sample' : 'samples'}).`);
  if (snap) renderEnroll(snap.recording, snap.capture);
  loadMemory();
});

// ---------- dock ----------
function dockStatus(text) { $('#dock-status').hidden = !text; $('#dock-status').textContent = text; }
$('#dock-btn').addEventListener('click', async () => {
  const btn = $('#dock-btn');
  btn.disabled = true; btn.textContent = 'Docking…';
  dockStatus('Reading today’s conversations.');
  try {
    const r = await api.dock();
    if (!r.ok) { dockStatus(r.error); return; }
    dockStatus(dockSummary(r.value.report));
    await loadMemory();
  } finally { btn.disabled = false; btn.textContent = 'Dock today'; }
});

api.onRecordingDone((r) => {
  if (!r.ok) { if (!r.cancelled) result(r.error); return; }
  const saved = `Saved ${r.utterances} ${r.utterances === 1 ? 'line' : 'lines'} from ${r.speakers} ${r.speakers === 1 ? 'voice' : 'voices'}.`;
  result(r.ingested ? `${saved} Memory has it.` : `${saved} Not in memory yet: ${r.ingestError}`);
});

// ---------- memory workspace ----------
async function loadMemory() {
  const [p, m, i, t] = await Promise.all([api.people(), api.memories(), api.inputs(), api.traces()]);
  if (p.ok) { people = p.value.people || []; relations = p.value.relations || []; }
  if (m.ok) memories = m.value.memories || [];
  if (i.ok) inputs = i.value.inputs || [];
  if (t.ok) traces = t.value.traces || [];
  ownerVoiceKnown = people.some((x) => x.owner && x.voiceSamples > 0);
  if (snap) renderEnroll(snap.recording, snap.capture);

  const failed = [p, m, i, t].find((r) => !r.ok);
  $('#mem-summary').textContent = failed
    ? (failed.error || 'Memory is not running.')
    : `${memories.length} facts · ${inputs.length} inputs · ${people.length} people · ${traces.length} recalls`;

  if (!selectedMemory && memories.length) selectedMemory = memories[0];
  fillFilters();
  renderPeople();
  renderLayers();
  renderRecall();
  renderDetail();
}

const relationOf = (p) => (p.relation && p.relation !== 'device owner' ? p.relation : null)
  || (relations.find((r) => (r.a === p.id || r.b === p.id))?.label) || null;

function fillFilters() {
  const ps = $('#layer-person');
  const keep = ps.value;
  ps.replaceChildren(new Option('All people', ''));
  for (const p of people) ps.append(new Option(p.name, p.id));
  ps.value = people.some((p) => p.id === keep) ? keep : (selectedPerson || '');

  const kinds = [...new Set(memories.map((m) => m.kind).filter(Boolean))].sort();
  const ks = $('#layer-kind');
  const keepKind = ks.value;
  ks.replaceChildren(new Option('All types', ''));
  for (const k of kinds) ks.append(new Option(k, k));
  ks.value = kinds.includes(keepKind) ? keepKind : '';
}

function renderPeople() {
  const list = $('#people-list');
  const rel = (p) => ((p.owner ?? !!p.is_owner) ? 'You' : relationOf(p) || 'Relation unknown');
  list.replaceChildren(...people.map((p) => {
    const li = document.createElement('li');
    const isOwner = p.owner ?? !!p.is_owner;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'prow';
    b.setAttribute('aria-pressed', String(selectedPerson === p.id));
    b.setAttribute('aria-label', `${p.name}, ${isOwner ? 'you' : rel(p)}, ${p.facts} facts${p.voiceSamples ? ', voice known' : ''}`);

    const name = document.createElement('span'); name.className = 'pname'; name.textContent = p.name;
    if (p.core) {
      const core = document.createElement('span'); core.className = 'pcore';
      core.textContent = p.core;
      name.append(core);
    }
    const relEl = document.createElement('span'); relEl.className = 'prel'; relEl.textContent = rel(p);
    const facts = document.createElement('span'); facts.className = 'pfacts'; facts.textContent = String(p.facts ?? 0);
    const dot = document.createElement('span'); dot.className = 'voice-dot';
    dot.dataset.known = String(!!p.voiceSamples);
    dot.title = p.voiceSamples ? 'Voice known' : 'Voice not known yet';

    b.append(name, relEl, facts, dot);
    b.addEventListener('click', () => {
      selectedPerson = selectedPerson === p.id ? null : p.id;
      $('#layer-person').value = selectedPerson || '';
      renderPeople(); renderLayers();
    });
    li.append(b);
    list.append(li);
    return li;
  }));
  $('#people-count').textContent = `${people.length}`;
}

function currentRows() {
  const q = search.trim().toLowerCase();
  const pid = $('#layer-person').value;
  const kind = $('#layer-kind').value;
  const has = (s) => !q || String(s || '').toLowerCase().includes(q);

  if (layer === 'inputs') {
    return inputs.filter((x) => has(x.text)).map((x) => ({
      key: x.id, ref: x.id, text: x.text, kind: null, who: '—', memory: null, personId: null,
    }));
  }
  if (layer === 'core') {
    return people.filter((p) => p.core && (!pid || p.id === pid) && has(p.core)).map((p) => ({
      key: p.id, ref: p.id, text: p.core, kind: null, who: p.name, memory: null, personId: p.id,
    }));
  }
  // facts and evidence come from /memories
  return memories
    .filter((m) => (!pid || m.person?.id === pid) && (!kind || m.kind === kind))
    .filter((m) => (layer === 'evidence' ? has(m.source?.quote?.text) : has(m.text)))
    .map((m) => ({
      key: m.ref,
      ref: m.ref,
      text: layer === 'evidence' ? `“${m.source?.quote?.text || ''}”` : m.text,
      kind: m.kind || 'fact',
      who: m.person?.name || '—',
      memory: m,
      personId: m.person?.id || null,
    }));
}

const KIND_CLASS = { health: 'health', task: 'task', place: 'place', home: 'home' };
const kindClass = (k) => KIND_CLASS[String(k || '').toLowerCase()] || 'other';

function renderLayers() {
  for (const tab of document.querySelectorAll('.ltab')) tab.setAttribute('aria-selected', String(tab.dataset.layer === layer));
  const rows = currentRows();
  $('#layer-count').textContent = `${rows.length}`;
  const list = $('#layer-list');
  if (!rows.length) {
    list.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'hint', textContent: search ? 'Nothing matches that search.' : 'Nothing in this layer yet.',
    }));
    return;
  }
  list.replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lrow';
    b.setAttribute('aria-pressed', String(!!selectedMemory && r.memory?.ref === selectedMemory.ref));

    const ref = document.createElement('span'); ref.className = 'lref'; ref.textContent = r.ref || '—';
    const text = document.createElement('span'); text.className = 'ltext';
    if (r.kind) {
      const tag = document.createElement('span');
      tag.className = `tag ${kindClass(r.kind)}`;
      tag.textContent = r.kind;
      text.append(tag, document.createTextNode(` ${r.text}`));
    } else {
      text.textContent = r.text;
    }
    const who = document.createElement('span'); who.className = 'lperson'; who.textContent = r.who || '—';

    b.append(ref, text, who);
    b.addEventListener('click', () => {
      if (r.memory) selectMemory(r.memory);
      else if (r.personId) { selectedPerson = r.personId; $('#layer-person').value = r.personId; renderPeople(); renderLayers(); }
    });
    li.append(b);
    list.append(li);
    return li;
  }));
}

function selectMemory(m) {
  selectedMemory = m;
  renderLayers();
  renderDetail();
}

function renderDetail() {
  const box = $('#memory-detail');
  box.replaceChildren();
  const m = selectedMemory;
  if (!m) {
    $('#detail-ref').textContent = '';
    const p = people.find((x) => x.id === selectedPerson);
    if (p) {
      // A selected person, no memory yet: show their card rather than an empty panel.
      const h = document.createElement('h3'); h.textContent = p.name;
      const chips = document.createElement('div'); chips.className = 'chips';
      for (const label of [(p.owner ?? !!p.is_owner) ? 'You' : relationOf(p) || 'Relation unknown',
        `${p.facts} ${p.facts === 1 ? 'fact' : 'facts'}`, p.voiceSamples ? 'voice known' : 'no voice sample']) {
        const c = document.createElement('span'); c.className = 'tag other'; c.textContent = label; chips.append(c);
      }
      const core = document.createElement('p'); core.className = 'q';
      core.textContent = p.core || 'No core memory card yet. Dock a conversation to build one.';
      box.append(h, chips, core);
      box.append(Object.assign(document.createElement('p'), {
        className: 'hint', textContent: 'Pick a memory from the layers to see its source and evidence.',
      }));
      return;
    }
    box.append(Object.assign(document.createElement('p'), {
      className: 'hint', textContent: 'Pick a memory from the layers to see its source, date and evidence.',
    }));
    return;
  }
  $('#detail-ref').textContent = m.ref || '';

  const h = document.createElement('h3'); h.textContent = m.text;
  const chips = document.createElement('div'); chips.className = 'chips';
  const chip = (label, cls) => {
    if (!label) return;
    const c = document.createElement('span'); c.className = `tag ${cls}`; c.textContent = label; chips.append(c);
  };
  chip(m.person?.name || 'Unsorted', 'other');
  chip(m.kind, kindClass(m.kind));
  chip(m.origin === 'declared' ? 'declared' : 'extracted', 'other');

  const dl = document.createElement('dl'); dl.className = 'kv';
  const add = (k, v) => {
    if (!v) return;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  };
  add('Saved', dateOnly(m.createdAt));
  add('Scope', m.scope);
  add('Used', m.uses ? `${m.uses} ${m.uses === 1 ? 'time' : 'times'}` : 'never');
  add('Evidence', m.source?.session ? `session ${m.source.session}` : 'none');

  box.append(h, chips, dl);

  if (m.source?.quote?.text) {
    const q = document.createElement('p'); q.className = 'q';
    q.textContent = `“${m.source.quote.text}”`;
    box.append(q);
  } else {
    const q = document.createElement('p'); q.className = 'hint';
    q.textContent = 'No spoken quote was saved for this fact.';
    box.append(q);
  }

  if (m.source?.quote?.audioUrl) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'play'; b.textContent = 'Play the moment';
    b.addEventListener('click', () => {
      const started = Number(m.source.quote.start);
      const ended = Number(m.source.quote.end);
      play({ url: m.source.quote.audioUrl, start: Number.isFinite(started) ? started : null, end: Number.isFinite(ended) ? ended : null });
    });
    box.append(b);
  }
}

function renderRecall() {
  const list = $('#recall-list');
  $('#recall-count').textContent = `${traces.length}`;
  if (!traces.length) {
    list.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'No questions asked yet.' }));
    return;
  }
  list.replaceChildren(...traces.map((t) => {
    const li = document.createElement('li'); li.className = 'rrow';

    const grounded = !!t.grounded;
    const q = document.createElement('p'); q.className = 'rq'; q.textContent = t.question;
    const a = document.createElement('p'); a.className = 'ra'; a.textContent = t.answer || '';

    const meta = document.createElement('div'); meta.className = 'rmeta';
    const state = document.createElement('span');
    state.className = `state ${grounded ? 'ok' : 'none'}`;
    state.textContent = grounded ? 'verified' : 'no source';
    meta.append(state);

    const n = grounded ? sourceCount(t) : 0;
    if (n) meta.append(Object.assign(document.createElement('span'), {
      className: 'rsrc', textContent: `${n} ${n === 1 ? 'source' : 'sources'}`,
    }));
    const when = dateOnly(t.created_at);
    if (when) meta.append(Object.assign(document.createElement('span'), { className: 'rsrc', textContent: when }));

    li.append(q, a, meta);
    return li;
  }));
}

/** How many distinct citations the retrieval steps produced (0 when it answered ungrounded). */
function sourceCount(trace) {
  const cited = new Set();
  const loaded = new Set();
  for (const step of trace.trace || []) {
    for (const c of step.cite || []) cited.add(c);
    for (const l of step.loaded || []) loaded.add(l);
  }
  return (cited.size ? cited : loaded).size;
}

const dateOnly = (iso) => (iso ? String(iso).slice(0, 10) : '');

for (const tab of document.querySelectorAll('.ltab')) {
  tab.addEventListener('click', () => { layer = tab.dataset.layer; renderLayers(); });
}
$('#layer-search').addEventListener('input', (e) => { search = e.target.value; renderLayers(); });
$('#layer-person').addEventListener('change', (e) => { selectedPerson = e.target.value || null; renderPeople(); renderLayers(); });
$('#layer-kind').addEventListener('change', () => renderLayers());

// ---------- conversation ----------
function addTurn(kind, text) {
  empty.hidden = true;
  const turn = document.createElement('div');
  turn.className = `turn ${kind}`;
  if (kind === 'pebble') {
    const dot = document.createElement('span');
    dot.className = 'dot'; dot.innerHTML = markSVG(21);
    const body = document.createElement('div');
    body.className = 'body';
    const p = document.createElement('p');
    p.className = 'answer';
    p.textContent = text;
    body.append(p);
    turn.append(dot, body);
  } else {
    const p = document.createElement('p');
    p.textContent = text;
    turn.append(p);
  }
  thread.append(turn);
  thread.scrollTop = thread.scrollHeight;
  return turn;
}

const player = $('#player');
let stopAt = null;
player.addEventListener('timeupdate', () => { if (stopAt !== null && player.currentTime >= stopAt) { player.pause(); stopAt = null; } });
function play(clip) {
  player.src = clip.url;
  stopAt = Number.isFinite(clip.end) ? clip.end : null;
  if (Number.isFinite(clip.start)) player.currentTime = clip.start;
  player.play().catch(() => {});
}

function detailsFor(answer) {
  const wrap = document.createElement('div');
  wrap.className = 'details';
  wrap.hidden = true;
  for (const s of answer.sources || []) {
    const p = document.createElement('p'); p.className = 'src';
    const label = document.createElement('strong');
    label.textContent = s.layer === 'input' ? 'You said' : s.layer === 'photo' ? 'Photo' : 'Memory';
    p.append(label, document.createTextNode(s.text || ''));
    wrap.append(p);
  }
  for (const photo of answer.photos || []) {
    if (!photo.url) continue;
    const p = document.createElement('p'); p.className = 'src';
    p.append(Object.assign(document.createElement('strong'), { textContent: 'Photo' }));
    const img = document.createElement('img'); img.src = photo.url; img.alt = photo.caption || 'Saved photo'; img.loading = 'lazy';
    p.append(img); wrap.append(p);
  }
  for (const c of answer.clips || []) {
    const row = document.createElement('div'); row.className = 'clip';
    const said = document.createElement('p'); said.className = 'said';
    said.append(document.createTextNode(`“${c.text}”`));
    const when = document.createElement('em'); when.textContent = `${c.speaker || 'Someone'} · ${formatClipTime(c)}`;
    said.append(when);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'play';
    b.textContent = c.url ? 'Play' : 'No audio'; b.disabled = !c.url;
    b.addEventListener('click', () => play(c));
    row.append(said, b); wrap.append(row);
  }
  return wrap;
}

function paintAnswer(turn, answer) {
  const body = turn.querySelector('.body');
  body.querySelector('.answer').textContent = answer.answer || 'I could not find an answer.';
  turn.classList.remove('pending');
  lastAnswer = answer.answer || '';
  const n = (answer.sources || []).length;
  const clips = (answer.clips || []).length;
  if (!n && !clips) return;
  const meta = document.createElement('div'); meta.className = 'meta';
  const chip = document.createElement('button');
  chip.type = 'button'; chip.className = 'chip'; chip.setAttribute('aria-expanded', 'false');
  chip.textContent = `${n || clips} ${(n || clips) === 1 ? 'source' : 'sources'}`;
  const details = detailsFor(answer);
  chip.addEventListener('click', () => {
    const open = chip.getAttribute('aria-expanded') === 'true';
    chip.setAttribute('aria-expanded', String(!open));
    details.hidden = open;
  });
  meta.append(chip);
  body.append(meta, details);
}

function ask(question) {
  const q = String(question || '').trim();
  if (!q) return;
  show('chat');
  addTurn('user', q);
  const turn = addTurn('pebble', '…');
  turn.classList.add('pending');
  pendingTurn = turn;
  api.ask(q).then((r) => {
    if (!r.ok) { turn.querySelector('.answer').textContent = r.error; turn.classList.remove('pending'); pendingTurn = null; }
  });
  thread.scrollTop = thread.scrollHeight;
}

api.onAskAnswer((answer) => {
  if (pendingTurn) { paintAnswer(pendingTurn, answer); pendingTurn = null; return; }
  addTurn('user', answer.question);
  paintAnswer(addTurn('pebble', ''), answer);
});

$('#ask-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#ask-input');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  ask(q);
});
$('#quick-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#quick-input');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  ask(q);
});
for (const s of document.querySelectorAll('.suggest')) s.addEventListener('click', () => ask(s.textContent));

$('#mic-btn').addEventListener('click', async () => {
  const asking = snap?.ask?.phase && snap.ask.phase !== 'idle';
  if (asking) { await api.stopAskListening(); return; }
  const r = await api.startAskListening();
  if (!r.ok) result(r.error);
});
api.onAskState((state) => {
  const listening = state?.phase === 'starting' || state?.phase === 'listening';
  $('#mic-btn').dataset.listening = String(!!listening);
  if (state?.error) result(state.error);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { api.stopSpeaking(); player.pause(); }
});

setMode('record');
