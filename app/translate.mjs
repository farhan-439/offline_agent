// Two-way translation, the "you reply" half: the owner's English → the other person's language,
// by the local Bonsai 4B server (the same one memory uses; called directly, memory code untouched).
// Argmax then speaks the result (capture `speak` with a language).
//
// Limited to the four languages that held up in the 11/15 feasibility test (Bonsai → Argmax TTS →
// Whisper back-translation): German 9/10, Chinese ~7/10, Spanish and French ~6/10 + partial matches.
// Italian, Portuguese, Japanese, Korean and Russian got allergens, days or "who is speaking" wrong too often.

export const REPLY_LANGUAGES = { de: 'German', zh: 'Simplified Chinese', es: 'Spanish', fr: 'French' };

/** "fr", "fr-CA", "zh-Hans" → the supported reply language code, or null. */
export function replyLanguage(code) {
  const base = String(code ?? '').toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(REPLY_LANGUAGES, base) ? base : null;
}

// One worked example per language. In testing it fixed most "Can you help me?" → "Can I help you?"
// flips and dropped words (allergens, days).
const EXAMPLE_EN = 'Can you help me find my hotel? I am allergic to shellfish.';
const EXAMPLE = {
  es: '¿Puede ayudarme a encontrar mi hotel? Soy alérgico a los mariscos.',
  fr: "Pouvez-vous m'aider à trouver mon hôtel ? Je suis allergique aux fruits de mer.",
  de: 'Können Sie mir helfen, mein Hotel zu finden? Ich bin allergisch gegen Meeresfrüchte.',
  zh: '您能帮我找到我的酒店吗？我对贝类过敏。',
};
const SCHEMA = { type: 'object', additionalProperties: false, required: ['translation'], properties: { translation: { type: 'string', minLength: 1, maxLength: 400 } } };

/** English → language. Resolves { translation, ms }. Throws with a readable message if Bonsai is down. */
export async function translateReply(text, language, {
  url = process.env.BONSAI_URL || 'http://127.0.0.1:8080/v1',
  model = process.env.BONSAI_MODEL || 'bonsai-4b',
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
} = {}) {
  const lang = replyLanguage(language);
  if (!lang) throw new Error(`Replies work in ${Object.values(REPLY_LANGUAGES).join(', ')}.`);
  const english = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!english) throw new Error('Nothing to translate.');
  const name = REPLY_LANGUAGES[lang];
  const t0 = performance.now();
  let res;
  try {
    res = await fetchImpl(`${url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model, temperature: 0, top_p: 0.8, top_k: 20, min_p: 0, max_tokens: 220,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: 'json_schema', json_schema: { name: 'translation', strict: true, schema: SCHEMA } },
        messages: [
          { role: 'system', content: `You are an interpreter. An English speaker is talking to a ${name} speaker. Translate their words into polite spoken ${name}, as the same speaker: "I/me/my" stays the speaker and "you" stays the listener. A question stays the same question. Translate every word that carries meaning: food, allergies, days, times, doses, names. Keep numbers exact. Do not add or drop anything.` },
          { role: 'user', content: EXAMPLE_EN },
          { role: 'assistant', content: JSON.stringify({ translation: EXAMPLE[lang] }) },
          { role: 'user', content: english },
        ],
      }),
    });
  } catch (e) {
    throw new Error(`Bonsai isn't reachable for translation (${e.name === 'TimeoutError' ? 'timed out' : e.message}). Is it running on :8080?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Bonsai translation failed: ${data.error?.message || res.status}`);
  let translation = '';
  try { translation = String(JSON.parse(data.choices[0].message.content).translation || '').trim(); } catch { /* below */ }
  if (!translation) throw new Error('Bonsai returned no translation.');
  return { translation, language: lang, ms: Math.round(performance.now() - t0) };
}
