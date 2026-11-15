const api = window.kindred;
const $ = (s) => document.querySelector(s);
const stage = $('#stage'), card = $('#card');
const chatMode = new URLSearchParams(window.location.search).has('chat');
document.body.classList.toggle('chat-mode', chatMode);
let hideTimer = null;
let askPhase = 'idle';
let askingText = false;

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
  if (state?.error) showCard('Kindred', state.error);
  if (askPhase === 'starting') $('#ask-status').textContent = 'Starting the microphone…';
  else if (askPhase === 'listening') $('#ask-status').textContent = `Listening${state.device ? ` on ${state.device}` : ''}… Press Done speaking when finished.`;
  else if (askPhase === 'processing') $('#ask-status').textContent = 'Transcribing your question with Argmax…';
  else if (askPhase === 'answering') {
    showCard('You asked', state.question || 'Your question');
    $('#ask-status').textContent = 'Bonsai is looking through memory…';
  } else if (state?.error) $('#ask-status').textContent = 'You can try again.';
  else if ($('#card-label').textContent !== 'Kindred' && $('#card-label').textContent !== 'Kindred is speaking') $('#ask-status').textContent = '';
}

api.onWhisper((w) => { if (chatMode) showCard(w.name ? `${w.name} is here` : 'Someone you know', w.text, 15000); });
api.onStatus((s) => {
  const phase = s?.recording?.phase || 'idle';
  stage.dataset.phase = phase;
  $('#orb-rec').hidden = !(phase === 'recording' || phase === 'starting');
  if (s?.ask) renderAsk(s.ask);
});
api.onAskState(renderAsk);
api.onAskAnswer((answer) => {
  if (!chatMode) return;
  showCard('Kindred', answer.answer || 'I could not find an answer.');
  $('#ask-status').textContent = answer.grounded
    ? `From saved memory${answer.cites?.length ? ` · ${answer.cites.join(', ')}` : ''}`
    : 'No saved source verified this answer';
  $('#orb-question').value = '';
});
api.onSpeaking(() => { if (chatMode && !card.hidden && $('#card-label').textContent === 'Kindred') $('#card-label').textContent = 'Kindred is speaking'; });
api.onChatOpen(() => { if (chatMode) { clearTimeout(hideTimer); $('#orb-question').focus(); } });
api.status().then((s) => {
  if (s?.recording) stage.dataset.phase = s.recording.phase;
  if (s?.ask) renderAsk(s.ask);
});

$('#orb').addEventListener('click', () => { if (!chatMode) api.openChat(); });
$('#orb').addEventListener('contextmenu', (e) => { e.preventDefault(); api.orbMenu(); });
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
$('#card-close').addEventListener('click', hideCard);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCard(); });
if (chatMode) showCard('Ask Kindred', 'Ask about any conversation or saved memory.');
