/**
 * Cost tracking: token usage priced from a small static table, overridable per
 * model by the caller. Unknown models cost 0 (unknown), never a guess — a
 * fabricated price is worse than an absent one when a budget gate depends on it.
 */
import type { TokenUsage } from "./providers/types.js";

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * USD per million tokens. Entries are base names; pinned variants
 * (`claude-sonnet-4-5-20250929`) resolve by prefix.
 */
export const PRICE_TABLE: Record<string, Pricing> = {
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-opus-4-8": { inputPerMTok: 15, outputPerMTok: 75 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
};

export function pricingFor(
  model: string,
  override?: Pricing,
): Pricing | undefined {
  if (override) return override;
  if (PRICE_TABLE[model]) return PRICE_TABLE[model];
  // Match pinned variants like claude-sonnet-4-5-20250929. Longest prefix
  // wins so `claude-sonnet-4-5` never shadows a more specific future entry.
  const base = Object.keys(PRICE_TABLE)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return base ? PRICE_TABLE[base] : undefined;
}

export function costOfUsage(
  usage: TokenUsage | undefined,
  pricing: Pricing | undefined,
): number {
  if (!usage || !pricing) return 0;
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerMTok +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}

/** Sum the cost of a set of runs. Cached runs cost nothing — they made no call. */
export function costOfRuns(
  runs: { usage?: TokenUsage; cached?: boolean }[],
  pricing: Pricing | undefined,
): number {
  if (!pricing) return 0;
  let usd = 0;
  for (const run of runs) {
    if (!run.usage || run.cached) continue;
    usd += costOfUsage(run.usage, pricing);
  }
  return usd;
}
