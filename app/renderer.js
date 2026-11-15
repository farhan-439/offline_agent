// Pebble's main window: the stone that records, the conversation, and the memory layers.
import { recordButtonState, enrollButtonState, dockSummary, formatClipTime } from './view.mjs';
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
let memories = [];
let people = [];

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

function capturing(rec = {}) {
  return rec.phase === 'starting' || rec.phase === 'recording';
}

function renderMode() {
  const rec = snap?.recording || {};
  const busy = ['starting', 'recording', 'processing'].includes(rec.phase) && rec.mode !== 'enroll';
  const translating = rec.mode === 'translate' && busy;
  const t = rec.startedAt ? ` · ${Math.floor((Date.now() - rec.startedAt) / 60000)}:${String(Math.floor((Date.now() - rec.startedAt) / 1000) % 60).padStart(2, '0')}` : '';

  const line = $('#mode-line');
  if (mode === 'ask') line.textContent = 'Type a question, or speak it';
  else if (mode === 'translate') line.textContent = translating ? `Translating${t}` : rec.phase === 'processing' ? 'Saving…' : 'Tap to translate';
  else line.textContent = capturing(rec) ? `Recording${t}` : rec.phase === 'processing' ? 'Saving…' : 'Tap to record';

  const enrolling = rec.mode === 'enroll' && rec.phase !== 'idle';
  $('#record-btn').disabled = rec.phase === 'processing' || enrolling;
  $('#record-btn').setAttribute('aria-pressed', String(capturing(rec)));
  $('#record-btn').classList.toggle('is-speaking', ['starting', 'recording', 'processing'].includes(rec.phase));
  for (const b of document.querySelectorAll('.mode')) b.disabled = busy;
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

  const enrolling = recording.mode === 'enroll' && recording.phase !== 'idle';
  app.dataset.phase = recording.phase;
  document.title = capturing(recording) ? '● Recording — Pebble' : 'Pebble';
  renderMode();
  renderEnroll(recording, capture);

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
api.onRecordingDone((r) => {
  if (!r.ok) { if (!r.cancelled) result(r.error); return; }
  const saved = `Saved ${r.utterances} ${r.utterances === 1 ? 'line' : 'lines'} from ${r.speakers} ${r.speakers === 1 ? 'voice' : 'voices'}.`;
  result(r.ingested ? `${saved} Memory has it.` : `${saved} Not in memory yet: ${r.ingestError}`);
});

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

// ---------- people + dock ----------
function dockStatus(text) { $('#dock-status').hidden = !text; $('#dock-status').textContent = text; }

function renderPeople(list) {
  people = list || [];
  ownerVoiceKnown = people.some((p) => p.owner && p.voiceSamples > 0);
  if (snap) renderEnroll(snap.recording, snap.capture);
  const peopleList = $('#people');
  if (!peopleList) return;   // the board is the memory view now; the list is optional
  peopleList.replaceChildren(...people.map((p) => {
    const li = document.createElement('li'); li.className = 'person';
    const h = document.createElement('h3'); h.textContent = p.name;
    const rel = document.createElement('p'); rel.className = 'relation';
    rel.textContent = p.owner ? 'You' : (p.relation || 'Someone you met');
    const core = document.createElement('p'); core.className = 'core';
    core.textContent = p.core || 'Nothing remembered yet.';
    const stats = document.createElement('p'); stats.className = 'stats';
    stats.textContent = `${p.facts} ${p.facts === 1 ? 'fact' : 'facts'}${p.voiceSamples ? ' · voice known' : ''}`;
    li.append(h, rel, core, stats);
    return li;
  }));
}
$('#dock-btn').addEventListener('click', async () => {
  const btn = $('#dock-btn');
  btn.disabled = true; btn.textContent = 'Docking…';
  dockStatus('Reading today’s conversations.');
  try {
    const r = await api.dock();
    if (!r.ok) { dockStatus(r.error); return; }
    dockStatus(dockSummary(r.value.report));
    renderPeople(r.value.people || []);
    await loadMemory();
  } finally { btn.disabled = false; btn.textContent = 'Dock today'; }
});

// ---------- memory: the layers ----------
async function loadMemory() {
  const [m, p] = await Promise.all([api.memories(), api.people()]);
  if (p.ok) renderPeople(p.value.people || []);
  if (!m.ok) { $('#mem-summary').textContent = m.error || 'Memory is not running.'; return; }
  memories = m.value.memories || [];
  $('#mem-summary').textContent = memories.length
    ? `${memories.length} ${memories.length === 1 ? 'fact' : 'facts'} · ${people.length} ${people.length === 1 ? 'person' : 'people'} · 4 layers`
    : 'Nothing stored yet.';
  drawStrata();
}

function drawStrata() {
  const box = $('#strata');
  box.replaceChildren();
  $('#strata-empty').hidden = memories.length > 0;
  if (!memories.length) return;

  // One column per person: the cluster is the connection.
  const groups = new Map();
  for (const m of memories) {
    const key = m.person?.id ?? '_none';
    if (!groups.has(key)) groups.set(key, { name: m.person?.name ?? 'Unsorted', core: null, facts: [] });
    groups.get(key).facts.push(m);
  }
  for (const p of people) if (groups.has(p.id) && p.core) groups.get(p.id).core = p.core;

  const cols = [...groups.values()].sort((a, b) => b.facts.length - a.facts.length || a.name.localeCompare(b.name));
  const board = document.createElement('div');
  board.className = 'board';

  const card = (tag, text, extra = '') => {
    const b = document.createElement('div');
    b.className = `mcard ${extra}`.trim();
    const t = document.createElement('span'); t.className = 'tag'; t.textContent = tag;
    const f = document.createElement('span'); f.className = 'fact'; f.textContent = text;
    b.append(t, f);
    return b;
  };

  for (const g of cols) {
    const col = document.createElement('section');
    col.className = 'mcol';

    const head = document.createElement('header');
    const who = document.createElement('span'); who.className = 'who'; who.textContent = g.name;
    const n = document.createElement('span'); n.className = 'n';
    n.textContent = `${g.facts.length} ${g.facts.length === 1 ? 'fact' : 'facts'}`;
    head.append(who, n);
    col.append(head);

    // L3 — the core card, when this person has one.
    if (g.core) col.append(card('L3 · CORE', g.core, 'core'));

    for (const m of g.facts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mcard';
      const tag = document.createElement('span'); tag.className = 'tag';
      tag.textContent = `L1 · ${(m.kind || 'fact').toUpperCase()}`;
      const fact = document.createElement('span'); fact.className = 'fact'; fact.textContent = m.text;
      b.append(tag, fact);
      // L0 — the words it was heard in.
      if (m.source?.quote?.text) {
        const q = document.createElement('span'); q.className = 'quote';
        q.textContent = `L0 · “${m.source.quote.text}”`;
        b.append(q);
      }
      b.addEventListener('click', () => selectMemory(m));
      col.append(b);
    }
    board.append(col);
  }
  box.append(board);
}

function selectMemory(m) {
  const box = $('#memory-detail');
  box.replaceChildren();
  box.hidden = false;
  const h = document.createElement('h3'); h.textContent = m.text;
  const quote = document.createElement('p'); quote.className = 'quote';
  quote.textContent = m.source?.quote?.text ? `“${m.source.quote.text}”` : 'No spoken source saved.';
  const meta = document.createElement('div'); meta.className = 'meta';
  meta.textContent = [
    m.person?.name ?? 'Unsorted',
    m.kind || 'fact',
    m.uses ? `${m.uses} ${m.uses === 1 ? 'use' : 'uses'}` : 'not used yet',
    (m.createdAt || '').slice(0, 10),
  ].join(' · ');
  box.append(h, quote, meta);
}

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
function play(clip) { player.src = clip.url; stopAt = clip.end; player.play().catch(() => {}); }

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
