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
let mode = 'record';           // 'record' | 'translate' — what the stone does when tapped
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
  for (const v of ['capture', 'chat', 'memory', 'atlas']) $(`#view-${v}`).hidden = v !== view;
  if (view === 'memory') loadMemory();
  if (view === 'atlas') loadAtlas();
  if (view === 'chat') $('#ask-input').focus();
}
for (const nav of document.querySelectorAll('.nav')) nav.addEventListener('click', () => show(nav.dataset.view));
api.onNavigate((view) => show(typeof view === 'string' ? view : 'capture'));

// ---------- the stone: what it does when you tap it ----------
function setMode(next) {
  mode = next;
  app.dataset.mode = mode;
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
  // A recording started anywhere (orb, shortcut) owns the switch while it runs.
  const shown = busy ? (rec.mode === 'translate' ? 'translate' : 'record') : mode;
  const translating = rec.mode === 'translate' && busy;

  const line = $('#mode-line');
  if (shown === 'translate') line.textContent = translating ? `Translating${clock(rec)}` : rec.phase === 'processing' ? 'Saving…' : 'Tap to translate';
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
  drawMap();
}

const relationOf = (p) => (p.relation && p.relation !== 'device owner' ? p.relation : null)
  || (relations.find((r) => (r.a === p.id || r.b === p.id))?.label) || null;

function fillFilters() {
  const ps = $('#layer-person');
  const keep = ps.value;
  ps.replaceChildren(new Option('All people', ''));
  for (const p of people) ps.append(new Option(p.name, p.id));
  ps.append(new Option('Miscellaneous', '__misc__'));
  ps.value = keep === '__misc__' || people.some((p) => p.id === keep) ? keep : (selectedPerson || '');

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
    .filter((m) => (!pid || (pid === '__misc__' ? !m.person : m.person?.id === pid)) && (!kind || m.kind === kind))
    .filter((m) => (layer === 'evidence' ? has(m.source?.quote?.text) : has(m.text)))
    .map((m) => ({
      key: m.ref,
      ref: m.ref,
      text: layer === 'evidence' ? `“${m.source?.quote?.text || ''}”` : m.text,
      kind: m.kind || 'fact',
      who: m.person?.name || 'Miscellaneous',
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
  mapMode = 'fact';
  renderLayers();
  drawMap();
}

let mapMode = 'fact';
let traceIndex = 0;

function clearMap() {
  const host = $('#map-canvas');
  host.replaceChildren();
  $('#map-foot').replaceChildren();
  return host;
}

function mapEmpty(host, text) {
  const p = document.createElement('p');
  p.className = 'map-empty';
  p.textContent = text;
  host.append(p);
}

/** Absolute-positioned label inside the canvas; percentages so it scales with the panel. */
function mapNode(host, cls, x, y, text) {
  const el = document.createElement('div');
  el.className = `mnode ${cls}`;
  el.style.left = `${x}%`;
  el.style.top = `${y}%`;
  if (text != null) el.textContent = text;
  host.append(el);
  return el;
}

/** The SVG line layer: 0–100 in both axes, stretched, strokes kept 1px. */
function mapLines(host) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'map-lines');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  host.append(svg);
  return (x1, y1, x2, y2, soft = false) => {
    const path = document.createElementNS(NS, 'path');
    const bend = Math.min(14, Math.max(4, Math.abs(y2 - y1) / 3));
    path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`);
    if (soft) path.setAttribute('class', 'soft');
    svg.append(path);
  };
}

function footSpacer() {
  const s = document.createElement('span');
  s.className = 'grow';
  return s;
}

function drawMap() {
  for (const tab of document.querySelectorAll('.mtab')) tab.setAttribute('aria-selected', String(tab.dataset.map === mapMode));
  const host = clearMap();
  if (mapMode === 'recalls') return drawRecallMap(host);
  return drawFactMap(host);
}

/** One fact, the person it belongs to, that person's other facts, and where it was heard. */
function drawFactMap(host) {
  const m = selectedMemory;
  const foot = $('#map-foot');
  if (!m) { mapEmpty(host, 'Pick a memory from the layers to see what it connects to.'); return; }

  const line = mapLines(host);
  const person = m.person?.name || 'Unsorted';
  const siblings = memories.filter((x) => x.ref !== m.ref && (x.person?.id ?? null) === (m.person?.id ?? null)).slice(0, 3);

  const P = [50, 12], F = [50, 42], S = [50, 88];
  const sibY = 67;
  const sibX = siblings.length === 1 ? [50] : siblings.length === 2 ? [26, 74] : [17, 50, 83];

  for (const [y, label] of [[12, 'who'], [42, 'what it knows'], [88, 'where it was heard']]) {
    const band = document.createElement('span');
    band.className = 'map-band';
    band.style.top = `${y}%`;
    band.textContent = label;
    host.append(band);
  }
  mapNode(host, 'person', P[0], P[1], person);
  siblings.forEach((s, i) => {
    line(P[0], P[1], sibX[i], sibY, true);
    mapNode(host, 'sib', sibX[i], sibY, s.text);
  });
  line(P[0], P[1], F[0], F[1]);
  mapNode(host, 'fact', F[0], F[1], m.text);
  line(F[0], F[1], S[0], S[1]);
  mapNode(host, 'session', S[0], S[1], m.source?.session ? `session ${m.source.session}` : 'no saved session');

  const meta = document.createElement('span');
  meta.textContent = [m.ref, dateOnly(m.createdAt), m.scope, m.uses ? `${m.uses} uses` : 'never used'].filter(Boolean).join(' · ');
  foot.append(meta);
  if (m.source?.quote?.text) {
    const q = document.createElement('span');
    q.className = 'quote';
    q.textContent = `“${m.source.quote.text}”`;
    foot.append(q);
  } else foot.append(footSpacer());
  if (m.source?.quote?.audioUrl) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'act'; b.textContent = 'Play';
    b.title = 'Play the moment this was heard';
    b.addEventListener('click', () => play({
      url: m.source.quote.audioUrl,
      start: Number(m.source.quote.start),
      end: Number(m.source.quote.end),
    }));
    foot.append(b);
  }
}

/** One recall: the question, what Bonsai loaded, what it cited, and the answer. */
function drawRecallMap(host) {
  const foot = $('#map-foot');
  if (!traces.length) { mapEmpty(host, 'No questions asked yet. Ask something in Chat.'); return; }
  traceIndex = Math.min(Math.max(traceIndex, 0), traces.length - 1);
  const t = traces[traceIndex];

  const cited = new Set();
  const loaded = new Set();
  for (const step of t.trace || []) {
    for (const c of step.cite || []) cited.add(c);
    for (const l of step.loaded || []) loaded.add(l);
  }
  const refs = [...cited, ...[...loaded].filter((r) => !cited.has(r))].slice(0, 5);

  const line = mapLines(host);
  const Q = [50, 12], A = [50, 88];
  const refY = 50;
  const spread = refs.length === 1 ? [50] : refs.map((_, i) => 14 + (72 * i) / (refs.length - 1));

  mapNode(host, 'question', Q[0], Q[1], t.question);
  refs.forEach((r, i) => {
    line(Q[0], Q[1], spread[i], refY);
    const n = mapNode(host, cited.has(r) ? 'ref cited' : 'ref', spread[i], refY, r);
    n.title = cited.has(r) ? 'Cited in the answer' : 'Retrieved, not cited';
  });
  if (!refs.length) {
    const none = mapNode(host, 'ref', 50, refY, 'nothing retrieved');
    none.title = 'No retrieval steps were recorded';
  }
  refs.forEach((r, i) => line(spread[i], refY, A[0], A[1]));
  if (!refs.length) line(Q[0], Q[1], A[0], A[1], true);
  mapNode(host, 'answer', A[0], A[1], t.answer || 'No answer saved.');

  const state = document.createElement('span');
  state.className = `state ${t.grounded ? 'ok' : 'none'}`;
  state.textContent = t.grounded ? 'verified' : 'no source';
  const when = document.createElement('span');
  when.textContent = `${traceIndex + 1} / ${traces.length}${t.created_at ? ` · ${dateOnly(t.created_at)}` : ''}`;
  foot.append(state, when, footSpacer());

  const prev = document.createElement('button');
  prev.type = 'button'; prev.className = 'step'; prev.textContent = '‹'; prev.setAttribute('aria-label', 'Previous recall');
  prev.disabled = traceIndex === 0;
  prev.addEventListener('click', () => { traceIndex -= 1; drawMap(); });
  const next = document.createElement('button');
  next.type = 'button'; next.className = 'step'; next.textContent = '›'; next.setAttribute('aria-label', 'Next recall');
  next.disabled = traceIndex >= traces.length - 1;
  next.addEventListener('click', () => { traceIndex += 1; drawMap(); });
  foot.append(prev, next);
}

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
for (const tab of document.querySelectorAll('.mtab')) {
  tab.addEventListener('click', () => { mapMode = tab.dataset.map; drawMap(); });
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
for (const s of document.querySelectorAll('.suggest')) s.addEventListener('click', () => ask(s.textContent));

$('#mic-btn').addEventListener('click', async () => {
  show('chat');
  const asking = snap?.ask?.phase && snap.ask.phase !== 'idle';
  if (asking) { await api.stopAskListening(); return; }
  const r = await api.startAskListening();
  if (!r.ok) addTurn('pebble', r.error);
});
api.onAskState((state) => {
  const listening = state?.phase === 'starting' || state?.phase === 'listening';
  $('#mic-btn').dataset.listening = String(!!listening);
  if (state?.error) addTurn('pebble', state.error);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { api.stopSpeaking(); player.pause(); }
});


// ---------- atlas: the whole memory as a map ----------
// Only stored relationships are drawn: fact → person, fact → session, person ↔ person.
// Raw inputs are deliberately NOT wired to anything — they are memories with no recorded session.
const ATLAS_CAP = 6;      // facts a person shows before the rest fold into a count
const ATLAS_BUDGET = 40;  // facts drawn at once, so a large memory still reads at a glance
const atlasExpanded = new Set();

async function loadAtlas() {
  const [p, m, i] = await Promise.all([api.people(), api.memories(), api.inputs()]);
  if (p.ok) people = p.value.people || [];
  if (m.ok) memories = m.value.memories || [];
  if (i.ok) inputs = i.value.inputs || [];
  drawAtlas();
}

let atlasTip = null;
function showTip(text, evt) {
  const canvas = $('#atlas-canvas');
  if (!canvas || !text) return;
  if (!atlasTip) {
    atlasTip = document.createElement('div');
    atlasTip.className = 'atlas-tip';
    canvas.append(atlasTip);
  }
  atlasTip.textContent = text;
  atlasTip.hidden = false;
  const box = canvas.getBoundingClientRect();
  const x = Math.min(evt.clientX - box.left + 12, box.width - 250);
  const y = Math.min(evt.clientY - box.top + 14, box.height - 56);
  atlasTip.style.left = `${Math.max(4, x)}px`;
  atlasTip.style.top = `${Math.max(4, y)}px`;
}
function hideTip() { if (atlasTip) atlasTip.hidden = true; }

function drawAtlas() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = $('#atlas-svg');
  svg.replaceChildren();
  $('#raw-count').textContent = String(inputs.length);

  const el = (tag, attrs = {}, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };

  const sessionCount = new Set(memories.map((m) => m.source?.session).filter(Boolean)).size;
  $('#atlas-summary').textContent = `${people.length} people · ${memories.length} facts · ${sessionCount} sessions · ${inputs.length} raw inputs`;

  if (!memories.length && !people.length) {
    svg.append(el('text', { x: 500, y: 360, class: 'a-empty' }, 'Nothing mapped yet. Record something, then dock.'));
    return;
  }

  const W = 1000, H = 720, CX = 500, CY = 350;

  // People are hubs; a fact with no person lands in an "Unsorted" hub.
  const byPerson = new Map();
  for (const m of memories) {
    const id = m.person?.id || '_none';
    if (!byPerson.has(id)) byPerson.set(id, { id, name: m.person?.name || 'Unsorted', facts: [] });
    byPerson.get(id).facts.push(m);
  }
  for (const person of people) {
    if (!byPerson.has(person.id)) byPerson.set(person.id, { id: person.id, name: person.name, facts: [] });
  }
  const hubs = [...byPerson.values()].map((h) => ({
    ...h,
    person: people.find((p) => p.id === h.id) || null,
    facts: [...h.facts].sort((a, b) => String(a.ref).localeCompare(String(b.ref))),
  })).sort((a, b) => b.facts.length - a.facts.length || a.name.localeCompare(b.name));

  const n = Math.max(hubs.length, 1);
  // People sit on a ring that widens with the crowd, so names stay apart.
  const R = n === 1 ? 0 : Math.min(215, 118 + n * 7);
  hubs.forEach((h, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    h.ang = a;
    h.x = CX + Math.cos(a) * R;
    h.y = CY + Math.sin(a) * R;
  });

  // What the map draws: people you opened, small groups, then a fixed budget of facts.
  // A fact that is not drawn is never given a stray line or an orphan session.
  let budget = ATLAS_BUDGET;
  for (const h of hubs) {
    h.open = atlasExpanded.has(h.id) || h.facts.length <= ATLAS_CAP;
    if (h.open) budget -= h.facts.length;
  }
  for (const h of hubs) {
    if (h.open || h.facts.length > budget) continue;
    h.open = true;
    budget -= h.facts.length;
  }

  const factNodes = [];
  for (const h of hubs) {
    if (!h.open) continue;
    h.facts.forEach((f, i) => {
      const a = h.ang + (i - (h.facts.length - 1) / 2) * 0.30;
      factNodes.push({ f, hub: h, x: h.x + Math.cos(a) * 84, y: h.y + Math.sin(a) * 84 });
    });
  }

  // A large memory is drawn in part; say so rather than imply the map is complete.
  if (factNodes.length < memories.length) {
    $('#atlas-summary').textContent += ` · showing ${factNodes.length} facts`;
  }

  // Sessions sit on an outer ring, at the average direction of their facts.
  const sessionMap = new Map();
  for (const node of factNodes) {
    const id = node.f.source?.session;
    if (!id) continue;
    if (!sessionMap.has(id)) sessionMap.set(id, { id, facts: [] });
    sessionMap.get(id).facts.push(node);
  }
  const SESSION_R = 322;
  const sessionNodes = [...sessionMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const s of sessionNodes) {
    const mx = s.facts.reduce((t, f) => t + f.x, 0) / s.facts.length;
    const my = s.facts.reduce((t, f) => t + f.y, 0) / s.facts.length;
    s.dir = Math.atan2(my - CY, mx - CX);
    s.label = s.id.length > 16 ? `${s.id.slice(0, 15)}…` : s.id;
    s.w = Math.max(54, s.label.length * 6.4 + 16);
  }

  // Session pills keep their stored direction unless that would stack them:
  // nudge each one past the previous, and spread evenly once the ring is full.
  const ring = [...sessionNodes].sort((a, b) => a.dir - b.dir);
  const sep = (s) => Math.min(0.60, (s.w + 18) / SESSION_R);
  const need = ring.reduce((t, s) => t + sep(s), 0);
  if (need >= Math.PI * 2 * 0.94) {
    const step = (Math.PI * 2) / Math.max(ring.length, 1);
    ring.forEach((s, i) => { s.dir = -Math.PI / 2 + i * step; });
  } else {
    for (let i = 1; i < ring.length; i++) {
      const min = ring[i - 1].dir + sep(ring[i - 1]);
      if (ring[i].dir < min) ring[i].dir = min;
    }
    const wrap = ring.length ? ring[ring.length - 1].dir - (ring[0].dir + Math.PI * 2 - sep(ring[ring.length - 1])) : 0;
    if (wrap > 0) for (const s of ring) s.dir -= wrap;
  }
  for (const s of sessionNodes) {
    s.x = CX + Math.cos(s.dir) * SESSION_R;
    s.y = CY + Math.sin(s.dir) * SESSION_R;
  }

  const edges = [];

  // fact → session (drawn first so it sits behind the nodes)
  for (const s of sessionNodes) {
    for (const f of s.facts) {
      const ctrl = [(f.x + s.x) / 2, (f.y + s.y) / 2];
      const path = el('path', { class: 'a-edge', d: `M ${f.x} ${f.y} Q ${ctrl[0]} ${ctrl[1]} ${s.x} ${s.y}` });
      svg.append(path);
      edges.push({ path, a: f.f.ref, b: `s:${s.id}` });
    }
  }

  // person ↔ person
  for (const rel of relations) {
    const A = hubs.find((h) => h.id === rel.a), B = hubs.find((h) => h.id === rel.b);
    if (!A || !B) continue;
    const path = el('path', { class: 'a-edge rel', d: `M ${A.x} ${A.y} L ${B.x} ${B.y}` });
    svg.append(path);
    edges.push({ path, a: `p:${A.id}`, b: `p:${B.id}` });
  }

  // person → fact, only for facts that are actually drawn
  const shownFacts = factNodes;
  for (const node of shownFacts) {
    const path = el('path', { class: 'a-edge', d: `M ${node.hub.x} ${node.hub.y} L ${node.x} ${node.y}` });
    svg.append(path);
    edges.push({ path, a: `p:${node.hub.id}`, b: node.f.ref });
  }

  // A busy map keeps its lines faint until something is hovered.
  svg.dataset.busy = String(edges.length > 80);

  const hot = (key) => {
    for (const e of edges) {
      if (e.a === key || e.b === key) e.path.classList.add('hot');
      else e.path.classList.remove('hot');
    }
  };
  const cold = () => { for (const e of edges) e.path.classList.remove('hot'); };

  const bind = (g, key, onClick, title) => {
    g.addEventListener('mouseenter', (e) => { hot(key); showTip(title, e); });
    g.addEventListener('mousemove', (e) => showTip(title, e));
    g.addEventListener('mouseleave', () => { cold(); hideTip(); });
    g.addEventListener('click', onClick);
    if (title) {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', title);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } });
    }
    svg.append(g);
    return g;
  };

  // people
  for (const h of hubs) {
    const g = el('g', { class: `a-node a-person${h.id === '_none' ? ' unsorted' : ''}` });
    g.append(el('circle', { cx: h.x, cy: h.y, r: 22 }));
    g.append(el('text', { x: h.x, y: h.y + 38 }, h.name));
    const collapsed = !h.open;
    bind(g, `p:${h.id}`, () => {
      if (collapsed) { atlasExpanded.add(h.id); drawAtlas(); }
      else openPersonSheet(h);
    }, collapsed ? `${h.name} — open ${h.facts.length} facts` : `${h.name} — ${h.facts.length} facts`);

    if (collapsed) {
      // The count sits under the name, so it is obvious whose facts are folded away.
      const cx = h.x, cy = h.y + 58;
      const badge = el('g', { class: 'a-node a-count' });
      badge.append(el('rect', { x: cx - 30, y: cy - 11, width: 60, height: 22, rx: 11 }));
      badge.append(el('text', { x: cx, y: cy + 4 }, `${h.facts.length} facts`));
      bind(badge, `p:${h.id}`, () => { atlasExpanded.add(h.id); drawAtlas(); },
        `Open the ${h.facts.length} facts stored for ${h.name}`);
    }
  }

  // facts: hover for the sentence, click for the whole record
  for (const node of shownFacts) {
    const g = el('g', { class: 'a-node a-fact' });
    g.append(el('circle', { cx: node.x, cy: node.y, r: 6.5 }));
    bind(g, node.f.ref, () => openFactSheet(node.f), `${node.f.text} — ${node.hub.name}`);
  }

  // sessions
  for (const s of sessionNodes) {
    const g = el('g', { class: 'a-node a-session' });
    g.append(el('rect', { x: s.x - s.w / 2, y: s.y - 11, width: s.w, height: 22, rx: 6 }));
    g.append(el('text', { x: s.x, y: s.y + 4 }, s.label));
    bind(g, `s:${s.id}`, () => openSessionSheet(s), `Session ${s.id} — ${s.facts.length} facts`);
  }
}

// ---------- atlas sheet ----------
function closeSheet() {
  const sheet = $('#atlas-sheet');
  sheet.hidden = true;
  sheet.replaceChildren();
}

function sheetChip(text, cls = 'other') {
  const s = document.createElement('span');
  s.className = `tag ${cls}`;
  s.textContent = text;
  return s;
}

function sheetText(text, cls) {
  const p = document.createElement('p');
  if (cls) p.className = cls;
  p.textContent = text;
  return p;
}

function factList(facts, onPick) {
  const ul = document.createElement('ul');
  ul.className = 'sheet-list';
  for (const f of facts) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const ref = document.createElement('span');
    ref.className = 'ref';
    ref.textContent = f.ref;
    b.append(ref, document.createTextNode(f.text));
    b.addEventListener('click', () => onPick(f));
    li.append(b);
    ul.append(li);
  }
  return ul;
}

function openSheet(title, meta, body) {
  const sheet = $('#atlas-sheet');
  sheet.replaceChildren();
  const head = document.createElement('div');
  head.className = 'sheet-head';
  const h = document.createElement('h3');
  h.textContent = title;
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'act'; close.textContent = 'Close';
  close.addEventListener('click', closeSheet);
  head.append(h, close);
  sheet.append(head);
  if (meta.length) {
    const m = document.createElement('div');
    m.className = 'sheet-meta';
    m.append(...meta);
    sheet.append(m);
  }
  const bodyEl = document.createElement('div');
  bodyEl.className = 'sheet-body';
  bodyEl.append(...body);
  sheet.append(bodyEl);
  sheet.hidden = false;
  sheet.scrollTop = 0;
}

function openFactSheet(m) {
  const meta = [sheetChip(m.person?.name || 'Unsorted'), sheetChip(m.kind, kindClass(m.kind)), sheetChip(m.origin || 'extracted')];
  if (m.createdAt) meta.push(sheetChip(dateOnly(m.createdAt)));
  if (m.uses) meta.push(sheetChip(`${m.uses} uses`));
  const body = [sheetText(m.text)];
  body.push(m.source?.quote?.text
    ? sheetText(`“${m.source.quote.text}”`, 'q')
    : sheetText('No spoken quote was saved for this fact.'));
  if (m.source?.quote?.audioUrl) {
    const playBtn = document.createElement('button');
    playBtn.type = 'button'; playBtn.className = 'act'; playBtn.textContent = 'Play the moment';
    playBtn.addEventListener('click', () => play({
      url: m.source.quote.audioUrl,
      start: Number(m.source.quote.start),
      end: Number(m.source.quote.end),
    }));
    body.push(playBtn);
  }
  openSheet(`${m.ref} · ${m.text}`, meta, body);
}

function openPersonSheet(h) {
  const p = h.person;
  const meta = [sheetChip(p && (p.owner ?? p.is_owner) ? 'You' : (p?.relation || relationOf(p || { id: h.id, name: h.name })) || 'Relation unknown')];
  meta.push(sheetChip(`${h.facts.length} ${h.facts.length === 1 ? 'fact' : 'facts'}`));
  if (p?.voiceSamples) meta.push(sheetChip('voice known'));
  const body = [];
  body.push(sheetText(p?.core || `${h.name} has no core memory card yet.`));
  if (h.facts.length) body.push(factList(h.facts, openFactSheet));
  openSheet(h.name, meta, body);
}

function openSessionSheet(s) {
  const meta = [sheetChip(`${s.facts.length} ${s.facts.length === 1 ? 'fact' : 'facts'}`), sheetChip('recorded session')];
  const body = [sheetText('These facts were heard in this recording. Every link here comes from the session saved on the fact.')];
  body.push(factList(s.facts.map((f) => f.f), openFactSheet));
  openSheet(`Session ${s.id}`, meta, body);
}

function openInputSheet(x) {
  const meta = [sheetChip(x.id), sheetChip(dateOnly(x.createdAt))];
  openSheet(`Input ${x.id}`, meta, [sheetText(x.text), sheetText('This is a typed input. Memory holds no session for it, so it is not linked to any fact.')]);
}

function openRawSheet() {
  const meta = [sheetChip(`${inputs.length} inputs`), sheetChip('not linked to sessions')];
  const body = [sheetText('Typed inputs are memories in their own right. Nothing in the data says they came from a recorded session, so they are not connected to one here.')];
  if (!inputs.length) body.push(sheetText('No raw inputs stored yet.'));
  else {
    const ul = document.createElement('ul');
    ul.className = 'sheet-list';
    for (const x of inputs.slice(0, 120)) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      const ref = document.createElement('span');
      ref.className = 'ref';
      ref.textContent = x.id;
      b.append(ref, document.createTextNode(x.text.length > 90 ? `${x.text.slice(0, 89)}…` : x.text));
      b.addEventListener('click', () => openInputSheet(x));
      li.append(b);
      ul.append(li);
    }
    body.push(ul);
  }
  openSheet('Raw inputs', meta, body);
}

$('#raw-group').addEventListener('click', openRawSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });


setMode('record');
