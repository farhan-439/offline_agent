// A quiet review desk for Bonsai's proposed follow-through. No Apple app changes until Run.
import { spokenDetails } from './voice-run.mjs';
const label = { calendar: 'Calendar', reminders: 'Reminders', notes: 'Notes', contacts: 'Contacts' };
const node = (tag, className = '', text = '') => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
};

export function mountActions(api, { play }) {
  const list = document.querySelector('#action-list');
  const detail = document.querySelector('#action-detail');
  const status = document.querySelector('#actions-status');
  const scan = document.querySelector('#scan-actions');
  const run = document.querySelector('#run-actions');
  const runReview = document.querySelector('#run-review');
  let suggestions = [];
  let selected = null;
  const queue = new Map();
  const errors = new Map();
  let scanning = false;
  let stopScan = false;
  let running = false;

  const updateRun = () => {
    run.textContent = `Run reviewed (${queue.size})`;
    run.disabled = !queue.size || scanning || running;
  };

  const summaryFor = (a, edited) => [
    `${label[a.target]}: ${edited.title}`, `Source: ${a.source?.ref || a.payload.sourceRef || 'saved memory'}`,
    a.source?.source?.quote?.text ? `Original words: ${a.source.source.quote.text}` : null,
    edited.date ? `Date: ${edited.date}` : 'No date', edited.time ? `Time: ${edited.time}` : null,
    edited.times?.length ? `Daily times: ${edited.times.join(', ')}` : null,
    edited.place ? `Place: ${edited.place}` : null,
    edited.repeat && edited.repeat !== 'none' ? `Repeat: ${edited.repeat}, ${edited.occurrences || '?'} times` : null,
    edited.durationMinutes ? `Length: ${edited.durationMinutes} minutes` : null,
    edited.person ? `Contact: ${edited.person}` : null, edited.birthYear ? `Birth year: ${edited.birthYear}` : null,
    edited.details ? `Notes: ${edited.details}` : null,
  ].filter(Boolean).join('\n');

  const selectedDraft = () => suggestions.find((a) => a.id === selected);

  function listView() {
    updateRun();
    if (!suggestions.length) {
      list.replaceChildren(node('p', 'action-list-empty', 'No actions proposed yet. Select “Compile actions” to ask Bonsai to look through saved memories.'));
      detail.replaceChildren(node('p', 'action-detail-empty', 'A possible calendar event, reminder, note, or birthday will appear here with its source.'));
      return;
    }
    if (!selectedDraft()) selected = suggestions[0].id;
    list.replaceChildren(...suggestions.map((a) => {
      const row = node('button', 'action-row');
      row.type = 'button';
      row.setAttribute('aria-current', String(a.id === selected));
      const state = a.status === 'proposed' && queue.has(a.id) ? 'queued' : a.status;
      row.append(node('span', `action-pill ${state}`, a.status === 'added' ? `Added to ${label[a.target]}` : a.status === 'exporting' ? 'Check Mac app' : errors.has(a.id) ? 'Needs attention' : state === 'queued' ? 'Ready to run' : label[a.target]),
        node('strong', '', a.payload.title || 'Untitled action'),
        node('small', '', `${a.source?.person?.name || 'Saved memory'} · ${a.payload.date || 'date to review'}`));
      row.addEventListener('click', () => { if (!runReview.hidden || running) return; selected = a.id; listView(); });
      return row;
    }));
    detailView();
  }

  const field = (form, name, caption, value = '', { type = 'text', wide = false, placeholder = '' } = {}) => {
    const wrap = node('label', wide ? 'wide' : '', caption);
    const input = type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
    if (type !== 'textarea') input.type = type;
    input.name = name;
    input.value = value ?? '';
    input.placeholder = placeholder;
    wrap.append(input); form.append(wrap);
    return input;
  };

  function detailView() {
    const a = selectedDraft();
    if (!a) return;
    const d = a.payload || {};
    detail.replaceChildren();
    detail.append(node('h3', '', d.title || 'Untitled action'),
      node('p', 'lead', a.status === 'added' ? `Added to ${label[a.target]}.` : a.status === 'exporting'
        ? 'This may already be in the Mac app. Check there before trying again.'
        : `Proposed for ${label[a.target]}. Edit the details, then review the exact result.`));

    const source = node('section', 'action-source');
    source.append(node('strong', '', `Source ${a.source?.ref || d.sourceRef || ''}`),
      node('p', '', a.source?.text || 'The source fact is no longer available.'));
    if (a.source?.source?.quote?.text) source.append(node('small', '', `Original words: “${a.source.source.quote.text}”`));
    const quote = a.source?.source?.quote;
    if (quote?.audioUrl) {
      const button = node('button', '', 'Play original clip'); button.type = 'button';
      button.addEventListener('click', () => play({ url: quote.audioUrl, start: quote.start, end: quote.end }));
      source.append(button);
    }
    detail.append(source);
    if (a.status === 'added' || a.status === 'exporting') {
      const open = node('button', 'review-btn', `Open ${label[a.target]}`); open.type = 'button';
      open.addEventListener('click', async () => {
        try {
          const r = await api.openActionApp(a.target);
          status.textContent = r.ok ? `Opened ${label[a.target]}.` : r.error || `Could not open ${label[a.target]}.`;
        } catch (error) { status.textContent = error.message || `Could not open ${label[a.target]}.`; }
      });
      detail.append(open);
    }
    if (a.status !== 'proposed') return;
    if (errors.has(a.id)) detail.append(node('p', 'action-error', `${errors.get(a.id)} Check the Mac app before reviewing this again.`));
    if (queue.has(a.id)) {
      const ready = node('section', 'action-confirm');
      ready.append(node('strong', '', 'Ready for Run'), node('p', '', summaryFor(a, queue.get(a.id))));
      const edit = node('button', 'cancel', 'Edit this action'); edit.type = 'button';
      edit.addEventListener('click', () => { if (!runReview.hidden || running) return; queue.delete(a.id); updateRun(); detailView(); });
      ready.append(edit); detail.append(ready);
      return;
    }

    const form = node('form', 'action-form');
    field(form, 'title', 'Title', d.title, { wide: true });
    if (a.target !== 'notes') field(form, 'date', a.target === 'contacts' ? 'Birthday month and day' : 'Date', d.date, { type: 'date' });
    if (a.target === 'calendar' || a.target === 'reminders') field(form, 'time', a.target === 'calendar' ? 'Start time' : 'Due time (optional)', d.time, { type: 'time' });
    if (a.target === 'calendar') {
      field(form, 'place', 'Place', d.place);
      field(form, 'durationMinutes', 'Event length in minutes', '', { type: 'number', placeholder: 'Choose a length' });
    }
    if (a.target === 'reminders') {
      if (Number(d.timesPerDay || 1) > 1) {
        field(form, 'times', `${d.timesPerDay} daily times (comma-separated)`, '', { wide: true, placeholder: 'Enter exact times, e.g. 08:00, 14:00, 20:00' });
        form.append(node('p', 'hint', 'The recording did not give clock times. Choose them yourself; Pebble will not guess a medicine schedule.'));
      }
      const repeat = node('label', '', 'Repeat');
      const select = document.createElement('select'); select.name = 'repeat';
      for (const [value, name] of [['none', 'Do not repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['yearly', 'Yearly']]) {
        const option = document.createElement('option'); option.value = value; option.textContent = name;
        option.selected = value === (d.repeat || 'none'); select.append(option);
      }
      repeat.append(select); form.append(repeat);
      field(form, 'occurrences', 'Number of times (if repeating)', d.duration || '', { type: 'number', placeholder: 'Choose an end count' });
    }
    if (a.target === 'contacts') {
      field(form, 'person', 'Exact name in Contacts', d.person || '');
      field(form, 'birthYear', 'Actual birth year', '', { type: 'number', placeholder: 'Required; not inferred' });
      form.append(node('p', 'hint', 'A birthday mention gives a month and day, not a birth year. Enter the year only if you know it.'));
    }
    field(form, 'details', a.target === 'notes' ? 'Note' : 'Notes', d.details || '', { type: 'textarea', wide: true });
    const review = node('button', 'review-btn', 'Review before adding'); review.type = 'submit'; form.append(review);
    detail.append(form);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const edited = { ...data, timesPerDay: Number(d.timesPerDay || 1),
        times: String(data.times || '').split(',').map((s) => s.trim()).filter(Boolean) };
      const prior = detail.querySelector('.action-confirm'); if (prior) prior.remove();
      const box = node('section', 'action-confirm');
      const summary = summaryFor(a, edited);
      box.append(node('strong', '', 'Confirm this exact action'), node('p', '', summary));
      const buttons = node('div', 'buttons');
      const add = node('button', '', 'Queue for Run'); add.type = 'button';
      const cancel = node('button', 'cancel', 'Edit'); cancel.type = 'button';
      cancel.addEventListener('click', () => box.remove());
      add.addEventListener('click', async () => {
        if (running || scanning || !runReview.hidden) return;
        add.disabled = true; add.textContent = 'Checking…';
        let result;
        try { result = await api.validateAction(a.id, edited); }
        catch (error) { result = { ok: false, error: error.message }; }
        if (!result.ok) {
          add.disabled = false; add.textContent = 'Queue for Run';
          const old = box.querySelector('.error'); if (old) old.remove();
          box.append(node('p', 'error', result.error || 'Review the missing details.'));
          return;
        }
        errors.delete(a.id);
        queue.set(a.id, edited);
        status.textContent = `${queue.size} reviewed action${queue.size === 1 ? '' : 's'} ready. Run will show them together before adding anything.`;
        listView();
      });
      buttons.append(add, cancel); box.append(buttons); detail.append(box);
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  async function load() {
    const r = await api.actionSuggestions();
    if (!r.ok) { status.textContent = r.error || 'Memory is unavailable.'; return; }
    suggestions = r.value.suggestions || [];
    for (const id of queue.keys()) if (!suggestions.some((a) => a.id === id && a.status === 'proposed')) queue.delete(id);
    status.textContent = `${suggestions.filter((a) => a.status === 'proposed').length} to review · ${suggestions.filter((a) => a.status === 'added').length} added`;
    listView();
  }

  async function scanMemories() {
    if (running || !runReview.hidden) return;
    if (scanning) { stopScan = true; status.textContent = 'Stopping after the current batch…'; return; }
    scanning = true; stopScan = false; scan.textContent = 'Stop after batch'; updateRun();
    let checked = 0, found = 0, complete = false;
    try {
      while (!stopScan) {
        status.textContent = `Bonsai is compiling actions… ${checked} memories checked.`;
        const r = await api.scanActions();
        if (!r.ok) throw new Error(r.error || 'Could not scan memories.');
        checked += r.value.scanned || 0;
        found += r.value.added || 0;
        suggestions = r.value.suggestions || [];
        listView();
        if (!r.value.scanned) { complete = true; break; }
      }
      status.textContent = `${checked} memories checked · ${found} actions found${complete ? ' · all saved facts checked' : ' · stopped'}.`;
    } catch (error) { status.textContent = `${checked} memories checked. ${error.message || 'Could not continue scanning.'}`; }
    finally { scanning = false; stopScan = false; scan.textContent = 'Compile actions'; updateRun(); }
  }
  scan.addEventListener('click', scanMemories);

  run.addEventListener('click', () => {
    if (!queue.size || scanning || running || !runReview.hidden) return;
    const ready = [...queue.entries()].map(([id, edited]) => ({ draft: suggestions.find((a) => a.id === id), edited }))
      .filter((x) => x.draft?.status === 'proposed');
    if (!ready.length) { queue.clear(); updateRun(); return; }
    runReview.replaceChildren(node('h3', '', `Run ${ready.length} reviewed action${ready.length === 1 ? '' : 's'}?`),
      node('p', '', 'These exact items will be added to the listed Mac apps, one at a time.'));
    const items = node('ol');
    for (const { draft, edited } of ready) items.append(node('li', '', summaryFor(draft, edited)));
    runReview.append(items);
    const buttons = node('div', 'buttons');
    const confirm = node('button', '', `Run ${ready.length} action${ready.length === 1 ? '' : 's'}`); confirm.type = 'button';
    const cancel = node('button', 'cancel', 'Back to review'); cancel.type = 'button';
    cancel.addEventListener('click', () => { runReview.hidden = true; });
    confirm.addEventListener('click', () => perform(ready, { confirm, cancel }));
    buttons.append(confirm, cancel); runReview.append(buttons); runReview.hidden = false;
    runReview.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  /** The one loop that touches a Mac app. Shared by the Run button and by saying "run". */
  async function perform(ready, { confirm = null, cancel = null } = {}) {
    running = true; run.disabled = true; scan.disabled = true;
    if (confirm) confirm.disabled = true;
    if (cancel) cancel.disabled = true;
    let added = 0, failed = 0;
    for (const { draft, edited } of ready) {
      status.textContent = `Running ${added + failed + 1} of ${ready.length}: ${edited.title}…`;
      try {
        const r = await api.addAction(draft.id, edited);
        if (!r.ok) throw new Error(r.error || 'The Mac app could not add this action.');
        added++;
        if (r.value.trackingError) errors.set(draft.id, 'Added in the Mac app, but Pebble could not update its status.');
      } catch (error) {
        failed++;
        errors.set(draft.id, error.message || 'The action failed.');
      }
      queue.delete(draft.id);
      try { await load(); } catch (error) { errors.set(draft.id, `Could not refresh the board: ${error.message}`); }
    }
    running = false; scan.disabled = false; runReview.hidden = true; updateRun(); listView();
    status.textContent = `${added} added to Mac apps · ${failed} need attention. Select an item to see its result.`;
    return { added, failed };
  }

  /**
   * "Run" heard out loud. Reviewed items go first; otherwise the newest proposal is used with
   * whatever date/time the owner actually said. If a detail is still missing, nothing is added
   * to a Mac app — the form opens and says what is missing.
   */
  async function runFromVoice(phrase = '') {
    if (scanning || running) return { ok: false, error: 'Pebble is already busy.' };
    if (!runReview.hidden) return { ok: false, error: 'Finish the confirmation on screen first.' };

    if (queue.size) {
      const ready = [...queue.entries()].map(([id, edited]) => ({ draft: suggestions.find((a) => a.id === id), edited }))
        .filter((x) => x.draft?.status === 'proposed');
      if (ready.length) {
        const result = await perform(ready);
        return { ok: result.failed === 0, added: result.added, failed: result.failed };
      }
    }

    const draft = suggestions.find((a) => a.status === 'proposed');
    if (!draft) {
      status.textContent = 'Nothing to run yet. Compile actions first.';
      return { ok: false, error: 'No action is waiting.' };
    }

    selected = draft.id;
    // "for five days" is stored as the draft's duration; the export calls that occurrences.
    const counted = draft.target === 'reminders' && draft.payload?.duration
      ? { occurrences: draft.payload.duration }
      : {};
    const edited = { ...draft.payload, ...counted, ...spokenDetails(phrase, draft) };
    let checked;
    try { checked = await api.validateAction(draft.id, edited); }
    catch (error) { checked = { ok: false, error: error.message }; }
    if (!checked.ok) {
      listView();
      status.textContent = `${draft.payload?.title || 'This action'} needs one more detail: ${checked.error}`;
      return { ok: false, error: checked.error, needsDetail: true };
    }
    const result = await perform([{ draft, edited }]);
    return { ok: result.failed === 0, added: result.added, failed: result.failed };
  }

  return { load, scan: scanMemories, runFromVoice };
}
