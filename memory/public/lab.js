const $ = (id) => document.getElementById(id);
const inputForm = $('input-form');
const askForm = $('ask-form');
const inputText = $('input-text');
const question = $('question');
const messages = $('messages');
let toastTimer;

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
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
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
    head.append(el('span', '', item.id));
    const time = el('time', '', prettyDate(item.createdAt));
    time.dateTime = item.createdAt;
    head.append(time);
    card.append(head, el('p', '', item.text));
    list.append(card);
  }
}

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
  $('conversation').scrollTop = $('conversation').scrollHeight;
  return wrapper;
}

function addEvidence(container, result) {
  const sources = [
    ...(result.inputs || []).map((x) => ({ ref: x.id, text: x.text, label: 'Your input' })),
    ...(result.clips || []).map((x) => ({ ref: x.id, text: x.text, label: x.speaker || 'Original words' })),
    ...(result.photos || []).map((x) => ({ ref: x.id, text: x.caption || 'Stored photo', label: 'Photo' })),
  ];
  const box = el('section', 'evidence-box');
  const title = el('div', 'evidence-title', sources.length ? '✳  Evidence used' : '○  No evidence returned');
  title.append(el('span', 'evidence-count', `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`));
  box.append(title);
  if (!sources.length) box.append(el('div', 'evidence-empty', 'Bonsai did not cite a stored input for this answer. Treat it as unverified.'));
  for (const source of sources) {
    const item = el('div', 'evidence-item');
    item.append(el('div', 'evidence-ref', `${source.label}  ·  ${source.ref}`), el('p', '', source.text));
    box.append(item);
  }
  container.append(box);
}

inputText.addEventListener('input', () => { $('input-length').textContent = `${inputText.value.length} / 4,000`; });
inputForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputText.value.trim();
  if (!text) return showToast('Write an input first.');
  const button = $('save-button');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const saved = await api('/input', { method: 'POST', body: JSON.stringify({ text }) });
    inputText.value = '';
    $('input-length').textContent = '0 / 4,000';
    await refreshInputs();
    showToast(`${saved.id} saved${saved.indexed ? ' · Bonsai indexed it' : ' · keyword searchable'}`);
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = 'Save input ↗'; }
});

question.addEventListener('input', () => { question.style.height = 'auto'; question.style.height = `${Math.min(question.scrollHeight, 160)}px`; });
question.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); askForm.requestSubmit(); }
});
askForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = question.value.trim();
  if (!text) return;
  addMessage('user', text);
  const response = addMessage('assistant', 'Searching what you saved…');
  const content = response.querySelector('.assistant-content');
  const answer = response.querySelector('.assistant-answer');
  question.value = '';
  question.style.height = 'auto';
  $('ask-button').disabled = true;
  const started = performance.now();
  try {
    const mode = $('mode').value;
    const result = await api('/ask', { method: 'POST', body: JSON.stringify({ question: text, ...(mode && { mode }) }) });
    answer.classList.remove('pending');
    answer.textContent = result.answer;
    content.append(el('div', 'answer-meta', `${result.mode || 'memory'}  ·  ${((performance.now() - started) / 1000).toFixed(1)}s  ·  ${result.grounded ? 'source attached' : 'no source verified'}`));
    addEvidence(content, result);
    if (result.trace?.length) {
      const details = el('details', 'trace');
      details.append(el('summary', '', 'See how Bonsai searched'));
      details.append(el('pre', '', JSON.stringify(result.trace, null, 2)));
      content.append(details);
    }
  } catch (error) {
    answer.classList.remove('pending');
    answer.textContent = `I couldn't complete that question: ${error.message}`;
  } finally {
    $('ask-button').disabled = false;
    $('conversation').scrollTop = $('conversation').scrollHeight;
    question.focus();
  }
});

Promise.allSettled([refreshInputs(), refreshHealth()]);
