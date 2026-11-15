// Pebble's two surfaces: the stone (this window) and the conversation (?chat=1).
// One click on the stone starts listening; what you said decides whether Pebble records,
// translates, or answers. The three sub-buttons are always there to overrule it.
import { routeIntent, orbMenuState, elapsed, replyButtonState, conversationLines, languageName } from './view.mjs';
import { markSVG, mountMark } from './mark.mjs';

const api = window.kindred;
const $ = (s) => document.querySelector(s);
const chatMode = new URLSearchParams(window.location.search).has('chat');
document.body.classList.toggle('chat-mode', chatMode);

let snap = null;
let island = 'idle';          // 'idle' | 'choose' | 'live'
let listening = false;
let listenTimer = null;
let pending = null;           // the turn waiting for an answer
let noticeTimer = null;
let sizedFor = '';
let ownCapture = false;       // a recording this stone started (the hub's own recordings stay quiet)
let awaitingIntent = false;   // listening stopped, waiting for the words

const SIZES = { idle: [112, 112], choose: [300, 196], live: [320, 208], 'live-translate': [348, 268] };

// ---------- the stone ----------
function sizeFor(state) {
  if (sizedFor === state) return;
  sizedFor = state;
  const [w, h] = SIZES[state] || SIZES.idle;
  api.resizeOrb(w, h);
}

function setListening(on) {
  listening = on;
  $('#stage').dataset.listening = String(on);
  $('#pebble').setAttribute('aria-label', on ? 'Pebble is listening. Tap to finish.' : 'Pebble. Tap to talk.');
}

function line(text) { $('#island-line').textContent = text; }

let islandNotice = null, islandNoticeTimer = null;
function notify(text, ms = 6000) {
  islandNotice = text;
  clearTimeout(islandNoticeTimer);
  islandNoticeTimer = setTimeout(() => { islandNotice = null; if (!chatMode) renderOrb(); }, ms);
  renderOrb();
}

/** What they said, and what you said back — newest first. */
function renderLines(rec) {
  const list = $('#island-lines');
  list.replaceChildren(...conversationLines(rec, 2).map((t) => {
    const li = document.createElement('li');
    const top = document.createElement('span');
    const bottom = document.createElement('span');
    bottom.className = 'eng';
    if (t.kind === 'reply') {
      top.className = 'you'; top.textContent = `You: “${t.english}”`;
      bottom.textContent = t.translated || '';
    } else {
      top.className = 'orig'; top.textContent = `${languageName(t.language)}: “${t.text}”`;
      bottom.textContent = t.translation || t.text;
    }
    li.append(top, bottom);
    return li;
  }));
}

/** Two-way translation: the reply half. */
function renderReply(rec) {
  const btn = $('#reply-btn');
  const state = replyButtonState(rec);
  btn.hidden = !!state.hidden;
  if (state.hidden) return;
  const phase = rec.reply?.phase || 'idle';
  btn.textContent = phase === 'listening' ? 'Done'
    : phase === 'transcribing' ? 'Writing…'
    : phase === 'translating' ? 'Translating…'
    : phase === 'speaking' ? 'Saying it…'
    : 'Reply';
  btn.disabled = !!state.disabled;
  btn.dataset.listening = String(!!state.listening);
  btn.setAttribute('aria-label', state.label || 'Reply in their language');
}

function renderOrb() {
  if (chatMode) return;
  const menu = orbMenuState(snap || {});
  const rec = snap?.recording || {};
  const active = menu.active === 'conversation' || menu.active === 'translate';
  const saving = rec.phase === 'processing';

  $('#stage').dataset.active = active ? menu.active : '';
  $('#stage').dataset.phase = rec.phase || 'idle';
  // The voice mark moves while it listens, records or translates; it rests otherwise.
  $('#pebble').classList.toggle('is-speaking', !!(listening || active || saving));
  const badge = $('#badge');
  badge.hidden = menu.active !== 'translate';
  badge.textContent = menu.active === 'translate' ? '文A' : '';

  if (active || saving) island = ownCapture ? 'live' : 'idle';
  else if (!listening && island === 'live') island = 'idle';
  if (listening) island = 'choose';

  const translating = menu.active === 'translate';
  $('#island').hidden = island === 'idle';
  $('#subs').hidden = island !== 'choose';
  $('#live-actions').hidden = island !== 'live';
  $('#island-stop').hidden = island !== 'live';
  $('#island-lines').hidden = !(island === 'live' && translating);
  sizeFor(island === 'live' && translating ? 'live-translate' : island);

  // While the stone is listening, the three choices are the point: never grey them out.
  // They only grey out when the microphone is genuinely busy with a recording or translation.
  const busy = menu.active === 'conversation' || menu.active === 'translate' || saving;
  for (const kind of ['record', 'translate', 'ask']) {
    const m = menu[kind];
    $(`.sub[data-kind="${kind}"]`).disabled = busy && m.disabled;
  }

  if (island === 'choose') {
    if (listening) line('Listening…');
  } else if (island === 'live') {
    const t = rec.startedAt ? ` · ${elapsed(Date.now() - rec.startedAt)}` : '';
    line(islandNotice || (saving ? 'Saving…' : translating ? `Translating${t}` : `Recording${t}`));
    $('#island-stop').disabled = saving;
    if (translating && !saving) {
      renderLines(rec);
      renderReply(rec);
    } else {
      $('#reply-btn').hidden = true;
    }
  }
  if (active) $('#pebble').setAttribute('aria-label', 'Pebble is recording. Tap to stop.');
}

function beginListen() {
  if (listening) return;
  clearTimeout(listenTimer);
  setListening(true);
  island = 'choose';
  line('Listening…');
  renderOrb();
  api.startIntentListening().then((r) => {
    if (!r.ok) { setListening(false); island = 'idle'; line(''); renderOrb(); showNotice(r.error); return; }
    // A nudge in case the microphone never reports back.
    listenTimer = setTimeout(() => finishListen(), 9000);
  });
}

async function finishListen() {
  if (!listening) return;
  clearTimeout(listenTimer);
  setListening(false);
  awaitingIntent = true;
  line('One moment…');
  const r = await api.stopIntentListening();
  if (!r.ok) { awaitingIntent = false; island = 'idle'; renderOrb(); showNotice(r.error); }
}

function route(text) {
  awaitingIntent = false;
  const decision = routeIntent(text);
  if (decision.kind === 'record') return startCapture({});
  if (decision.kind === 'translate') return startCapture({ mode: 'translate' });
  if (decision.kind === 'ask') return ask(text.trim());
  // Nothing clear was said: leave the three choices in front of the person.
  island = 'choose';
  line('Which one?');
  renderOrb();
}

async function startCapture(opts) {
  island = 'idle';
  ownCapture = true;
  renderOrb();
  const r = await api.startRecording(opts || {});
  if (!r.ok) { ownCapture = false; showNotice(r.error); }
}

async function ask(text) {
  const q = String(text || '').trim();
  island = 'idle';
  renderOrb();
  if (!q) { api.openChat(); return; }
  api.openChat();
  const r = await api.ask(q);
  if (!r.ok) showNotice(r.error);
}

function showNotice(text) {
  if (chatMode) {
    const n = $('#notice');
    n.textContent = text;
    n.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { n.hidden = true; }, 8000);
  }
}

// ---------- the conversation ----------
function addTurn(kind, text) {
  const thread = $('#thread');
  const turn = document.createElement('div');
  turn.className = `turn ${kind}`;
  if (kind === 'pebble') {
    const dot = document.createElement('span');
    dot.className = 'dot'; dot.innerHTML = markSVG(20);
    const body = document.createElement('div');
    body.className = 'body';
    const p = document.createElement('p');
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

function onAnswer(answer) {
  if (!chatMode) return;
  let body = pending?.body;
  pending = null;
  if (body) {
    body.querySelector('p').textContent = answer.answer || 'I could not find an answer.';
  } else {
    addTurn('user', answer.question);
    body = addTurn('pebble', answer.answer || 'I could not find an answer.').querySelector('.body');
  }
  const n = answer.grounded && answer.cites?.length ? `${answer.cites.length} ${answer.cites.length === 1 ? 'source' : 'sources'}` : 'no source';
  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = n;
  body.append(meta);
  const thread = $('#thread');
  thread.scrollTop = thread.scrollHeight;
}

// ---------- wiring ----------
if (chatMode) {
  $('#card').hidden = false;
  $('#ask-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#ask-input');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    $('#ask-send').disabled = true;
    addTurn('user', q);
    const turn = addTurn('pebble', '…');
    pending = { body: turn.querySelector('.body') };
    try {
      const r = await api.ask(q);
      if (!r.ok) { turn.querySelector('p').textContent = r.error; pending = null; }
    } finally { $('#ask-send').disabled = false; input.focus(); }
  });
  $('#card-close').addEventListener('click', () => api.closeChat());
  api.onChatOpen(() => { $('#card').hidden = false; $('#ask-input').focus(); });
  setTimeout(() => $('#ask-input').focus(), 60);
} else {
  $('#pebble').addEventListener('click', async () => {
    const phase = snap?.recording?.phase;
    if (phase === 'processing') return;
    const active = ['starting', 'recording'].includes(phase) && snap.recording.mode !== 'enroll';
    if (active) { await api.stopRecording(); return; }
    if (listening) { finishListen(); return; }
    beginListen();
  });
  $('#pebble').addEventListener('contextmenu', (e) => { e.preventDefault(); api.orbMenu(); });

  for (const btn of document.querySelectorAll('.sub[data-kind]')) {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind;
      if (kind === 'record') startCapture({});
      else if (kind === 'translate') startCapture({ mode: 'translate' });
      else ask('');
    });
  }
  $('#island-stop').addEventListener('click', () => api.stopRecording());
  $('#reply-btn').addEventListener('click', async () => {
    const bearing = snap?.recording?.reply?.phase === 'listening';
    const r = bearing ? await api.stopReply() : await api.startReply();
    if (!r.ok) notify(r.error, 7000);
  });
}

api.onIntent((payload) => {
  if (chatMode) return;
  if (island !== 'choose') return;
  route(payload?.text || '');
});
api.onAskAnswer(onAnswer);
api.onStatus((s) => { if (!s?.recording) return; snap = s; renderOrb(); });
api.status().then((s) => { if (s?.recording) snap = s; renderOrb(); });
api.onWhisper((w) => { if (chatMode) showNotice(w.text); });
api.onRecordingDone((r) => {
  if (chatMode) return;
  ownCapture = false;
  island = 'idle';
  renderOrb();
  if (!r.ok && !r.cancelled) showNotice(r.error);
});
api.onAskState((state) => {
  if (chatMode || !state || !awaitingIntent) return;
  if (state.error) { awaitingIntent = false; island = 'choose'; line(state.error); renderOrb(); }
  else if (state.phase === 'idle') { awaitingIntent = false; island = 'choose'; line('Which one?'); renderOrb(); }
});
setInterval(() => { if (island === 'live') renderOrb(); }, 1000);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (chatMode) api.closeChat();
  else if (listening) finishListen();
  else { island = 'idle'; renderOrb(); }
});

mountMark($('#pebble-mark'), 60);
renderOrb();
