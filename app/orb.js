import { orbMenuState, voiceLabel, languageName, elapsed } from './view.mjs';

const api = window.kindred;
const $ = (s) => document.querySelector(s);
const stage = $('#stage'), card = $('#card');
// Two windows load this page: the small orb, and (?chat) the card it opens.
const chatMode = new URLSearchParams(window.location.search).has('chat');
document.body.classList.toggle('chat-mode', chatMode);
let hideTimer = null, noticeTimer = null;
let askPhase = 'idle';
let askingText = false;
let snap = null;
let chosen = 'menu'; // what the user picked when nothing is running: 'menu' | 'ask'

// ---------- views ----------
/** Recording or translating always shows the live view; a voice question shows Ask; otherwise what was chosen. */
function currentView(menu) {
  if (menu.active === 'conversation' || menu.active === 'translate') return 'live';
  if (menu.active === 'ask') return 'ask';
  return chosen;
}

function render() {
  const menu = orbMenuState(snap || {});
  stage.dataset.active = menu.active || '';
  stage.dataset.phase = snap?.recording?.phase || 'idle';
  const badge = $('#orb-badge');
  badge.hidden = !(menu.active === 'conversation' || menu.active === 'translate');
  badge.textContent = menu.active === 'translate' ? '文A' : '';
  $('#orb').setAttribute('aria-label', menu.active === 'conversation' ? 'Kindred is recording. Click for options'
    : menu.active === 'translate' ? 'Kindred is translating. Click for options' : 'Kindred. Click for options, right-click for more');
  if (!chatMode) return;

  const view = currentView(menu);
  stage.dataset.view = view;
  for (const v of ['menu', 'live', 'ask']) $(`#view-${v}`).hidden = v !== view;
  $('#back').hidden = view !== 'ask' || menu.active === 'ask';
  if (view === 'menu') { $('#card-label').textContent = 'Kindred'; renderMenu(menu); }
  if (view === 'live') renderLive(menu);
}

function renderMenu(menu) {
  for (const key of ['record', 'ask', 'translate']) {
    const m = menu[key];
    $(`#${key}-label`).textContent = m.label;
    $(`#${key}-hint`).textContent = m.hint;
    $(`#choice-${key}`).disabled = m.disabled;
  }
}

function renderLive(menu) {
  const rec = snap.recording;
  const translating = menu.active === 'translate';
  const m = translating ? menu.translate : menu.record;
  $('#card-label').textContent = translating ? 'Live translation' : 'Recording';
  $('#live-title').textContent = rec.phase === 'processing' ? 'Saving…' : translating ? 'Translating into English' : 'Recording';
  $('#live-time').textContent = rec.startedAt ? elapsed(Date.now() - rec.startedAt) : '';
  $('#live-note').textContent = rec.phase === 'starting' ? 'Getting the microphone ready…'
    : rec.phase === 'processing' ? 'Writing down what was said, on this Mac.'
    : translating ? 'Use earbuds. Kindred says each translation quietly in your ear.'
    : `Everyone nearby is being recorded${rec.device ? ` on ${rec.device}` : ''}. Kindred whispers who people are.`;
  $('#live-stop').textContent = m.label;
  $('#live-stop').disabled = m.disabled;

  const list = $('#live-list');
  if (translating) {
    const lines = [...(rec.translations || [])].reverse().slice(0, 4);
    list.replaceChildren(...lines.map((t) => {
      const li = document.createElement('li');
      const original = document.createElement('p'); original.className = 'original';
      original.textContent = `${languageName(t.language)}: “${t.text}”`;
      const english = document.createElement('p'); english.className = 'english';
      english.textContent = t.translation || '(English, no translation needed)';
      li.append(original, english);
      return li;
    }));
    $('#live-empty').textContent = lines.length ? '' : 'Listening for another language…';
  } else {
    const voices = rec.voices || [];
    list.replaceChildren(...voices.map((v) => {
      const li = document.createElement('li'); li.className = v.name ? 'known' : '';
      const who = document.createElement('span'); who.className = 'who'; who.textContent = voiceLabel(v);
      const meta = document.createElement('span'); meta.className = 'meta';
      meta.textContent = [v.seconds ? `${Math.round(v.seconds)} s` : '', v.score != null ? `match ${Math.round(v.score * 100)}%` : ''].filter(Boolean).join(' · ');
      li.append(who, meta);
      if (v.whisper) { const p = document.createElement('p'); p.className = 'said'; p.textContent = `“${v.whisper}”`; li.append(p); }
      return li;
    }));
    $('#live-empty').textContent = voices.length ? '' : 'No voices yet.';
  }
}
setInterval(() => { if (chatMode && stage.dataset.view === 'live' && snap?.recording?.startedAt) $('#live-time').textContent = elapsed(Date.now() - snap.recording.startedAt); }, 1000);

function showNotice(label, text, ms = 15000) {
  const n = $('#notice');
  const l = document.createElement('span'); l.className = 'notice-label'; l.textContent = label;
  n.replaceChildren(l, document.createTextNode(text));
  n.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { n.hidden = true; }, ms);
}

// ---------- ask (type or talk) ----------
function hideCard() {
  if (chatMode) api.closeChat();
}

function showCard(label, text, ms = 0) {
  $('#card-label').textContent = label;
  $('#card-text').textContent = text;
  card.hidden = false;
  clearTimeout(hideTimer);
  if (ms) hideTimer = setTimeout(hideCard, ms);
}

function renderAsk(state) {
  if (!chatMode) return;
  askPhase = state?.phase || 'idle';
  const active = ['starting', 'listening', 'processing', 'answering'].includes(askPhase);
  const listening = askPhase === 'starting' || askPhase === 'listening';
  $('#orb-mic').dataset.listening = String(listening);
  $('#orb-mic').disabled = askPhase === 'processing' || askPhase === 'answering' || askingText;
  $('#orb-mic').textContent = listening ? '■ Done speaking' : '🎙 Talk to Kindred';
  $('#orb-question').disabled = active;
  $('#orb-send').disabled = active || askingText;
  stage.dataset.ask = askPhase;
  if (state?.error) { chosen = 'ask'; showCard('Kindred', state.error); }
  if (askPhase === 'starting') $('#ask-status').textContent = 'Starting the microphone…';
  else if (askPhase === 'listening') $('#ask-status').textContent = `Listening${state.device ? ` on ${state.device}` : ''}… Press Done speaking when finished.`;
  else if (askPhase === 'processing') $('#ask-status').textContent = 'Transcribing your question with Argmax…';
  else if (askPhase === 'answering') {
    showCard('You asked', state.question || 'Your question');
    $('#ask-status').textContent = 'Bonsai is looking through memory…';
  } else if (state?.error) $('#ask-status').textContent = 'You can try again.';
  else if ($('#card-label').textContent !== 'Kindred' && $('#card-label').textContent !== 'Kindred is speaking') $('#ask-status').textContent = '';
}

function openAsk() {
  chosen = 'ask';
  showCard('Ask Kindred', 'Ask about any conversation or saved memory.');
  $('#ask-status').textContent = '';
  render();
  $('#orb-question').focus();
}

// ---------- events from the app ----------
api.onWhisper((w) => { if (chatMode) showNotice(w.name ? `${w.name} is here` : 'Someone you know', w.text); });
api.onStatus((s) => {
  if (!s?.recording) return;
  snap = s;
  if (s.ask) renderAsk(s.ask);
  render();
});
api.onAskState((state) => { renderAsk(state); if (snap) { snap = { ...snap, ask: state }; render(); } });
api.onAskAnswer((answer) => {
  if (!chatMode) return;
  chosen = 'ask';
  showCard('Kindred', answer.answer || 'I could not find an answer.');
  $('#ask-status').textContent = answer.grounded
    ? `From saved memory${answer.cites?.length ? ` · ${answer.cites.join(', ')}` : ''}`
    : 'No saved source verified this answer';
  $('#orb-question').value = '';
  render();
});
api.onRecordingDone((r) => {
  if (!chatMode) return;
  if (!r.ok) { if (!r.cancelled) showNotice('Recording failed', r.error, 12000); return; }
  const what = r.mode === 'translate' ? 'Translated conversation saved' : 'Conversation saved';
  const lines = `${r.utterances} ${r.utterances === 1 ? 'line' : 'lines'} from ${r.speakers} ${r.speakers === 1 ? 'voice' : 'voices'}.`;
  showNotice(what, r.ingested ? `${lines} Memory has it. Dock when you get home.` : `${lines} Not sent to memory yet: ${r.ingestError}`, 12000);
});
api.onSpeaking(() => { if (chatMode && stage.dataset.view === 'ask' && $('#card-label').textContent === 'Kindred') $('#card-label').textContent = 'Kindred is speaking'; });
// Each time the orb is clicked the card opens on the menu, unless something is already running.
api.onChatOpen(() => {
  if (!chatMode) return;
  clearTimeout(hideTimer);
  card.hidden = false;
  if (askPhase === 'idle' && !askingText) chosen = 'menu';
  render();
});
api.status().then((s) => {
  if (s?.recording) snap = s;
  if (s?.ask) renderAsk(s.ask);
  render();
});

// ---------- controls ----------
$('#orb').addEventListener('click', () => { if (!chatMode) api.openChat(); });
$('#orb').addEventListener('contextmenu', (e) => { e.preventDefault(); api.orbMenu(); });
$('#back').addEventListener('click', () => { chosen = 'menu'; render(); });
$('#card-close').addEventListener('click', hideCard);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCard(); });

async function start(opts) {
  $('#notice').hidden = true;
  const r = await api.startRecording(opts);
  if (!r.ok) showNotice('Kindred', r.error, 8000);
}
$('#choice-record').addEventListener('click', () => start({}));
$('#choice-translate').addEventListener('click', () => start({ mode: 'translate' }));
$('#choice-ask').addEventListener('click', openAsk);
$('#live-stop').addEventListener('click', async () => {
  $('#live-stop').disabled = true;
  const r = await api.stopRecording();
  if (!r.ok) showNotice('Kindred', r.error, 8000);
});

$('#orb-ask-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = $('#orb-question').value.trim();
  if (!question || askingText || askPhase !== 'idle') return;
  clearTimeout(hideTimer);
  askingText = true;
  $('#orb-send').disabled = true; $('#orb-mic').disabled = true;
  showCard('You asked', question);
  $('#ask-status').textContent = 'Bonsai is looking through memory…';
  try {
    const result = await api.ask(question);
    if (!result.ok) showCard('Kindred', result.error);
  } finally {
    askingText = false;
    $('#orb-send').disabled = false; $('#orb-mic').disabled = false;
  }
});
$('#orb-mic').addEventListener('click', async () => {
  clearTimeout(hideTimer);
  if (askPhase === 'starting' || askPhase === 'listening') {
    const result = await api.stopAskListening();
    if (!result.ok) showCard('Kindred', result.error);
    return;
  }
  showCard('Kindred', 'I’m listening. Ask your question, then press Done speaking.');
  const result = await api.startAskListening();
  if (!result.ok) { showCard('Kindred', result.error); $('#ask-status').textContent = 'Microphone unavailable.'; }
});

if (chatMode) { card.hidden = false; render(); }
