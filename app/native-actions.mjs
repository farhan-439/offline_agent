// Local Apple-app export. No shell interpolation, network request, or background write.
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const nativeDir = path.join(import.meta.dirname, 'native');
const binary = path.resolve(import.meta.dirname, '../data/bin/pebble-actions');
const source = path.join(nativeDir, 'pebble-actions.swift');
const plist = path.join(nativeDir, 'Info.plist');

function run(command, args, input = '', timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('The Mac action timed out.')); }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${path.basename(command)} exited ${code}`));
    });
    child.stdin.end(input);
  });
}

async function helper() {
  if (!existsSync(binary) || statSync(binary).mtimeMs < Math.max(statSync(source).mtimeMs, statSync(plist).mtimeMs)) {
    mkdirSync(path.dirname(binary), { recursive: true });
    await run('/usr/bin/swiftc', [source, '-o', binary, '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist]);
  }
  return binary;
}

const dateOK = (s) => /^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(String(s || ''))
  && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
const timeOK = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
const html = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Reviewed fields are checked again in the main process before touching an Apple app. */
export function validateExport(target, details) {
  if (!['calendar', 'reminders', 'notes', 'contacts'].includes(target)) throw new Error('Unsupported action destination.');
  const title = String(details.title || '').trim();
  if (!title || title.length > 120) throw new Error('Add a title of up to 120 characters.');
  const date = details.date || null;
  const time = details.time || null;
  if (date && !dateOK(date)) throw new Error('Use a valid date in YYYY-MM-DD format.');
  if (time && !timeOK(time)) throw new Error('Use a valid time in HH:MM format.');
  const times = Array.isArray(details.times) ? details.times.filter(Boolean) : [];
  if (times.length > 8 || times.some((t) => !timeOK(t))) throw new Error('Review each daily time in HH:MM format.');
  const repeatRule = details.repeat || 'none';
  if (!['none', 'daily', 'weekly', 'yearly'].includes(repeatRule)) throw new Error('Invalid repeat pattern.');
  const occurrences = Number(details.occurrences || 0);
  if (repeatRule !== 'none' && (!date || !Number.isInteger(occurrences) || occurrences < 1 || occurrences > 366))
    throw new Error('Repeating actions need a start date and a number of occurrences (1–366).');
  if (target === 'calendar' && (!date || !time)) throw new Error('A Calendar event needs a reviewed date and time.');
  const durationMinutes = Number(details.durationMinutes);
  if (target === 'calendar' && (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480))
    throw new Error('Choose an event length between 15 and 480 minutes.');
  if (target === 'reminders' && Number(details.timesPerDay || 1) > 1 && times.length !== Number(details.timesPerDay))
    throw new Error('Enter every daily time shown in the memory before adding reminders.');
  if (target === 'reminders' && Number(details.timesPerDay || 1) > 1 && (repeatRule !== 'daily' || !date || !occurrences))
    throw new Error('A multiple-times-per-day reminder needs a start date and daily end count.');
  if (target === 'contacts' && (!date || !details.person || !Number.isInteger(Number(details.birthYear))
    || Number(details.birthYear) < 1900 || Number(details.birthYear) > new Date().getFullYear()))
    throw new Error('Confirm the exact contact name and birth year before changing Contacts.');
  return { target, title, date, time, times, repeatRule, occurrences,
    details: String(details.details || '').trim().slice(0, 3000), place: String(details.place || '').trim().slice(0, 200),
    person: String(details.person || '').trim(), birthYear: Number(details.birthYear || 0),
    durationMinutes: target === 'calendar' ? durationMinutes : null,
    timesPerDay: Number(details.timesPerDay || 1) };
}

export async function exportAction(target, details) {
  const a = validateExport(target, details);
  if (target === 'calendar' || target === 'reminders' || target === 'contacts') {
    const out = await run(await helper(), [], JSON.stringify(a));
    return { ids: JSON.parse(out).ids, app: ({ calendar: 'Calendar', reminders: 'Reminders', contacts: 'Contacts' })[target] };
  }
  if (target === 'notes') {
    const body = `<h1>${html(a.title)}</h1><p>${html(a.details).replace(/\n/g, '<br>')}</p>`;
    const id = await run('/usr/bin/osascript', [path.join(nativeDir, 'note.applescript'), a.title, body]);
    return { ids: [id], app: 'Notes' };
  }
}
