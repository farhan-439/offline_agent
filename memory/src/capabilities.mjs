// Retrieval capability detection.
//
// Bonsai embeddings are an *optional* runtime capability: the server is only useful for
// hybrid retrieval when it was launched with `--embeddings`. A real probe (one tiny
// /v1/embeddings request, cached per client) decides the mode, so a 501 degrades the app
// to BM25 instead of killing dock and ask.
export const MODES = ['bm25', 'hybrid', 'hybrid-rerank'];
export const DEFAULT_MODE = 'hybrid-rerank';

/** KINDRED_RETRIEVAL=bm25|hybrid|hybrid-rerank (+ aliases). null means "auto". */
export function requestedMode(env = process.env) {
  const raw = (env.KINDRED_RETRIEVAL ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto') return null;
  const alias = raw === 'hybrid+rerank' || raw === 'rerank' ? 'hybrid-rerank' : raw === 'keyword' ? 'bm25' : raw;
  if (!MODES.includes(alias)) throw new Error(`KINDRED_RETRIEVAL must be one of ${MODES.join(', ')} (got "${raw}")`);
  return alias;
}

/** Cached capability probe for a Bonsai client; plain scripted doubles report their own shape. */
export async function capabilitiesOf(bonsai) {
  if (!bonsai) return { embeddings: false, dim: null, reason: 'no model client' };
  if (typeof bonsai.capabilities === 'function') return bonsai.capabilities();
  const embeddings = typeof bonsai.embed === 'function';
  return { embeddings, dim: null, reason: embeddings ? null : 'client has no embeddings endpoint' };
}

/**
 * Resolve the mode actually used for this run.
 *  · no embedding capability        → bm25 (degraded when hybrid was requested)
 *  · KINDRED_RETRIEVAL=bm25         → bm25 ablation, even with vectors
 *  · otherwise                      → hybrid / hybrid-rerank
 */
export async function resolveMode(bonsai, { env = process.env } = {}) {
  const requested = requestedMode(env);
  const caps = await capabilitiesOf(bonsai);
  if (!caps.embeddings) {
    return { mode: 'bm25', requested: requested ?? 'auto', caps, degraded: requested != null && requested !== 'bm25' };
  }
  if (requested === 'bm25') return { mode: 'bm25', requested, caps, degraded: false };
  return { mode: requested ?? DEFAULT_MODE, requested: requested ?? 'auto', caps, degraded: false };
}

/** One-line human summary for logs, /health and evaluation output. */
export function describeMode({ mode, requested, caps, degraded }) {
  const dims = caps?.dim ? `, ${caps.dim}-dim` : '';
  const why = caps?.embeddings ? `bonsai embeddings${dims}` : `no embeddings (${caps?.reason ?? 'unavailable'})`;
  return `${mode}${degraded ? ' (degraded)' : ''} [requested: ${requested}; ${why}]`;
}
