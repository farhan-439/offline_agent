const api = window.kindred;
const $ = (s) => document.querySelector(s);
const stage = $('#stage'), card = $('#card');
let hideTimer = null;

// Keep the native window exactly as large as the visible UI so the desktop stays clickable.
new ResizeObserver(() => api.resizeOrb(stage.offsetWidth + 40, stage.offsetHeight + 30)).observe(stage);

function showCard(label, text, ms = 15000) {
  $('#card-label').textContent = label;
  $('#card-text').textContent = text;
  card.hidden = false;
  clearTimeout(hideTimer);
  if (ms) hideTimer = setTimeout(() => { card.hidden = true; }, ms);
}

api.onWhisper((w) => showCard(w.name ? `${w.name} is here` : 'Someone you know', w.text));
api.onStatus((s) => {
  const phase = s?.recording?.phase || 'idle';
  stage.dataset.phase = phase;
  $('#orb-rec').hidden = !(phase === 'recording' || phase === 'starting');
});
api.onSpeaking(() => { if (!card.hidden) $('#card-label').textContent = 'Speaking'; });
api.status().then((s) => { if (s?.recording) stage.dataset.phase = s.recording.phase; });

$('#orb').addEventListener('click', () => api.openHub());
$('#orb').addEventListener('contextmenu', (e) => { e.preventDefault(); api.orbMenu(); });
$('#card-close').addEventListener('click', () => { card.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') card.hidden = true; });
