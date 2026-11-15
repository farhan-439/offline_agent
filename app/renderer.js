// Pebble's main window: the stone that records, the conversation, and the memory workspace.
import { recordButtonState, enrollButtonState, dockSummary, formatClipTime, languageName } from './view.mjs';
import { markSVG, mountMark } from './mark.mjs';
import { mountActions } from './actions.mjs';
import { isRunPhrase } from './voice-run.mjs';

const api = window.kindred;
const $ = (s) => document.querySelector(s);
const app = $('#app');
const thread = $('#thread');
const empty = $('#empty');
const actions = mountActions(api, { play });

mountMark($('#brand-mark'), 22);
mountMark($('#stone-mark'), 138);

let snap = null;
let mode = 'record';           // 'record' | 'translate' | 'ask' — what the stone does when tapped
let ownerVoiceKnown = false;
let pendingTurn = null;
let lastAnswer = '';

// memory workspace
let people = [];
let relations = [];
let memories = [];
let inputs = [];
let traces = [];
let layers = null;
let selectedMemory = null;
let layer = 'facts';
let search = '';

// live transcript
const liveRows = new Map();    // seq (or reply index) → row
let liveSession = null;
let liveState = 'idle';

// ---------- navigation ----------
function show(view) {
  if (view === 'chat' || view === 'ask') { setMode('ask'); view = 'capture'; }
  if (!['capture', 'memory'].includes(view)) view = 'capture';
  app.dataset.view = view;
  for (const nav of document.querySelectorAll('.nav')) {
    const on = nav.dataset.view === view;
    if (on) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
  }
  for (const v of ['capture', 'memory']) $(`#view-${v}`).hidden = v !== view;
  if (view === 'memory') loadMemory();
  if (view === 'capture' && mode === 'ask') $('#ask-input').focus();
}
for (const nav of document.querySelectorAll('.nav')) nav.addEventListener('click', () => show(nav.dataset.view));
api.onNavigate((view) => show(typeof view === 'string' ? view : 'capture'));

// ---------- the stone: what it does when you tap it ----------
function setMode(next) {
  if (!['record', 'translate', 'ask'].includes(next)) return;
  mode = next;
  app.dataset.mode = mode;
  $('#ask-panel').hidden = mode !== 'ask';
  $('#live-panel').hidden = mode !== 'translate';
  for (const b of document.querySelectorAll('.mode')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
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
  const ask = snap?.ask || {};
  const askPhase = ask.phase || 'idle';
  const askBusy = askPhase !== 'idle';
  // A recording started anywhere (orb, shortcut) owns the switch while it runs.
  const shown = busy ? (rec.mode === 'translate' ? 'translate' : 'record') : mode;
  const translating = rec.mode === 'translate' && busy;

  const line = $('#mode-line');
  if (shown === 'ask') line.textContent = ({ starting: 'Starting microphone…', listening: 'Listening — tap to finish', processing: 'Transcribing your question…', answering: 'Finding your answer…' })[askPhase] || 'Tap to ask by voice';
  else if (shown === 'translate') line.textContent = translating ? `Translating${clock(rec)}` : rec.phase === 'processing' ? 'Saving…' : 'Tap to translate';
  else line.textContent = capturing(rec) ? `Recording${clock(rec)}` : rec.phase === 'processing' ? 'Saving…' : 'Tap to record';

  const enrolling = rec.mode === 'enroll' && rec.phase !== 'idle';
  $('#record-btn').disabled = rec.phase === 'processing' || enrolling || (shown === 'ask' && ['processing', 'answering'].includes(askPhase));
  $('#record-btn').setAttribute('aria-pressed', String(capturing(rec) || (shown === 'ask' && ['starting', 'listening'].includes(askPhase))));
  $('#record-btn').setAttribute('aria-label', shown === 'ask' ? (['starting', 'listening'].includes(askPhase) ? 'Stop listening' : 'Ask by voice') : capturing(rec) ? 'Stop recording' : shown === 'translate' ? 'Start translating' : 'Start recording');
  $('#record-btn').classList.toggle('is-speaking', ['starting', 'recording', 'processing'].includes(rec.phase) || (shown === 'ask' && askBusy));

  // While the microphone is busy the other modes are unavailable — say why, don't just grey out.
  for (const b of document.querySelectorAll('.mode')) {
    b.setAttribute('aria-selected', String(b.dataset.mode === shown));
    b.disabled = busy || enrolling || askBusy;
  }
  $('#mode-busy').dataset.mode = shown;
  const busyLine = $('#mode-busy');
  busyLine.hidden = !(busy || enrolling || askBusy);
  busyLine.textContent = enrolling ? 'Learning your voice — finish that first.'
    : askBusy ? (['starting', 'listening'].includes(askPhase) ? 'Asking — tap the stone to stop listening.' : 'Working on your question…')
    : rec.phase === 'processing' ? 'Saving this conversation…'
    : translating ? 'Translating — tap the stone to stop.'
    : 'Recording — tap the stone to stop.';
}

$('#record-btn').addEventListener('click', async () => {
  const phase = snap?.recording?.phase || 'idle';
  if (phase === 'starting' || phase === 'recording') { await api.stopRecording(); return; }
  if (phase === 'processing') return;
  if (mode === 'ask') {
    const askPhase = snap?.ask?.phase || 'idle';
    if (['starting', 'listening'].includes(askPhase)) { await api.stopAskListening(); return; }
    if (askPhase !== 'idle') return;
    const r = await api.startAskListening();
    if (!r.ok) addTurn('pebble', r.error);
    return;
  }
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
  renderAskState(next.ask);

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
  renderReplyControls(rec);
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
  panel.hidden = mode !== 'translate';
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

function renderReplyControls(rec) {
  const active = rec.mode === 'translate' && rec.phase === 'recording';
  $('#reply-controls').hidden = !active;
  if (!active) return;
  const phase = rec.reply?.phase || 'idle';
  const target = rec.replyTargetOverride || [...(rec.translations || [])].reverse().map((t) => ['es', 'fr', 'de', 'zh'].includes(t.language?.split('-')[0]) ? t.language.split('-')[0] : null).find(Boolean);
  const selector = $('#reply-language');
  selector.value = rec.replyTargetOverride || 'auto';
  selector.disabled = phase !== 'idle';
  const voice = $('#reply-voice');
  voice.textContent = phase === 'listening' ? 'Done speaking' : `Speak reply${target ? ` in ${languageName(target)}` : ''}`;
  voice.disabled = !['idle', 'listening'].includes(phase);
  $('#reply-text').disabled = phase !== 'idle';
  $('#reply-send').disabled = phase !== 'idle';
  const status = $('#reply-status');
  const line = rec.reply?.error || ({ listening: 'Speak in English, then press Done speaking.', transcribing: 'Writing down your reply…', translating: 'Bonsai is translating…', speaking: 'Argmax is speaking your reply…' }[phase] || (!target ? 'Choose a language, or say “Translate this to Spanish: …”.' : 'Speak or type in English. Pebble says it in the selected language.'));
  status.hidden = !line;
  status.textContent = line;
}

$('#reply-language').addEventListener('change', async (event) => {
  const r = await api.setReplyLanguage(event.target.value);
  if (!r.ok) { $('#reply-status').hidden = false; $('#reply-status').textContent = r.error; }
});
$('#reply-voice').addEventListener('click', async () => {
  const r = snap?.recording?.reply?.phase === 'listening' ? await api.stopReply() : await api.startReply();
  if (!r.ok) { $('#reply-status').hidden = false; $('#reply-status').textContent = r.error; }
});
$('#reply-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#reply-text');
  const text = input.value.trim();
  if (!text) return;
  const r = await api.sendTypedReply(text);
  if (r.ok) input.value = '';
  else { $('#reply-status').hidden = false; $('#reply-status').textContent = r.error; }
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
    void actions.scan();
  } finally { btn.disabled = false; btn.textContent = 'Dock today'; }
});

api.onRecordingDone((r) => {
  if (!r.ok) { if (!r.cancelled) result(r.error); return; }
  const saved = `Saved ${r.utterances} ${r.utterances === 1 ? 'line' : 'lines'} from ${r.speakers} ${r.speakers === 1 ? 'voice' : 'voices'}.`;
  result(r.ingested ? `${saved} Memory has it.` : `${saved} Not in memory yet: ${r.ingestError}`);
  // A finished session is the moment to look for follow-through, so an action from what was
  // just said is already waiting in Memory by the time the owner looks.
  if (r.ingested) setTimeout(() => { void actions.scan(); }, 600);
});

// "Run" said out loud: run what was reviewed, or the newest proposal with only the date and
// time the owner actually spoke. Nothing reaches a Mac app without a validated detail set.
api.onIntent(async (payload) => {
  const text = String(payload?.text || '');
  if (!isRunPhrase(text)) return;
  const r = await actions.runFromVoice(text);
  const status = $('#actions-status');
  if (!status) return;
  if (r.ok) status.textContent = `Ran ${r.added} action${r.added === 1 ? '' : 's'} into your Mac apps.`;
  else if (r.error) status.textContent = r.needsDetail ? `Heard you. ${r.error}` : r.error;
});

// ---------- memory workspace ----------
// A shelf, not a diagram: one tile for every thing Pebble keeps, the few numbers it can
// prove beside it, and the last two weeks along the bottom. Nothing is invented — every
// tile is a stored fact or note, every count is read from an endpoint.

const KIND_CLASS = { health: 'health', task: 'task', place: 'place', home: 'home' };
const kindClass = (k) => KIND_CLASS[String(k || '').toLowerCase()] || 'other';
const dateOnly = (iso) => (iso ? String(iso).slice(0, 10) : '');
const relationOf = (p) => {
  if (!p) return null;
  if (p.owner ?? p.is_owner) return 'you';
  if (p.relation && p.relation !== 'device owner') return p.relation;
  return relations.find((r) => r.a === p.id || r.b === p.id)?.label || null;
};

let memSearch = '';
let memSession = null;            // a recording to narrow the shelf to
let memSessionsOpen = false;      // show every recording, not just the first six
const memKinds = new Set();       // empty = every type
let selectedInput = null;
let selectedTrace = null;
let selectedCore = null;
let memOffline = false;

const sessionCount = (list) => new Set(list.map((m) => m.source?.session).filter(Boolean)).size;

/** How many memories one recall actually pointed at (cited first, then merely loaded). */
function sourceCount(trace) {
  const cited = new Set();
  const loaded = new Set();
  for (const step of trace.trace || []) {
    for (const c of step.cite || []) cited.add(c);
    for (const l of step.loaded || []) loaded.add(l);
  }
  return (cited.size ? cited : loaded).size;
}


async function loadMemory() {
  const [p, m, i, t, l] = await Promise.all([api.people(), api.memories(), api.inputs(), api.traces(), api.layers(), actions.load()]);
  layers = l.ok ? l.value : null;
  if (p.ok) { people = p.value.people || []; relations = p.value.relations || []; }
  if (m.ok) memories = m.value.memories || [];
  if (i.ok) inputs = i.value.inputs || [];
  if (t.ok) traces = t.value.traces || [];
  ownerVoiceKnown = people.some((x) => x.owner && x.voiceSamples > 0);
  if (snap) renderEnroll(snap.recording, snap.capture);

  const failed = [p, m, i, t].find((r) => !r.ok);
  memOffline = Boolean(failed);
  $('#mem-summary').textContent = failed
    ? (failed.error || 'Memory is not running.')
    : `${memories.length} facts · ${sessionCount(memories)} recordings · ${inputs.length} notes · ${people.length} people`;

  if (!selectedMemory && memories.length) selectedMemory = memories[0];
  if (selectedMemory && !memories.some((x) => x.ref === selectedMemory.ref)) selectedMemory = memories[0] || null;
  if (selectedInput && !inputs.some((x) => x.id === selectedInput.id)) selectedInput = null;
  if (selectedTrace && !traces.some((x) => x.id === selectedTrace.id)) selectedTrace = null;
  renderMem();
}

// One photo, saved to memory: Bonsai vision writes observations and the photo becomes
// evidence for later answers. The file never leaves this Mac.
$('#photo-btn')?.addEventListener('click', async () => {
  const btn = $('#photo-btn');
  const status = $('#actions-status');
  btn.disabled = true; btn.textContent = 'Reading photo…';
  try {
    const r = await api.addPhoto();
    if (!r.ok) { if (status) status.textContent = r.error || 'Could not read that photo.'; return; }
    if (r.value?.cancelled) return;
    if (status) status.textContent = r.value?.photo?.caption ? `Saved: ${r.value.photo.caption}` : 'Photo saved to memory.';
    await loadMemory();
    void actions.scan();
  } finally { btn.disabled = false; btn.textContent = 'Add photo'; }
});

$('#say-run')?.addEventListener('click', async () => {
  const status = $('#actions-status');
  if (status) status.textContent = 'Listening for “run”…';
  const r = await api.startIntentListening();
  if (!r.ok && status) status.textContent = r.error || 'Could not open the microphone.';
});

function renderMem() {
  renderField();
  renderLegend();
  renderRecordBar();
  renderRecall();
  renderQuestions();
  renderMachine();
  renderActivity();
}

/* ---------- the shelf ---------- */

function renderLegend() {
  const host = $('#kind-legend');
  host.replaceChildren();

  if (memSession) {
    const heard = document.createElement('button');
    heard.type = 'button';
    heard.className = 'kchip kchip-heard';
    heard.textContent = `heard in ${memSession} ×`;
    heard.title = 'Show everything again';
    heard.addEventListener('click', () => { memSession = null; renderField(); renderLegend(); });
    host.append(heard);
  }

  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'kchip';
  all.textContent = 'All';
  all.setAttribute('aria-pressed', String(memKinds.size === 0));
  all.addEventListener('click', () => { memKinds.clear(); memSession = null; renderField(); renderLegend(); });
  host.append(all);

  for (const k of [...new Set(memories.map((m) => m.kind).filter(Boolean))].sort()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `kchip tag ${kindClass(k)}`;
    b.textContent = k;
    b.setAttribute('aria-pressed', String(memKinds.has(k)));
    b.addEventListener('click', () => {
      if (memKinds.has(k)) memKinds.delete(k); else memKinds.add(k);
      renderField();
      renderLegend();
    });
    host.append(b);
  }

  const notes = document.createElement('span');
  notes.className = 'kchip kchip-note';
  notes.textContent = 'Notes are hollow';
  host.append(notes);
}

const tileLabel = (ref, text) => (ref ? `${ref} · ${text}` : text);

const mostRecent = (items) => {
  const days = items.map((x) => dateOnly(x.createdAt)).filter(Boolean).sort();
  return days.length ? days[days.length - 1] : '';
};

function sessionList() {
  const map = new Map();
  for (const m of memories) {
    const id = m.source?.session;
    if (!id) continue;
    map.set(id, (map.get(id) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function factTile(m) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `tile ${kindClass(m.kind)}`;
  const uses = Number(m.uses) || 0;
  b.style.setProperty('--uses', String(Math.min(1, 0.38 + uses * 0.15)));
  b.dataset.ref = m.ref;
  b.setAttribute('aria-pressed', String(!!selectedMemory && selectedMemory.ref === m.ref));
  b.setAttribute('aria-label', tileLabel(m.ref, m.text));
  b.title = tileLabel(m.ref, m.text);
  b.addEventListener('click', () => {
    selectedMemory = m;
    selectedInput = null;
    selectedTrace = null;
    selectedCore = null;
    markSelected();
    renderRecordBar();
    renderQuestions();
  });
  return b;
}

function coreTile(p) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tile core';
  b.dataset.core = p.id;
  b.setAttribute('aria-pressed', String(!!selectedCore && selectedCore.id === p.id));
  b.setAttribute('aria-label', `${p.name} — ${p.core}`);
  b.title = `${p.name} · ${p.core}`;
  b.textContent = String(p.name || '?').trim().slice(0, 1).toUpperCase();
  b.addEventListener('click', () => {
    selectedCore = p;
    selectedMemory = null;
    selectedInput = null;
    selectedTrace = null;
    markSelected();
    renderRecordBar();
    renderQuestions();
  });
  return b;
}

function noteTile(x) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tile note';
  b.dataset.note = x.id;
  b.setAttribute('aria-pressed', String(!!selectedInput && selectedInput.id === x.id));
  b.setAttribute('aria-label', tileLabel(x.id, x.text));
  b.title = tileLabel(x.id, x.text);
  b.addEventListener('click', () => {
    selectedInput = x;
    selectedMemory = null;
    selectedTrace = null;
    selectedCore = null;
    markSelected();
    renderRecordBar();
    renderQuestions();
  });
  return b;
}

function markSelected() {
  for (const t of document.querySelectorAll('#field-body .tile')) {
    const on = (selectedMemory && t.dataset.ref === selectedMemory.ref)
      || (selectedInput && t.dataset.note === selectedInput.id)
      || (selectedCore && t.dataset.core === selectedCore.id);
    t.setAttribute('aria-pressed', String(Boolean(on)));
  }
}

function fieldRow(name, sub, tiles, cls = '', meta = '') {
  const row = document.createElement('div');
  row.className = `field-row ${cls}`.trim();
  const who = document.createElement('div');
  who.className = 'field-who';
  const n = document.createElement('span'); n.className = 'fname'; n.textContent = name;
  who.append(n);
  if (sub) {
    const s = document.createElement('span'); s.className = 'frel'; s.textContent = sub;
    who.append(s);
  }
  const box = document.createElement('div');
  box.className = 'field-tiles';
  box.append(...tiles);
  const tail = document.createElement('span');
  tail.className = 'fmeta';
  tail.textContent = meta;
  row.append(who, box, tail);
  return row;
}

function sessionPill(id, count) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'spill';
  b.setAttribute('aria-pressed', String(memSession === id));
  b.append(document.createTextNode(id));
  const n = document.createElement('span'); n.className = 'spill-n'; n.textContent = String(count);
  b.append(n);
  b.title = `${count} ${count === 1 ? 'fact' : 'facts'} heard in ${id}`;
  b.addEventListener('click', () => {
    memSession = memSession === id ? null : id;
    renderField();
    renderLegend();
  });
  return b;
}

function renderField() {
  const host = $('#field-body');
  const q = memSearch.trim().toLowerCase();
  const matches = (m) => (!q || `${m.ref || ''} ${m.text} ${m.person?.name || ''}`.toLowerCase().includes(q))
    && (memKinds.size === 0 || memKinds.has(m.kind))
    && (!memSession || m.source?.session === memSession);

  const groups = new Map();
  for (const m of memories) {
    if (!matches(m)) continue;
    const key = m.person?.id || '_none';
    if (!groups.has(key)) {
      // The memory payload carries {id, name}; the person record is what knows "you".
      const full = m.person ? (people.find((p) => p.id === m.person.id) || m.person) : null;
      groups.set(key, { name: m.person?.name || 'Miscellaneous', sub: relationOf(full) || '', items: [] });
    }
    groups.get(key).items.push(m);
  }
  const ordered = [...groups.values()].sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));

  const rows = ordered.map((g) => fieldRow(
    g.name,
    `${g.sub ? `${g.sub} · ` : ''}${g.items.length} ${g.items.length === 1 ? 'fact' : 'facts'}`,
    g.items.map(factTile),
    '',
    mostRecent(g.items),
  ));

  const cores = people.filter((p) => p.core && !q && !memSession);
  if (cores.length) {
    rows.push(fieldRow('Core cards', `${cores.length} ${cores.length === 1 ? 'person' : 'people'}`, cores.map(coreTile), 'core-row'));
  }

  const sessions = sessionList();
  if (sessions.length && !q) {
    const shown = sessions.slice(0, memSessionsOpen ? sessions.length : 6);
    const pills = shown.map(([id, n]) => sessionPill(id, n));
    if (sessions.length > shown.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'spill spill-more';
      more.textContent = `+${sessions.length - shown.length} more`;
      more.addEventListener('click', () => { memSessionsOpen = true; renderField(); });
      pills.push(more);
    }
    rows.push(fieldRow('Recordings', `${sessions.length} saved`, pills, 'sessions-row'));
  }

  const notes = inputs.filter((x) => !q || `${x.id} ${x.text}`.toLowerCase().includes(q));
  if (notes.length) {
    rows.push(fieldRow(
      'Notes',
      `typed · ${notes.length} · no recording`,
      notes.map(noteTile),
      'notes-row',
      mostRecent(notes),
    ));
  }

  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = q || memKinds.size ? 'Nothing matches that.' : 'Nothing stored yet.';
    host.replaceChildren(p);
    return;
  }
  host.replaceChildren(...rows);
}

/* ---------- what is selected ---------- */

function barHead(label, cls) {
  const span = document.createElement('span');
  span.className = cls === 'ok' || cls === 'none' ? `state ${cls}` : `tag ${cls}`;
  span.textContent = label;
  return span;
}

function renderRecordBar() {
  const host = $('#record-bar');
  host.replaceChildren();

  if (selectedTrace) {
    const t = selectedTrace;
    host.append(barHead(t.grounded ? 'verified' : 'no source', t.grounded ? 'ok' : 'none'));
    const wrap = document.createElement('div'); wrap.className = 'rb-body';
    const q = document.createElement('p'); q.className = 'rb-text'; q.textContent = t.question;
    const a = document.createElement('p'); a.className = 'rb-answer'; a.textContent = t.answer || 'No answer saved.';
    const n = sourceCount(t);
    const meta = document.createElement('span'); meta.className = 'rb-meta';
    meta.textContent = `${n} ${n === 1 ? 'source' : 'sources'}${t.created_at ? ` · ${dateOnly(t.created_at)}` : ''}`;
    wrap.append(q, a, meta);
    host.append(wrap);
    return;
  }

  if (selectedCore) {
    const p = selectedCore;
    host.append(barHead('core', 'task'));
    const body = document.createElement('div'); body.className = 'rb-body';
    const text = document.createElement('p'); text.className = 'rb-text'; text.textContent = p.core;
    const meta = document.createElement('span'); meta.className = 'rb-meta';
    meta.textContent = `${p.name} · the one thing to remember`;
    body.append(text, meta);
    host.append(body);
    return;
  }

  if (selectedInput) {
    const x = selectedInput;
    host.append(barHead(x.id, 'other'));
    const body = document.createElement('div'); body.className = 'rb-body';
    const text = document.createElement('p'); text.className = 'rb-text'; text.textContent = x.text;
    const meta = document.createElement('span'); meta.className = 'rb-meta';
    meta.textContent = `typed note${x.createdAt ? ` · ${dateOnly(x.createdAt)}` : ''} · not from a recording`;
    body.append(text, meta);
    host.append(body);
    return;
  }

  const m = selectedMemory;
  if (!m) {
    const p = document.createElement('p'); p.className = 'hint';
    p.textContent = memories.length ? 'Pick a tile to read what was kept.' : 'Nothing stored yet.';
    host.append(p);
    return;
  }

  host.append(barHead(m.ref || 'fact', kindClass(m.kind)));
  const body = document.createElement('div'); body.className = 'rb-body';
  const text = document.createElement('p'); text.className = 'rb-text'; text.textContent = m.text;
  const meta = document.createElement('span'); meta.className = 'rb-meta';
  meta.textContent = [
    m.person?.name || 'Miscellaneous',
    dateOnly(m.createdAt),
    m.source?.session ? `heard in ${m.source.session}` : 'no saved recording',
    m.uses ? `used ${m.uses}×` : 'never used',
  ].filter(Boolean).join(' · ');
  body.append(text, meta);

  if (m.source?.quote?.text) {
    const q = document.createElement('p'); q.className = 'rb-quote';
    q.textContent = `“${m.source.quote.text}”`;
    body.append(q);
  }
  host.append(body);

  if (m.source?.quote?.audioUrl) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'act'; b.textContent = 'Play';
    b.title = 'Play the moment this was heard';
    b.addEventListener('click', () => play({
      url: m.source.quote.audioUrl,
      start: Number(m.source.quote.start),
      end: Number(m.source.quote.end),
    }));
    host.append(b);
  }
}

/* ---------- recall ---------- */

function renderRecall() {
  const total = memories.length;
  const used = memories.filter((m) => Number(m.uses) > 0).length;
  const pct = total ? Math.round((used / total) * 100) : 0;
  const ring = $('#recall-ring');
  ring.style.setProperty('--pct', String(pct));
  ring.setAttribute('aria-label', total
    ? `${used} of ${total} facts have been used when answering`
    : 'Nothing stored yet');
  $('#recall-value').textContent = `${pct}%`;
  $('#recall-note').textContent = `${used}/${total}`;
  $('#recall-line').textContent = total
    ? `${used} of ${total} ${total === 1 ? 'fact has' : 'facts have'} been used when answering.`
    : 'No facts yet.';

  const top = [...memories].filter((m) => Number(m.uses) > 0).sort((a, b) => b.uses - a.uses).slice(0, 3);
  const max = top.length ? Number(top[0].uses) : 1;
  const list = $('#recall-top');
  if (!top.length) {
    const li = document.createElement('li');
    li.className = 'bar-empty';
    li.textContent = 'Nothing has been recalled yet.';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...top.map((m) => {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.className = 'ubar-text'; name.textContent = m.text;
    const n = document.createElement('span'); n.className = 'ubar-n'; n.textContent = `${m.uses}×`;
    const bar = document.createElement('span'); bar.className = 'ubar';
    bar.style.setProperty('--w', `${Math.max(12, Math.round((Number(m.uses) / max) * 100))}%`);
    li.append(name, n, bar);
    li.title = `${m.ref} · used ${m.uses}×`;
    return li;
  }));
}

/* ---------- questions ---------- */

function renderQuestions() {
  const open = traces.filter((t) => !t.grounded);
  $('#question-count').textContent = String(open.length);
  $('#question-count').title = open.length
    ? `${open.length} answered without a source`
    : 'every answer had a source';
  $('#q-cap').textContent = open.length === 0
    ? 'every answer had a source'
    : `${open.length === 1 ? 'answer' : 'answers'} with no source`;
  const list = $('#question-list');
  if (!traces.length) {
    const p = document.createElement('p'); p.className = 'hint';
    p.textContent = 'No questions asked yet.';
    list.replaceChildren(p);
    return;
  }
  list.replaceChildren(...traces.slice(0, 6).map((t) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'qrow';
    b.setAttribute('aria-pressed', String(!!selectedTrace && selectedTrace.id === t.id));
    const q = document.createElement('span'); q.className = 'qtext'; q.textContent = t.question;
    const s = document.createElement('span');
    s.className = `state ${t.grounded ? 'ok' : 'none'}`;
    s.textContent = t.grounded ? 'source' : 'none';
    b.append(q, s);
    b.addEventListener('click', () => {
      selectedTrace = t;
      selectedMemory = null;
      selectedInput = null;
      selectedCore = null;
      markSelected();
      renderRecordBar();
      renderQuestions();
    });
    li.append(b);
    return li;
  }));
}

/* ---------- on this mac ---------- */

function renderMachine() {
  const rows = [
    ['Facts', String(memories.length)],
    ['Recordings', String(sessionCount(memories))],
    ['Notes', String(inputs.length)],
    ['People', String(people.length)],
    ['Questions', String(traces.length)],
    ['Memory server', memOffline ? 'not running' : 'local'],
  ];
  const list = $('#machine-list');
  list.replaceChildren(...rows.map(([k, v]) => {
    const li = document.createElement('li');
    const key = document.createElement('span'); key.textContent = k;
    const val = document.createElement('span'); val.className = 'mv'; val.textContent = v;
    if (k === 'Memory server' && memOffline) val.dataset.ok = 'false';
    li.append(key, val);
    return li;
  }));
}

/* ---------- last two weeks ---------- */

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function dayKeyOf(iso) {
  if (!iso) return '';
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return localDay(d);
}

function renderActivity() {
  const buckets = new Map();
  const bump = (iso, field) => {
    const k = dayKeyOf(iso);
    if (!k) return;
    if (!buckets.has(k)) buckets.set(k, { facts: 0, notes: 0, asks: 0 });
    buckets.get(k)[field] += 1;
  };
  for (const m of memories) bump(m.createdAt, 'facts');
  for (const x of inputs) bump(x.createdAt, 'notes');
  for (const t of traces) bump(t.created_at, 'asks');

  const host = $('#activity');
  const today = new Date();
  const cols = [];
  let recent = 0;
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = localDay(d);
    const b = buckets.get(key) || { facts: 0, notes: 0, asks: 0 };
    recent += b.facts + b.notes + b.asks;
    const col = document.createElement('div');
    col.className = 'day';
    const dots = document.createElement('div');
    dots.className = 'day-dots';
    // At most five dots per day; the rest become one "+n" mark so a busy day
    // cannot push the strip out of its panel.
    const kinds = [
      ...Array.from({ length: b.facts }, () => 'fact'),
      ...Array.from({ length: b.notes }, () => 'note'),
      ...Array.from({ length: b.asks }, () => 'ask'),
    ];
    for (const cls of kinds.slice(0, 5)) {
      const s = document.createElement('span');
      s.className = `dot ${cls}`;
      dots.append(s);
    }
    if (kinds.length > 5) {
      const more = document.createElement('span');
      more.className = 'dot more';
      more.textContent = `+${kinds.length - 5}`;
      dots.append(more);
    }
    if (!kinds.length) {
      const quiet = document.createElement('span');
      quiet.className = 'dot none';
      dots.append(quiet);
    }
    const label = document.createElement('span');
    label.className = 'day-label';
    label.textContent = i === 0 ? 'today' : String(d.getDate());
    col.append(dots, label);
    const parts = [
      b.facts ? `${b.facts} ${b.facts === 1 ? 'fact' : 'facts'}` : '',
      b.notes ? `${b.notes} ${b.notes === 1 ? 'note' : 'notes'}` : '',
      b.asks ? `${b.asks} ${b.asks === 1 ? 'question' : 'questions'}` : '',
    ].filter(Boolean);
    col.title = `${key} · ${parts.length ? parts.join(', ') : 'nothing'}`;
    cols.push(col);
  }
  host.replaceChildren(...cols);
  $('#activity-note').textContent = recent ? 'one dot, one thing kept' : 'nothing in the last two weeks';
}

$('#field-search').addEventListener('input', (e) => { memSearch = e.target.value; renderField(); });

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
  setMode('ask');
  show('capture');
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
  setMode('ask');
  show('capture');
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
for (const s of document.querySelectorAll('.suggest')) s.addEventListener('click', () => ask(s.textContent));

function renderAskState(state = {}) {
  const heard = $('#ask-heard');
  heard.hidden = !state.question || state.phase === 'idle';
  heard.textContent = state.question ? `You asked: ${state.question}` : '';
}
api.onAskState((state) => {
  if (snap) snap.ask = state;
  if (state?.phase === 'starting') { setMode('ask'); show('capture'); }
  renderAskState(state);
  renderMode();
  if (state?.error) addTurn('pebble', state.error);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { api.stopSpeaking(); player.pause(); }
});


setMode('record');
