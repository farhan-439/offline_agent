// Bonsai-2 client for a local llama.cpp server (OpenAI-compatible API).
// Every call is grammar-constrained with a JSON schema, so a 4B ternary model
// cannot return malformed output — it can only be wrong, never unparseable.

export const SAMPLING = {
  // PrismML's recommended non-thinking profile for Bonsai-2 small models.
  temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5,
};

export class Bonsai {
  constructor({
    url = process.env.BONSAI_URL || 'http://127.0.0.1:8080/v1',
    model = process.env.BONSAI_MODEL || 'bonsai-4b',
    fetchFn = globalThis.fetch,
    timeoutMs = 120_000,
  } = {}) {
    Object.assign(this, { url: url.replace(/\/$/, ''), model, fetchFn, timeoutMs });
    this.calls = []; // trace for the UI / debugging: what Bonsai was asked and how long it took
  }

  async health() {
    const res = await this.fetchFn(`${this.url}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`Bonsai server answered ${res.status}`);
    const ids = (await res.json()).data?.map((m) => m.id) ?? [];
    return { ok: ids.includes(this.model), models: ids };
  }

  /** Ask for one JSON object matching `schema`. `name` labels the call in traces. */
  async json({ name, system, user, schema, maxTokens = 600, temperature }) {
    const t0 = Date.now();
    const res = await this.fetchFn(`${this.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: maxTokens,
        ...SAMPLING,
        ...(temperature != null && { temperature }),
        response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!res.ok) throw new Error(`Bonsai ${name} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    const body = await res.json();
    const text = body.choices?.[0]?.message?.content ?? '';
    const out = parseJson(text);
    this.calls.push({ name, ms: Date.now() - t0, promptChars: system.length + user.length, tokens: body.usage });
    if (out === undefined) throw new Error(`Bonsai ${name} returned non-JSON: ${text.slice(0, 200)}`);
    return out;
  }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return undefined;
}
