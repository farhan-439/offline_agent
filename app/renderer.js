// Pebble's main window: the conversation, the people it remembers, and the stone that records.
import { recordButtonState, enrollButtonState, dockSummary, formatClipTime } from './view.mjs';
import { markSVG, mountMark } from './mark.mjs';

const api = window.kindred;
const $ = (s) => document.querySelector(s);
const app = $('#app');
const thread = $('#thread');
const empty = $('#empty');

mountMark(document.querySelector('#brand-mark'), 22);
mountMark(document.querySelector('#mic-mark'), 26);
mountMark(document.querySelector('#stone-mark'), 124);

let snap = null;
let ownerVoiceKnown = false;
let pendingTurn = null;
let lastAnswer = '';

// ---------- navigation ----------
function show(view) {
  app.dataset.view = view;
  for (const nav of document.querySelectorAll('.nav')) {
    const on = nav.dataset.view === view;
    if (on) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
  }
  for (const v of ['chat', 'people', 'capture']) $(`#view-${v}`).hidden = v !== view;
  if (view === 'people') loadPeople();
  if (view === 'chat') $('#ask-input').focus();
}
for (const nav of document.querySelectorAll('.nav')) nav.addEventListener('click', () => show(nav.dataset.view));
api.onNavigate((view) => show(typeof view === 'string' ? view : 'chat'));

// ---------- the stone ----------
function render(next) {
  if (!next) return;
  if (next.error && !next.memory) return;
  if (!next.memory) return;
  snap = next;
  const { memory, capture, recording } = next;

  $('#status').dataset.ok = String(!!memory.ok);
  $('#status-text').textContent = memory.ok ? 'Local' : 'Memory offline';

  const enrolling = recording.mode === 'enroll' && recording.phase !== 'idle';
  const btn = enrolling
    ? { hint: 'Recording your voice on the People screen…', disabled: true, pressed: false }
    : recordButtonState(recording.phase, capture);
  app.dataset.phase = recording.phase;
  // The mark waves while the stone is recording or finishing a recording.
  $('#record-btn').classList.toggle('is-speaking', ['starting', 'recording', 'processing'].includes(recording.phase));
  $('#record-hint').textContent = btn.hint;
  $('#record-btn').disabled = btn.disabled;
  $('#record-btn').setAttribute('aria-pressed', String(btn.pressed));
  document.title = recording.phase === 'recording' || recording.phase === 'starting' ? '● Recording — Pebble' : 'Pebble';

  if (next.whisper && (recording.phase === 'recording' || recording.phase === 'starting')) {
    $('#whisper').hidden = false;
    $('#whisper').textContent = next.whisper.text;
  } else if (recording.phase !== 'recording' && recording.phase !== 'starting') {
    $('#whisper').hidden = true;
  }
  renderEnroll(recording, capture);
}
api.onStatus(render);
api.status().then(render);
api.onWhisper((w) => { $('#whisper').hidden = false; $('#whisper').textContent = w.text; });
$('#status').addEventListener('click', () => api.checkMemory());

$('#record-btn').addEventListener('click', async () => {
  const phase = snap?.recording.phase;
  if (phase === 'idle') {
    const r = await api.startRecording({});
    if (!r.ok) result(r.error);
  } else if (phase === 'starting' || phase === 'recording') {
    await api.stopRecording();
  }
});
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
  loadPeople();
});

// ---------- people ----------
function dockStatus(text) { $('#dock-status').hidden = !text; $('#dock-status').textContent = text; }

function renderPeople(roster) {
  const people = roster?.people || [];
  ownerVoiceKnown = people.some((p) => p.owner && p.voiceSamples > 0);
  if (snap) renderEnroll(snap.recording, snap.capture);
  $('#people').replaceChildren(...people.map((p) => {
    const li = document.createElement('li'); li.className = 'person';
    const h = document.createElement('h3'); h.textContent = p.owner ? p.name : p.name;
    const rel = document.createElement('p'); rel.className = 'relation';
    rel.textContent = p.owner ? 'You' : (p.relation || 'Someone you met');
    const core = document.createElement('p'); core.className = 'core';
    core.textContent = p.core || 'Nothing remembered yet.';
    const stats = document.createElement('p'); stats.className = 'stats';
    stats.textContent = `${p.facts} ${p.facts === 1 ? 'fact' : 'facts'}${p.voiceSamples ? ' · voice known' : ''}`;
    li.append(h, rel, core, stats);
    return li;
  }));
  $('#people-empty').hidden = people.length > 0;
}
async function loadPeople() {
  const r = await api.people();
  if (r.ok) renderPeople(r.value); else if (r.code !== 'MEMORY_DOWN') dockStatus(r.error);
}
$('#dock-btn').addEventListener('click', async () => {
  const btn = $('#dock-btn');
  btn.disabled = true; btn.textContent = 'Docking…';
  dockStatus('Reading today’s conversations.');
  try {
    const r = await api.dock();
    if (!r.ok) { dockStatus(r.error); return; }
    dockStatus(dockSummary(r.value.report));
    renderPeople(r.value);
  } finally { btn.disabled = false; btn.textContent = 'Dock today'; }
});

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
  stopAt = clip.end;
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
  body.parentElement.classList.remove('pending');
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
for (const s of document.querySelectorAll('.suggest')) {
  s.addEventListener('click', () => { show('chat'); ask(s.textContent); });
}
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
