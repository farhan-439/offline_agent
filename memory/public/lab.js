const $ = (id) => document.getElementById(id);
const messages = $('messages');
const state = { view: 'chat', memories: new Map(), people: [], relations: [], photos: [] };
let toastTimer;
let ledgerTimer;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function showToast(text) {
  const toast = $('toast');
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function prettyDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function relativeTime(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return prettyDate(value);
}

/* ---------- views ---------- */

function setView(view) {
  state.view = view;
  for (const name of ['chat', 'ledger', 'people']) {
    $(`view-${name}`).hidden = name !== view;
    $(`tab-${name}`).setAttribute('aria-selected', String(name === view));
  }
  if (view === 'ledger') refreshLedger().catch((e) => showToast(e.message));
  if (view === 'people') refreshPeople().catch((e) => showToast(e.message));
}

for (const tab of document.querySelectorAll('[data-view]')) {
  tab.addEventListener('click', () => setView(tab.dataset.view));
}

/* ---------- inputs (exact text, N citations) ---------- */

async function refreshInputs() {
  const { inputs } = await api('/inputs');
  const list = $('input-list');
  list.replaceChildren();
  $('input-count').textContent = String(inputs.length);
  $('saved-state').textContent = inputs.length ? `${inputs.length} saved` : '';
  if (!inputs.length) {
    list.append(el('div', 'empty-inputs', 'Your inputs will appear here. Try adding a short fact, then ask about it in different words.'));
    return;
  }
  for (const item of inputs) {
    const card = el('article', 'input-card');
    const head = el('div', 'input-card-head');
    head.append(el('span', 'input-tag', `YOUR INPUT · ${item.id}`));
    const time = el('time', '', prettyDate(item.createdAt));
    time.dateTime = item.createdAt;
    head.append(time);
    card.append(head, el('p', '', item.text));
    list.append(card);
  }
}

/* ---------- ledger (F citations) ---------- */

function originBadge(origin) {
  const label = origin === 'user' ? 'Added by you' : 'Inferred';
  return el('span', `origin-badge ${origin === 'user' ? 'user' : 'inferred'}`, label);
}

/** Full index used to resolve citations, independent of the Ledger's current filters. */
async function refreshMemoryIndex() {
  const { memories } = await api('/memories?status=any&limit=300');
  state.memories = new Map(memories.map((m) => [m.ref, m]));
}

async function refreshLedger() {
  await refreshMemoryIndex();
  const params = new URLSearchParams();
  const q = $('ledger-search').value.trim();
  const person = $('ledger-person').value;
  const status = $('ledger-status').value;
  if (q) params.set('q', q);
  if (person) params.set('person', person);
  if (status) params.set('status', status);
  params.set('limit', '300');
  const { memories } = await api(`/memories?${params}`);
  const list = $('ledger-list');
  list.replaceChildren();
  $('ledger-empty').hidden = memories.length > 0;
  for (const memory of memories) list.append(memoryCard(memory));
}

function memoryCard(m) {
  const card = el('article', 'ledger-card');
  card.dataset.ref = m.ref;
  const top = el('div', 'ledger-top');
  top.append(originBadge(m.origin));
  if (m.status !== 'active') top.append(el('span', 'status-badge', m.status === 'retracted' ? 'Forgotten' : 'Retired'));
  const uses = el('span', 'meta');
  uses.textContent = m.uses > 0 ? `used ${m.uses}×${m.lastUsed ? ` · ${relativeTime(m.lastUsed)}` : ''}` : 'not cited yet';
  top.append(uses);
  card.append(top);
  card.append(el('p', 'memory-statement', m.text));

  if (m.source?.quote?.text) {
    card.append(el('blockquote', 'memory-quote', `“${m.source.quote.text}”`));
    const from = el('p', 'memory-source');
    from.textContent = `From ${m.source.session ?? 'a conversation'}${m.createdAt ? ` · ${prettyDate(m.createdAt)}` : ''}`;
    card.append(from);
  } else if (m.origin === 'user') {
    card.append(el('p', 'memory-source', 'Added by you. No conversation behind it.'));
  } else {
    card.append(el('p', 'memory-source', 'Source unavailable for this memory.'));
  }

  const foot = el('div', 'memory-foot');
  if (m.person?.name) {
    const chip = el('button', 'person-chip', m.person.name);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      $('ledger-person').value = m.person.name;
      refreshLedger().catch((e) => showToast(e.message));
    });
    foot.append(chip);
  }
  foot.append(el('span', 'kind-chip', m.kind));
  foot.append(el('span', 'scope-chip', m.scope === 'all' ? 'All chats' : m.scope));

  if (m.status === 'active') {
    const actions = el('div', 'memory-actions');
    const correct = el('button', 'quiet-link', 'Correct');
    correct.type = 'button';
    correct.addEventListener('click', () => startCorrect(m));
    const forget = el('button', 'quiet-link', 'Forget');
    forget.type = 'button';
    forget.addEventListener('click', () => startForget(m));
    const remind = el('button', 'quiet-link', 'Remind');
    remind.type = 'button';
    remind.addEventListener('click', () => startReminder(m));
    actions.append(correct, forget, remind);
    foot.append(actions);
  }
  card.append(foot);
  return card;
}

/* ---------- people ---------- */

async function refreshPeople() {
  const graph = await api('/people');
  state.people = graph.people;
  state.relations = graph.relations;
  const list = $('people-list');
  list.replaceChildren();
  if (!graph.people.length) {
    list.append(el('p', 'empty-note', 'No people yet. Dock a conversation or add a memory.'));
    return;
  }
  for (const person of graph.people) {
    const card = el('article', 'person-card');
    const head = el('div', 'person-head');
    head.append(el('h3', '', person.name));
    if (person.relation) head.append(el('span', 'person-relation', person.relation));
    card.append(head);
    card.append(el('p', 'person-core', person.core || 'No core card yet.'));
    const foot = el('div', 'person-foot');
    foot.append(el('span', 'meta', `${person.facts} ${person.facts === 1 ? 'memory' : 'memories'}`));
    foot.append(el('span', 'meta', person.voice_samples ? 'voice enrolled' : 'no voiceprint'));
    const view = el('button', 'quiet-link', 'View memories');
    view.type = 'button';
    view.addEventListener('click', () => {
      setView('ledger');
      $('ledger-person').value = person.name;
      refreshLedger().catch((e) => showToast(e.message));
    });
    foot.append(view);
    card.append(foot);
    list.append(card);
  }
  fillPersonSelect();
}

function fillPersonSelect() {
  const select = $('ledger-person');
  const current = select.value;
  select.replaceChildren(el('option', '', 'Everyone'));
  select.firstChild.value = '';
  for (const person of state.people) {
    const option = el('option', '', person.name);
    option.value = person.name;
    select.append(option);
  }
  select.value = current;
}

/* ---------- dialog + two-step actions ---------- */

const dialog = $('action-dialog');
const dialogForm = $('dialog-form');
const dialogTitle = $('dialog-title');
const dialogBody = $('dialog-body');
const dialogConfirm = $('dialog-confirm');
let dialogHandler = null;

function closeDialog() {
  dialogHandler = null;
  if (dialog.open) dialog.close();
}

function openDialog({ title, nodes, confirmLabel = 'Confirm', onConfirm }) {
  dialogTitle.textContent = title;
  dialogBody.replaceChildren(...nodes);
  dialogConfirm.textContent = confirmLabel;
  dialogConfirm.disabled = false;
  dialogHandler = onConfirm;
  if (!dialog.open) dialog.showModal();
}

dialogForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const handler = dialogHandler;
  if (!handler) return closeDialog();
  dialogConfirm.disabled = true;
  try { await handler(); } finally { dialogConfirm.disabled = false; }
});
$('dialog-cancel').addEventListener('click', closeDialog);

function note(text) { return el('p', 'dialog-note', text); }

/** Propose on the server, show the consequence, and only apply after an explicit confirm. */
async function proposeThenConfirm({ kind, payload, title, note: noteText, confirmLabel = 'Confirm' }) {
  const proposal = await api('/action', { method: 'POST', body: JSON.stringify({ kind, ...payload }) });
  openDialog({
    title,
    nodes: [
      noteText ? note(noteText) : note(''),
      el('p', 'dialog-consequence', proposal.summary),
      el('p', 'dialog-status', 'Nothing has changed yet.'),
    ],
    confirmLabel,
    onConfirm: async () => {
      try {
        const applied = await api('/action', { method: 'POST', body: JSON.stringify({ id: proposal.id, confirm: true }) });
        dialogBody.replaceChildren(el('p', 'dialog-consequence', applied.status === 'applied' ? 'Applied.' : `Status: ${applied.status}`));
        dialogConfirm.textContent = 'Done';
        dialogHandler = closeDialog;
        await refreshAll();
        if (state.view === 'chat') addStatusLine(`Action applied: ${kind.replaceAll('_', ' ')}.`);
      } catch (error) {
        dialogBody.append(el('p', 'dialog-error', error.message));
        dialogBody.append(el('p', 'dialog-status', 'Not applied. The memory is unchanged.'));
      }
    },
  });
}

function startForget(memory) {
  proposeThenConfirm({
    kind: 'forget_memory', payload: { ref: memory.ref }, title: 'Forget this memory',
    noteText: `“${memory.text}”`,
    confirmLabel: 'Forget',
  }).catch((e) => showToast(e.message));
}

function startCorrect(memory) {
  const textarea = el('textarea', 'dialog-input');
  textarea.rows = 3;
  textarea.value = memory.text;
  textarea.setAttribute('aria-label', 'Corrected statement');
  openDialog({
    title: 'Correct this memory',
    nodes: [
      note('The original conversation stays in your history. This replaces the statement memory uses.'),
      textarea,
    ],
    confirmLabel: 'Review',
    onConfirm: async () => {
      const text = textarea.value.trim();
      if (!text) return showToast('Write the corrected statement first.');
      await proposeThenConfirm({
        kind: 'correct_memory', payload: { ref: memory.ref, text }, title: 'Confirm correction',
        noteText: 'This memory will be superseded by your correction.', confirmLabel: 'Apply correction',
      });
    },
  });
}

function startReminder(memory) {
  const input = el('input', 'dialog-input');
  input.value = memory ? memory.text : '';
  input.placeholder = 'What should it remind you about?';
  input.setAttribute('aria-label', 'Reminder text');
  const due = el('input', 'dialog-input');
  due.placeholder = 'When? (tomorrow, Friday, December 3)';
  due.setAttribute('aria-label', 'Reminder date');
  openDialog({
    title: 'Set a reminder',
    nodes: [note('A reminder is stored as an action, not as a Ledger fact.'), input, due],
    confirmLabel: 'Review',
    onConfirm: async () => {
      if (!input.value.trim()) return showToast('Write what to remember.');
      await proposeThenConfirm({
        kind: 'set_reminder', payload: { text: input.value.trim(), due: due.value.trim() || null },
        title: 'Confirm reminder', confirmLabel: 'Set reminder',
      });
    },
  });
}

/* ---------- explicit save (+ Remember / Ledger add) ---------- */

function startRemember(prefill = '', person = '') {
  const textarea = el('textarea', 'dialog-input');
  textarea.rows = 3;
  textarea.value = prefill;
  textarea.setAttribute('aria-label', 'Memory statement');
  const select = el('select', 'dialog-input');
  select.append(el('option', '', 'No particular person'));
  select.firstChild.value = '';
  for (const p of state.people) {
    const option = el('option', '', p.name);
    option.value = p.name;
    select.append(option);
  }
  if (person) select.value = person;
  openDialog({
    title: 'Remember this',
    nodes: [
      note('Saved as yours, with no invented source. It appears immediately in the Ledger and in answers.'),
      textarea,
      select,
    ],
    confirmLabel: 'Save',
    onConfirm: async () => {
      const text = textarea.value.trim();
      if (text.length < 3) return showToast('Write at least a few words.');
      const saved = await api('/memory', { method: 'POST', body: JSON.stringify({ text, person: select.value || null }) });
      closeDialog();
      addRememberLine(saved.memory);
      showToast('Saved to the Ledger.');
      await refreshAll();
    },
  });
}

/* ---------- chat ---------- */

function addMessage(role, text) {
  $('welcome').hidden = true;
  const wrapper = el('div', `message ${role}`);
  if (role === 'user') wrapper.append(el('div', 'user-bubble', text));
  else {
    wrapper.classList.add('assistant-message');
    wrapper.append(el('div', 'assistant-icon', '✳'));
    const content = el('div', 'assistant-content');
    content.append(el('div', 'assistant-label', 'KINDRED'), el('div', 'assistant-answer pending', text));
    wrapper.append(content);
  }
  messages.append(wrapper);
  scrollToLatest();
  return wrapper;
}

function scrollToLatest() {
  $('conversation').scrollTop = $('conversation').scrollHeight;
}

function addStatusLine(text) {
  $('welcome').hidden = true;
  messages.append(el('p', 'status-line', text));
  scrollToLatest();
}

function addRememberLine(memory) {
  $('welcome').hidden = true;
  const line = el('div', 'remember-line');
  line.append(el('span', 'remember-plus', '＋'), el('span', 'remember-text', `Remembered: ${memory.text}`));
  const edit = el('button', 'quiet-link', 'Edit');
  edit.type = 'button';
  edit.addEventListener('click', () => startCorrect(memory));
  const forget = el('button', 'quiet-link', 'Forget');
  forget.type = 'button';
  forget.addEventListener('click', () => startForget(memory));
  line.append(edit, forget);
  messages.append(line);
  scrollToLatest();
}

function addPhotoLine(result) {
  $('welcome').hidden = true;
  const card = el('div', 'photo-line');
  const img = el('img', 'photo-thumb');
  img.src = `/photo/${result.photo.id}`;
  img.alt = result.caption || 'Stored photo';
  const body = el('div', 'photo-body');
  body.append(el('p', 'photo-caption', result.caption || 'Photo stored.'));
  if (result.observations?.length) {
    const list = el('ul', 'photo-observations');
    for (const o of result.observations.slice(0, 6)) list.append(el('li', '', `${o.kind}: ${o.text}`));
    body.append(list);
  }
  const ask = el('button', 'quiet-link', 'Ask about this photo');
  ask.type = 'button';
  ask.addEventListener('click', () => { $('question').value = 'What is in this photo?'; $('question').focus(); });
  body.append(ask);
  card.append(img, body);
  messages.append(card);
  scrollToLatest();
}

function sourceCard(source) {
  const card = el('article', `source-card source-${source.kind}`);
  const head = el('header', 'source-head');
  head.append(el('span', 'source-kind', source.title));
  head.append(el('span', 'source-ref', source.ref));
  card.append(head);

  if (source.image) {
    const img = el('img', 'source-image');
    img.src = source.image;
    img.alt = source.text || 'Cited photo';
    card.append(img);
  }
  if (source.text) card.append(el('p', 'source-text', source.text));
  if (source.quote) card.append(el('blockquote', 'source-quote', `“${source.quote}”`));
  if (source.missing) card.append(el('p', 'source-missing', 'No details returned for this reference.'));

  const foot = el('footer', 'source-foot');
  if (source.origin) foot.append(originBadge(source.origin));
  if (source.kind === 'fact') {
    const open = el('button', 'quiet-link', 'Open in Ledger');
    open.type = 'button';
    open.addEventListener('click', () => {
      setView('ledger');
      $('ledger-search').value = '';
      $('ledger-person').value = '';
      $('ledger-status').value = 'any';
      refreshLedger()
        .then(() => {
          const node = document.querySelector(`.ledger-card[data-ref="${source.ref}"]`);
          if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        })
        .catch((e) => showToast(e.message));
    });
    foot.append(open);
  }
  if (source.meta) foot.append(el('span', 'meta', source.meta));
  if (foot.childNodes.length) card.append(foot);
  return card;
}

function sourcesFor(result) {
  const out = [];
  const seen = new Set();
  for (const input of result.inputs || []) {
    out.push({ kind: 'input', ref: input.id, title: 'Your input', text: input.text, meta: prettyDate(input.createdAt) });
    seen.add(input.id);
  }
  for (const clip of result.clips || []) {
    const span = clip.start != null && clip.end != null ? `${Number(clip.start).toFixed(1)}–${Number(clip.end).toFixed(1)}s` : '';
    out.push({ kind: 'clip', ref: clip.id, title: `${clip.speaker || 'Conversation'}${clip.started_at ? ` · ${prettyDate(clip.started_at)}` : ''}`, text: clip.text, meta: span });
  }
  for (const photo of result.photos || []) {
    out.push({ kind: 'photo', ref: photo.id, title: photo.caption ? 'Photo' : 'Photo', text: photo.caption, image: `/photo/${photo.id}`, meta: photo.taken_at ? prettyDate(photo.taken_at) : '' });
  }
  for (const ref of result.cites || []) {
    if (seen.has(ref)) continue;
    if (/^F\d+$/.test(ref)) {
      const memory = state.memories.get(ref);
      out.push({ kind: 'fact', ref, title: memory ? `${memory.person?.name ?? 'Ledger'} · ${memory.kind}` : 'Ledger memory', text: memory?.text, quote: memory?.source?.quote?.text, origin: memory?.origin, meta: memory ? (memory.uses > 0 ? `used ${memory.uses}×` : '') : '', missing: !memory });
    } else if (ref.startsWith('P:')) {
      const person = state.people.find((p) => p.id === ref.slice(2));
      out.push({ kind: 'person', ref, title: person ? `${person.name}${person.relation ? ` · ${person.relation}` : ''}` : 'Person card', text: person?.core ?? null, missing: !person });
    } else if (/^E\d+$/.test(ref)) {
      out.push({ kind: 'episode', ref, title: 'Conversation episode', text: null, missing: true });
    } else if (!/^N\d+$/.test(ref)) {
      out.push({ kind: 'reference', ref, title: 'Reference', text: null, missing: true });
    }
    seen.add(ref);
  }
  return out;
}

function addEvidence(container, result) {
  const sources = sourcesFor(result);
  const box = el('section', 'evidence-box');
  const title = el('div', 'evidence-title', sources.length ? '✳  Sources used' : '○  No source returned');
  title.append(el('span', 'evidence-count', `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`));
  box.append(title);
  if (!sources.length) box.append(el('div', 'evidence-empty', 'Bonsai did not cite anything stored. Treat this answer as unverified.'));
  for (const source of sources) box.append(sourceCard(source));
  container.append(box);
}

function describeStep(step) {
  switch (step.action) {
    case 'mode': return `Retrieval mode: ${step.mode}${step.degraded ? ' (degraded)' : ''}`;
    case 'plan_query': return `Split into ${step.queries.length} search${step.queries.length === 1 ? '' : 'es'}: ${step.queries.join(' · ')}${step.person ? ` · person: ${step.person}` : ''}`;
    case 'rerank': return `Bonsai selected ${step.selected.length} page${step.selected.length === 1 ? '' : 's'}: ${step.selected.join(', ') || 'none'}`;
    case 'hybrid_search': return `Hybrid search for “${step.query}”${step.loaded?.length ? ` → ${step.loaded.join(', ')}` : ''}`;
    case 'search': return `Searched “${step.query}”${step.person ? ` for ${step.person}` : ''}${step.loaded?.length ? ` → loaded ${step.loaded.join(', ')}` : ''}`;
    case 'open_episode': return `Opened conversation ${step.episode}${step.found ? '' : ' (not found)'}`;
    case 'answer': return `Answered with ${step.cite.length} citation${step.cite.length === 1 ? '' : 's'}`;
    case 'answer_rejected': return `Rejected an unsupported date claim`;
    case 'fallback': return `Answered from the pages already loaded`;
    case 'propose_action': return `Proposed an action: ${step.kind}`;
    case 'play_clip': return `Opened the original clip ${step.ref}`;
    case 'error': return `Model error: ${step.error}`;
    default: return step.query ? `Step: ${step.query}` : 'Step';
  }
}

function addTrace(container, trace) {
  const details = el('details', 'trace');
  details.append(el('summary', '', 'How Bonsai searched'));
  const list = el('ol', 'trace-list');
  for (const step of trace) {
    const item = el('li', 'trace-step');
    item.append(el('span', 'trace-action', step.action));
    item.append(el('span', 'trace-detail', describeStep(step)));
    list.append(item);
  }
  details.append(list);
  container.append(details);
}

function addAnswerActions(container, result, answerText) {
  const row = el('div', 'answer-actions');
  const copy = el('button', 'quiet-link', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(answerText); showToast('Answer copied.'); } catch { showToast('Copy failed.'); }
  });
  const remember = el('button', 'quiet-link', '＋ Remember');
  remember.type = 'button';
  remember.addEventListener('click', () => startRemember(answerText));
  row.append(copy, remember);
  if (!result.grounded) {
    const retry = el('button', 'quiet-link', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', () => { $('question').value = answerText; $('question').focus(); });
    row.append(retry);
  }
  container.append(row);
}

/* ---------- ask ---------- */

async function submitQuestion(text) {
  addMessage('user', text);
  const response = addMessage('assistant', 'Searching what it remembers…');
  const content = response.querySelector('.assistant-content');
  const answer = response.querySelector('.assistant-answer');
  const started = performance.now();
  $('ask-button').disabled = true;
  try {
    const mode = $('mode').value;
    const result = await api('/ask', { method: 'POST', body: JSON.stringify({ question: text, ...(mode && { mode }) }) });
    await refreshLedger();
    answer.classList.remove('pending');
    answer.textContent = result.answer;
    const meta = el('div', 'answer-meta');
    meta.textContent = `${result.mode || 'memory'} · ${((performance.now() - started) / 1000).toFixed(1)}s · ${result.grounded ? 'sources attached' : 'no source verified'}`;
    content.append(meta);
    addEvidence(content, result);
    if (result.trace?.length) addTrace(content, result.trace);
    addAnswerActions(content, result, result.answer);
    if (result.pendingAction) {
      const pending = el('div', 'pending-line');
      pending.append(el('span', 'pending-badge', 'Pending'));
      pending.append(el('span', '', result.pendingAction.summary));
      const review = el('button', 'quiet-link', 'Review');
      review.type = 'button';
      review.addEventListener('click', () => {
        proposeThenConfirm({
          kind: result.pendingAction.kind, payload: result.pendingAction.payload,
          title: 'Confirm action', noteText: result.pendingAction.summary, confirmLabel: 'Confirm',
        }).catch((e) => showToast(e.message));
      });
      pending.append(review);
      content.append(pending);
    }
  } catch (error) {
    answer.classList.remove('pending');
    answer.textContent = `I couldn't complete that question: ${error.message}`;
  } finally {
    $('ask-button').disabled = false;
    scrollToLatest();
    $('question').focus();
  }
}

/* ---------- health + refresh ---------- */

async function refreshHealth() {
  const status = $('server-status');
  try {
    const health = await api('/health');
    status.className = 'server-status ready';
    status.lastChild.textContent = ` ${health.model || 'Bonsai'} · ${health.retrievalMode}`;
  } catch {
    status.className = 'server-status offline';
    status.lastChild.textContent = ' Bonsai unavailable';
  }
}

async function refreshAll() {
  await Promise.allSettled([refreshInputs(), refreshLedger(), refreshPeople(), refreshHealth()]);
}

/* ---------- wiring ---------- */

$('input-text').addEventListener('input', () => { $('input-length').textContent = `${$('input-text').value.length} / 4,000`; });
$('input-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('input-text').value.trim();
  if (!text) return showToast('Write an input first.');
  const button = $('save-button');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const saved = await api('/input', { method: 'POST', body: JSON.stringify({ text }) });
    $('input-text').value = '';
    $('input-length').textContent = '0 / 4,000';
    await refreshInputs();
    await refreshLedger();
    showToast(`${saved.id} saved${saved.indexed ? ' · Bonsai indexed it' : ' · keyword searchable'}`);
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = 'Save input ↗'; }
});

$('question').addEventListener('input', () => { $('question').style.height = 'auto'; $('question').style.height = `${Math.min($('question').scrollHeight, 160)}px`; });
$('question').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('ask-form').requestSubmit(); }
});
$('ask-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('question').value.trim();
  if (!text) return;
  $('question').value = '';
  $('question').style.height = 'auto';
  submitQuestion(text);
});

$('ledger-search').addEventListener('input', () => {
  clearTimeout(ledgerTimer);
  ledgerTimer = setTimeout(() => refreshLedger().catch((e) => showToast(e.message)), 220);
});
$('ledger-person').addEventListener('change', () => refreshLedger().catch((e) => showToast(e.message)));
$('ledger-status').addEventListener('change', () => refreshLedger().catch((e) => showToast(e.message)));
$('ledger-add').addEventListener('click', () => startRemember());

$('photo-button').addEventListener('click', () => $('photo-input').click());
$('photo-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) return showToast('Choose an image file (PNG, JPEG, WebP or GIF).');
  if (file.size > 12 * 1024 * 1024) return showToast('That image is over the 12 MB limit.');
  showToast('Storing the photo and reading it locally…');
  try {
    const response = await fetch('/upload-photo', { method: 'POST', headers: { 'content-type': file.type }, body: new Uint8Array(await file.arrayBuffer()) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Upload failed');
    addPhotoLine(data);
    showToast(data.duplicate ? 'That photo is already stored.' : 'Photo stored and described.');
  } catch (error) { showToast(error.message); }
});

refreshAll();
