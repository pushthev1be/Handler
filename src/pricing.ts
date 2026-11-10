// USD per million tokens, standard mode. Keep in sync with https://dev.meta.ai/docs/pricing-rate-limits
// The "-contributor" model IDs are deliberately absent: check Meta's terms for that mode before
// sending client data through it.
const PRICES: Record<string, { input: number; output: number; cachedInput: number }> = {
  "muse-spark-1.3": { input: 1.25, output: 4.25, cachedInput: 0.15 },
  "muse-spark-1.2": { input: 1.25, output: 4.25, cachedInput: 0.15 },
  "muse-wonder-1.0": { input: 4, output: 20, cachedInput: 0.2 },
  "muse-ember-1.0": { input: 0.1, output: 0.5, cachedInput: 0.004 }, // up to 200K input tokens
};

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

/** prompt_tokens includes cached tokens (OpenAI-compatible convention); those are billed at the cached rate. */
export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return ((u.prompt_tokens - cached) * p.input + cached * p.cachedInput + u.completion_tokens * p.output) / 1_000_000;
}
