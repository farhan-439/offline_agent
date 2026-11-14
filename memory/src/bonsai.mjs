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
    this.caps = null; // cached /embeddings capability probe (see capabilities.mjs)
  }

  async health() {
    const res = await this.fetchFn(`${this.url}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`Bonsai server answered ${res.status}`);
    const ids = (await res.json()).data?.map((m) => m.id) ?? [];
    return { ok: ids.includes(this.model), models: ids };
  }

  /**
   * Is `/v1/embeddings` actually usable? Probed once with a real request and cached.
   * A server started without `--embeddings` answers 501; the caller then runs BM25-only.
   */
  async capabilities({ refresh = false } = {}) {
    if (this.caps && !refresh) return this.caps;
    const forced = (process.env.KINDRED_EMBED ?? '').trim();
    if (forced === '0') return (this.caps = { embeddings: false, dim: null, reason: 'KINDRED_EMBED=0' });
    try {
      const [v] = await this.embed(['kindred capability probe']);
      this.caps = { embeddings: true, dim: v.length, reason: null };
    } catch (e) {
      this.caps = { embeddings: false, dim: null, reason: e.message };
    }
    return this.caps;
  }

  /** Bonsai's own pooled hidden states, served by llama.cpp with --embeddings. */
  async embed(texts) {
    const input = Array.isArray(texts) ? texts : [texts];
    const t0 = Date.now();
    const res = await this.fetchFn(`${process.env.KINDRED_EMBED_URL?.replace(/\/$/, '') || this.url}/embeddings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({ model: this.model, input }),
    });
    if (!res.ok) throw new Error(`Bonsai embeddings failed: HTTP ${res.status}; start the server with --embeddings --pooling mean`);
    const body = await res.json();
    const vectors = (body.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.length !== input.length || vectors.some((v) => !Array.isArray(v) || !v.length)) throw new Error('Bonsai returned incomplete embeddings');
    this.calls.push({ name: 'embed', ms: Date.now() - t0, items: input.length, dim: vectors[0].length });
    return vectors;
  }

  /** Native Qwen-style tool call for the bounded memory paging loop. */
  async memoryAction({ system, user, final = false }) {
    const tools = [
      { type: 'function', function: { name: 'search_memory', description: 'Load relevant memories from the local store', parameters: {
        type: 'object', properties: { query: { type: 'string' }, person: { type: ['string', 'null'] } }, required: ['query'], additionalProperties: false,
      } } },
      { type: 'function', function: { name: 'open_episode', description: 'Read original conversation lines for an episode ref', parameters: {
        type: 'object', properties: { episode: { type: 'string' } }, required: ['episode'], additionalProperties: false,
      } } },
      { type: 'function', function: { name: 'answer_memory', description: 'Give a short answer supported by loaded memory refs', parameters: {
        type: 'object', properties: { answer: { type: 'string' }, cite: { type: 'array', items: { type: 'string' } } }, required: ['answer', 'cite'], additionalProperties: false,
      } } },
      { type: 'function', function: { name: 'play_original_clip', description: 'Play the original recording behind a cited memory ref', parameters: {
        type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false,
      } } },
      { type: 'function', function: { name: 'set_reminder', description: 'Propose a reminder (needs the user to confirm)', parameters: {
        type: 'object', properties: { text: { type: 'string' }, due: { type: ['string', 'null'] }, person: { type: ['string', 'null'] } }, required: ['text'], additionalProperties: false,
      } } },
      { type: 'function', function: { name: 'correct_memory', description: 'Propose correcting a memory (needs the user to confirm)', parameters: {
        type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'], additionalProperties: false,
      } } },
      { type: 'function', function: { name: 'forget_memory', description: 'Propose forgetting a memory or a person (needs the user to confirm)', parameters: {
        type: 'object', properties: { ref: { type: ['string', 'null'] }, person: { type: ['string', 'null'] }, query: { type: ['string', 'null'] } }, additionalProperties: false,
      } } },
    ];
    const t0 = Date.now();
    const res = await this.fetchFn(`${this.url}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({ model: this.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        tools, tool_choice: final ? { type: 'function', function: { name: 'answer_memory' } } : 'auto',
        max_tokens: 250, ...SAMPLING, temperature: 0.2, chat_template_kwargs: { enable_thinking: false } }),
    });
    if (!res.ok) throw new Error(`Bonsai memory tool failed: HTTP ${res.status}`);
    const body = await res.json();
    const call = body.choices?.[0]?.message?.tool_calls?.[0];
    this.calls.push({ name: 'memory_tool', tool: call?.function?.name ?? null, ms: Date.now() - t0, tokens: body.usage });
    if (!call) return null;
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { return null; }
    if (call.function.name === 'search_memory' && typeof args.query === 'string')
      return { action: 'search', query: args.query, person: args.person ?? null };
    if (call.function.name === 'open_episode' && typeof args.episode === 'string')
      return { action: 'open_episode', episode: args.episode };
    if (call.function.name === 'answer_memory' && typeof args.answer === 'string')
      return { action: 'answer', answer: args.answer, cite: Array.isArray(args.cite) ? args.cite : [] };
    if (['play_original_clip', 'set_reminder', 'correct_memory', 'forget_memory'].includes(call.function.name))
      return { action: 'tool', tool: call.function.name, args };
    return null;
  }

  /**
   * One image plus an instruction → JSON matching `schema`, using the model's vision projector.
   * `image` is a data URI so this stays local (no file:// or network fetch by llama.cpp).
   */
  async vision({ name = 'vision', system, user, image, schema, maxTokens = 700, temperature = 0.2 }) {
    const t0 = Date.now();
    const res = await this.fetchFn(`${this.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: [
            { type: 'text', text: user },
            { type: 'image_url', image_url: { url: image } },
          ] },
        ],
        max_tokens: maxTokens,
        ...SAMPLING,
        temperature,
        response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!res.ok) throw new Error(`Bonsai ${name} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    const body = await res.json();
    const text = body.choices?.[0]?.message?.content ?? '';
    const out = parseJson(text);
    this.calls.push({ name, ms: Date.now() - t0, kind: 'vision', tokens: body.usage });
    if (out === undefined) throw new Error(`Bonsai ${name} returned non-JSON: ${text.slice(0, 200)}`);
    return out;
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
