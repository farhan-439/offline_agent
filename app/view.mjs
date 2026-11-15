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
