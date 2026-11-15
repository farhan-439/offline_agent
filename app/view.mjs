// Pure display helpers shared by the renderer and the tests.

export function voiceLabel(v) {
  if (v.owner) return 'You';
  if (v.name) return v.name;
  if (v.error) return `${v.speaker}: couldn't check`;
  return v.checked ? `${v.speaker}: not someone I know yet` : `${v.speaker}: listening…`;
}

/** The People screen's "Teach Kindred my voice" button. `known`: the owner already has a voice sample. */
export function enrollButtonState(recording = {}, capture = {}, known = false) {
  const enrolling = recording.mode === 'enroll';
  const busy = recording.phase && recording.phase !== 'idle';
  if (enrolling && recording.phase === 'starting') return { label: 'Done reading', reading: true, disabled: false, hint: 'Getting the microphone ready…' };
  if (enrolling && recording.phase === 'recording') return { label: 'Done reading', reading: true, disabled: false, hint: 'Read the passage aloud, then press Done.' };
  if (enrolling && recording.phase === 'processing') return { label: 'Saving your voice…', reading: false, disabled: true, hint: 'Working out your voiceprint, on this Mac.' };
  if (busy) return { label: 'Teach Kindred my voice', reading: false, disabled: true, hint: 'Stop the recording on the Record screen first.' };
  if (!capture.available) return { label: 'Teach Kindred my voice', reading: false, disabled: true, hint: capture.message || 'Capture is not available.' };
  return known
    ? { label: 'Record my voice again', reading: false, disabled: false, hint: 'Kindred knows your voice. Recording again in a different room makes it more reliable.' }
    : { label: 'Teach Kindred my voice', reading: false, disabled: false, hint: "So Kindred knows when it's you talking and never whispers about you. Takes about 20 seconds; record alone." };
}

export function recordButtonState(phase, capture = {}) {
  if (phase === 'starting') return { label: 'Stop', hint: 'Getting the microphone ready…', disabled: false, pressed: true };
  if (phase === 'recording') return { label: 'Stop', hint: 'Recording. Tap to stop.', disabled: false, pressed: true };
  if (phase === 'processing') return { label: 'Saving…', hint: 'Writing down what was said, on this Mac.', disabled: true, pressed: false };
  if (!capture.available) return { label: 'Start recording', hint: capture.message || 'Capture is not available.', disabled: true, pressed: false };
  return { label: 'Start recording', hint: 'Tap to start. Tap again to stop.', disabled: false, pressed: false };
}

export function dockSummary(r = {}) {
  const n = (x, one, many) => `${x ?? 0} ${x === 1 ? one : many}`;
  const sessions = Array.isArray(r.sessions) ? r.sessions.length : r.sessions;
  if (!sessions) return 'Nothing new to dock. Memory is up to date.';
  return `Docked ${n(sessions, 'conversation', 'conversations')}: ${n(r.episodes, 'topic', 'topics')}, ${n(r.facts, 'new fact', 'new facts')}.`;
}

export function formatClipTime(c) {
  const t = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const day = c.date ? c.date.slice(0, 10) : '';
  const span = Number.isFinite(c.start) ? `${t(c.start)}${Number.isFinite(c.end) ? `–${t(c.end)}` : ''}` : '';
  return [day, span].filter(Boolean).join(' · ');
}

const ACTIVE = new Set(['starting', 'recording', 'processing']);

/**
 * The orb menu: one entry point with three choices. Recording and live translation share the
 * one microphone with voice questions, so while one runs the others explain why they're unavailable.
 * Returns { active: null | 'conversation' | 'translate' | 'enroll' | 'ask', record, ask, translate }.
 */
export function orbMenuState(snap = {}) {
  const rec = snap.recording || {};
  const capture = snap.capture || {};
  const askPhase = snap.ask?.phase || 'idle';
  const running = ACTIVE.has(rec.phase) ? (rec.mode || 'conversation') : null;
  const asking = askPhase !== 'idle';
  const active = running || (asking ? 'ask' : null);
  const noCapture = !capture.available;
  const off = (label, hint) => ({ label, hint, disabled: true });
  const why = running === 'translate' ? 'Stop translating first.' : running === 'enroll' ? 'Finish recording your voice first.'
    : running ? 'Stop recording first.' : asking ? 'Finish your question first.' : null;
  const record = running === 'conversation'
    ? { label: rec.phase === 'processing' ? 'Saving the conversation…' : 'Stop recording', hint: 'Everyone nearby is being recorded.', disabled: rec.phase === 'processing', stop: true }
    : noCapture ? off('Start recording', capture.message || 'Capture is not available.')
    : why ? off('Start recording', why)
    : { label: 'Start recording', hint: 'Remember a conversation. Kindred whispers who people are.', disabled: false };
  const translate = running === 'translate'
    ? { label: rec.phase === 'processing' ? 'Saving the conversation…' : 'Stop translating', hint: 'Translating what people say into English.', disabled: rec.phase === 'processing', stop: true }
    : noCapture ? off('Live translation', capture.message || 'Capture is not available.')
    : why ? off('Live translation', why)
    : { label: 'Live translation', hint: 'Hear other languages in English, and remember the conversation.', disabled: false };
  const ask = running ? off('Ask a question', why)
    : { label: 'Ask a question', hint: 'Type or say it. Kindred answers from your memories.', disabled: false };
  return { active, record, ask, translate };
}

/**
 * What did the person mean? A tap on the pebble starts listening, and what it hears is routed.
 * Returns { kind: 'record' | 'translate' | 'ask', text }, or { kind: null } when nothing is clear —
 * then the three sub-buttons stay on screen and the person picks one.
 */
export function routeIntent(text) {
  const said = String(text || '').trim();
  if (!said) return { kind: null, text: '' };
  const t = ` ${said.toLowerCase()} `;
  if (/\b(translat|interpret)/.test(t)) return { kind: 'translate', text: said };
  if (/\b(record|recording|capture|log this|note this|take (a )?notes?|remember this (conversation|chat))\b/.test(t)) {
    return { kind: 'record', text: said };
  }
  if (/\?\s*$/.test(said) || /^\s*(what|who|when|where|why|how|did|do|does|is|are|was|were|can|could|should|tell me|remind)/.test(t)) {
    return { kind: 'ask', text: said };
  }
  // A whole sentence that is neither a command nor a question is still most likely something to answer.
  if (said.split(/\s+/).length >= 4) return { kind: 'ask', text: said };
  return { kind: null, text: said };
}

/** "fr" → "French" (falls back to the code). */
export function languageName(code) {
  if (!code) return 'Another language';
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
}

/** "1:05" for the orb's recording timer. */
export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

import { replyLanguage } from './translate.mjs';

/** Two-way: the Reply button in the Live translation card. hidden outside Live translation. */
export function replyButtonState(rec = {}) {
  if (rec.mode !== 'translate' || rec.phase !== 'recording') return { hidden: true };
  const reply = rec.reply || { phase: 'idle' };
  const target = reply.language || [...(rec.translations || [])].reverse().map((t) => replyLanguage(t.language)).find(Boolean) || null;
  const lang = target ? languageName(target) : null;
  switch (reply.phase) {
    case 'listening': return { label: `■ Done, say it in ${lang}`, hint: 'Speak your reply in English, then press Done.', listening: true, disabled: false };
    case 'transcribing': return { label: 'Writing down your reply…', hint: '', disabled: true };
    case 'translating': return { label: `Translating into ${lang}…`, hint: 'Bonsai is translating, on this Mac.', disabled: true };
    case 'speaking': return { label: `Saying it in ${lang}…`, hint: '', disabled: true };
  }
  if (!target) return { label: '🎙 Reply', hint: reply.error || 'Reply works once Kindred hears German, Chinese, Spanish or French.', disabled: true };
  return { label: `🎙 Reply in ${lang}`, hint: reply.error || `Say it in English. Kindred says it in ${lang}, out loud.`, disabled: false, language: target };
}

/** Live translation card: what they said and what you replied, newest first. */
export function conversationLines(rec = {}, n = 4) {
  const theirs = (rec.translations || []).map((t) => ({ kind: 'heard', ...t }));
  const yours = (rec.replies || []).map((r) => ({ kind: 'reply', ...r }));
  // Same timestamp: a reply always answers what was heard, so it goes on top.
  return [...theirs, ...yours].sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || (a.kind === 'reply' ? -1 : b.kind === 'reply' ? 1 : 0)).slice(0, n);
}
