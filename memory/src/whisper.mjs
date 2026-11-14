// Live "who is this?": voiceprint → person → one short line to whisper in the owner's ear.
// Latency matters here, so the line is built from core memory (already summarised at dock time)
// and Bonsai only rephrases it; if Bonsai is slow or down, the template is spoken instead.
import { identify } from './identity.mjs';

const SCHEMA = { type: 'object', additionalProperties: false, required: ['line'], properties: { line: { type: 'string', maxLength: 220 } } };
const SYSTEM = `Write one gentle reminder, under 30 words, that will be whispered to the owner the moment this person starts talking.
Start with "This is <name>" and their relation, then the single most useful thing to remember right now (an upcoming plan, a promise the owner made, or health news). No greetings.`;

export function templateLine(person, facts) {
  const lead = `This is ${person.name}${person.relation ? `, your ${person.relation.replace(/^(your|the owner's)\s+/i, '')}` : ''}.`;
  const f = facts[0];
  return f ? `${lead} ${f.text}${f.when_text && !f.text.includes(f.when_text) ? ` (${f.when_text})` : ''}.`.replace(/\.\.$/, '.') : lead;
}

export async function whoIsThis(db, bonsai, voiceprint, { timeoutMs = 4000 } = {}) {
  const { person, score } = identify(db, voiceprint);
  if (!person || person.isOwner) return { personId: person?.id ?? null, name: person?.name ?? null, score, whisper: null, owner: !!person?.isOwner };
  const row = db.prepare('SELECT * FROM people WHERE id = ?').get(person.id);
  const facts = db.prepare(`SELECT kind, text, when_text FROM facts WHERE person_id = ? AND status = 'active'
    ORDER BY CASE kind WHEN 'promise_by_owner' THEN 0 WHEN 'plan' THEN 1 WHEN 'health' THEN 2 ELSE 3 END, observed_at DESC LIMIT 4`).all(person.id);
  let whisper = templateLine(row, facts);
  if (bonsai && (row.core || facts.length)) {
    try {
      const out = await Promise.race([
        bonsai.json({ name: 'whisper', system: SYSTEM, schema: SCHEMA, maxTokens: 80, temperature: 0.3,
          user: `Person: ${row.name} (${row.relation ?? 'relation unknown'})\nCore memory: ${row.core ?? '-'}\nFacts:\n${facts.map((f) => `- [${f.kind}] ${f.text}${f.when_text ? ` (${f.when_text})` : ''}`).join('\n')}` }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('whisper timeout')), timeoutMs)),
      ]);
      if (out.line?.trim()) whisper = out.line.trim();
    } catch { /* template already set */ }
  }
  return { personId: person.id, name: row.name, score, whisper };
}
