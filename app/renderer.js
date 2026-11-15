import { voiceLabel, dockSummary, formatClipTime, recordButtonState, enrollButtonState } from './view.mjs';

const api = window.kindred;
const $ = (s) => document.querySelector(s);
const app = $('#app');
let snap = null;
let lastAnswer = '';
let ownerVoiceKnown = false;

// ---------- navigation ----------
function show(view) {
  app.dataset.view = view;
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.view === view;
    tab.classList.toggle('active', on);
    if (on) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  }
  for (const v of ['record', 'people', 'ask']) $(`#view-${v}`).hidden = v !== view;
  if (view === 'people') loadPeople();
  if (view === 'ask') $('#ask-input').focus();
}
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => show(tab.dataset.view));
api.onNavigate((view) => show(typeof view === 'string' ? view : 'record'));

// ---------- status ----------
function render(next) {
  if (!next) return;
  if (next.error && !next.memory) { $('#capture-status').textContent = next.error; return; }
  if (!next.memory) return;
  snap = next;
  const { memory, capture, recording } = next;
  $('#memory-down').hidden = memory.ok;
  $('#capture-status').textContent = capture.message || '';
  $('#capture-pill').dataset.ok = String(!!capture.stt);

  // Only block Record while an enrollment is actually running (not after it finished).
  const enrolling = recording.mode === 'enroll' && recording.phase !== 'idle';
  const btn = enrolling
    ? { label: 'Start recording', hint: 'Recording your voice on the People screen…', disabled: true, pressed: false }
    : recordButtonState(recording.phase, capture);
  renderEnroll(recording, capture);
  app.dataset.phase = recording.phase;
  $('#record-label').textContent = btn.label;
  $('#record-hint').textContent = btn.hint;
  $('#record-btn').disabled = btn.disabled;
  $('#record-btn').setAttribute('aria-pressed', String(btn.pressed));
  const live = recording.phase === 'starting' || recording.phase === 'recording';
  $('#rec-banner').hidden = !live;
  document.title = live ? '● Recording — Kindred' : 'Kindred';

  $('#mic-line').hidden = !recording.device;
  $('#mic-name').textContent = recording.device ? `Listening on ${recording.device}${recording.note ? ` (${recording.note})` : ''}` : '';

  const list = $('#voices');
  list.replaceChildren(...recording.voices.map((v) => {
    const li = document.createElement('li');
    li.className = `voice${v.name ? ' known' : ''}${v.owner ? ' owner' : ''}`;
    const name = document.createElement('strong'); name.textContent = voiceLabel(v);
    const meta = document.createElement('span'); meta.className = 'muted';
    meta.textContent = [v.seconds ? `${Math.round(v.seconds)} s` : '', v.score != null ? `match ${Math.round(v.score * 100)}%` : ''].filter(Boolean).join(' · ');
    li.append(name, meta);
    if (v.whisper) { const w = document.createElement('p'); w.className = 'voice-whisper'; w.textContent = `“${v.whisper}”`; li.append(w); }
    return li;
  }));
  $('#voices-empty').hidden = recording.voices.length > 0;

  if (next.whisper && live) { $('#whisper').hidden = false; $('#whisper').textContent = next.whisper.text; }
  else if (!live) $('#whisper').hidden = true;
  if (recording.error) $('#record-result').textContent = recording.error;
}
api.onStatus(render);
api.status().then(render);
api.onWhisper((w) => { $('#whisper').hidden = false; $('#whisper').textContent = w.text; });
$('#memory-retry').addEventListener('click', () => api.checkMemory());

// ---------- record ----------
$('#record-btn').addEventListener('click', async () => {
  const phase = snap?.recording.phase;
  $('#record-result').textContent = '';
  if (phase === 'idle') {
    const r = await api.startRecording({});
    if (!r.ok) $('#record-result').textContent = r.error;
  } else if (phase === 'starting' || phase === 'recording') {
    await api.stopRecording();
  }
});
api.onRecordingDone((r) => {
  if (!r.ok) { $('#record-result').textContent = r.cancelled ? 'Recording cancelled.' : `Recording failed: ${r.error}`; return; }
  const saved = `Saved ${r.utterances} lines from ${r.speakers} ${r.speakers === 1 ? 'voice' : 'voices'}.`;
  $('#record-result').textContent = r.ingested ? `${saved} Memory has it; dock in People when you get home.` : `${saved} Not sent to memory yet: ${r.ingestError}`;
});

// ---------- your voice (enrollment) ----------
function renderEnroll(recording, capture) {
  const st = enrollButtonState(recording, capture, ownerVoiceKnown);
  $('#enroll-btn').textContent = st.label;
  $('#enroll-btn').disabled = st.disabled;
  $('#enroll-hint').textContent = st.hint;
  $('#enroll-passage').hidden = !st.reading;
  $('#enroll').classList.toggle('reading', st.reading);
}
$('#enroll-btn').addEventListener('click', async () => {
  const r = snap?.recording;
  if (r?.mode === 'enroll' && (r.phase === 'starting' || r.phase === 'recording')) { await api.stopRecording(); return; }
  $('#enroll-result').textContent = '';
  const res = await api.enrollOwner();
  if (!res.ok) $('#enroll-result').textContent = res.error;
});
api.onEnrollDone((r) => {
  if (!r.ok) { $('#enroll-result').textContent = r.cancelled ? 'Cancelled.' : r.error; return; }
  ownerVoiceKnown = true;
  $('#enroll-result').textContent = `Got it: Kindred knows your voice now (${r.samples} ${r.samples === 1 ? 'sample' : 'samples'}, ${Math.round(r.seconds)} s).${r.note ? ` ${r.note}` : ''}`;
  if (snap) renderEnroll(snap.recording, snap.capture);
  loadPeople();
});

// ---------- people / dock ----------
function renderPeople(roster) {
  const people = roster?.people || [];
  ownerVoiceKnown = people.some((p) => p.owner && p.voiceSamples > 0);
  if (snap) renderEnroll(snap.recording, snap.capture);
  $('#people').replaceChildren(...people.map((p) => {
    const li = document.createElement('li'); li.className = `person${p.owner ? ' owner' : ''}`;
    const h = document.createElement('h3'); h.textContent = p.owner ? `${p.name} (you)` : p.name;
    const rel = document.createElement('p'); rel.className = 'relation'; rel.textContent = p.relation || (p.owner ? 'Owner of this Kindred' : 'Relation unknown');
    const core = document.createElement('p'); core.className = 'core'; core.textContent = p.core || 'No memory card yet.';
    const meta = document.createElement('p'); meta.className = 'muted small';
    meta.textContent = `${p.facts} ${p.facts === 1 ? 'fact' : 'facts'} · ${p.voiceSamples ? 'voice known' : 'voice not known yet'}`;
    li.append(h, rel, core, meta);
    return li;
  }));
  $('#people-empty').hidden = people.length > 0;
}
async function loadPeople() {
  const r = await api.people();
  if (r.ok) renderPeople(r.value); else if (r.code !== 'MEMORY_DOWN') $('#dock-status').textContent = r.error;
}
$('#dock-btn').addEventListener('click', async () => {
  const btn = $('#dock-btn');
  btn.disabled = true; btn.textContent = 'Docking… Bonsai is reading';
  $('#dock-status').textContent = 'This can take a few minutes.';
  try {
    const r = await api.dock();
    if (!r.ok) { $('#dock-status').textContent = r.error; return; }
    $('#dock-status').textContent = dockSummary(r.value.report);
    renderPeople(r.value);
  } finally { btn.disabled = false; btn.textContent = "Dock today's conversations"; }
});

// ---------- ask ----------
const player = $('#player');
let stopAt = null;
player.addEventListener('timeupdate', () => { if (stopAt !== null && player.currentTime >= stopAt) { player.pause(); stopAt = null; } });
function play(clip) {
  // #t=start,end in the URL seeks; the end is enforced here too because not every codec honours it.
  player.src = clip.url;
  stopAt = clip.end;
  player.play().catch((e) => { $('#answer').append(document.createTextNode(` (could not play: ${e.message})`)); });
}

function sourceCard(source, photo = null) {
  const li = document.createElement('li'); li.className = 'source';
  const ref = document.createElement('strong'); ref.textContent = source.ref || photo?.id || 'Memory';
  const kind = document.createElement('span'); kind.className = 'muted';
  kind.textContent = source.layer === 'input' ? 'Your input' : source.layer === 'photo' || photo ? 'Photo' : 'Saved memory';
  li.append(ref, kind);
  const content = source.text || photo?.caption;
  if (content) { const p = document.createElement('p'); p.textContent = content; li.append(p); }
  if (photo?.url) {
    const img = document.createElement('img'); img.src = photo.url;
    img.alt = photo.caption || `Saved photo ${photo.id}`; img.loading = 'lazy'; li.append(img);
  }
  return li;
}

$('#ask-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const q = $('#ask-input').value.trim();
  if (!q) return;
  const btn = $('#ask-btn');
  btn.disabled = true; btn.textContent = 'Thinking…';
  $('#answer-box').hidden = false; $('#answer').textContent = 'Looking through your memory…';
  $('#answer-evidence').textContent = ''; $('#sources').replaceChildren(); $('#clips').replaceChildren();
  $('#sources-section').hidden = true; $('#clips-section').hidden = true;
  try {
    const r = await api.ask(q);
    if (!r.ok) { $('#answer').textContent = r.error; return; }
    lastAnswer = r.value.answer;
    $('#answer').textContent = r.value.answer;
    const evidence = $('#answer-evidence');
    evidence.dataset.grounded = String(!!r.value.grounded);
    evidence.textContent = r.value.grounded ? 'Supported by saved memory' : 'No saved source verified this answer';
    const photos = r.value.photos || [];
    const sources = r.value.sources || [];
    const usedPhotos = new Set();
    const cards = sources.map((source) => {
      const photo = photos.find((p) => p.id === source.photoId);
      if (photo) usedPhotos.add(photo.id);
      return sourceCard(source, photo);
    });
    for (const photo of photos) if (!usedPhotos.has(photo.id)) cards.push(sourceCard({}, photo));
    $('#sources').replaceChildren(...cards);
    $('#sources-section').hidden = cards.length === 0;
    $('#clips-section').hidden = !r.value.clips?.length;
    $('#clips').replaceChildren(...r.value.clips.map((c) => {
      const li = document.createElement('li'); li.className = 'clip';
      const who = document.createElement('strong'); who.textContent = c.speaker || 'Someone';
      const when = document.createElement('span'); when.className = 'muted'; when.textContent = formatClipTime(c);
      const text = document.createElement('p'); text.textContent = `“${c.text}”`;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn';
      b.textContent = c.url ? '▶ Play' : 'Audio missing'; b.disabled = !c.url;
      b.setAttribute('aria-label', `Play what ${c.speaker || 'they'} said`);
      b.addEventListener('click', () => play(c));
      const body = document.createElement('div'); body.className = 'clip-body'; body.append(who, when, text);
      li.append(body, b);
      return li;
    }));
  } finally { btn.disabled = false; btn.textContent = 'Ask'; }
});
$('#say-again').addEventListener('click', () => lastAnswer && api.speak(lastAnswer));
$('#hush').addEventListener('click', () => { api.stopSpeaking(); player.pause(); });

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { api.stopSpeaking(); player.pause(); } });
