// Model prices as data (addendum §6): a price change is one commit here. Integer micro-dollars per million tokens.
// Read from https://platform.claude.com/docs/en/about-claude/pricing on PRICES_AS_OF (footnote's config/prices.json,
// checked 2026-10-19), never from memory. A clone adds its other providers' models to this table.
export const PRICES_AS_OF = '2026-10-19';

export type Price = { inputPerMTok: number; outputPerMTok: number };

export const PRICES: Readonly<Record<string, Price>> = {
  'anthropic/claude-fable-5-1': { inputPerMTok: 10_000_000, outputPerMTok: 50_000_000 },
  'anthropic/claude-opus-5-5': { inputPerMTok: 4_000_000, outputPerMTok: 20_000_000 },
  'anthropic/claude-sonnet-5-5': { inputPerMTok: 2_000_000, outputPerMTok: 10_000_000 },
  'anthropic/claude-haiku-5-5': { inputPerMTok: 100_000, outputPerMTok: 500_000 },
};

/**
 * Cost of one call in micro-dollars, rounded up so the cap errs toward refusing. Throws on a model with no price:
 * an unpriced call would read as free and never reach the cap.
 * ponytail: input is priced at the full rate, so cache reads and long-context tiers are over-counted (the safe
 * direction for a cap); add per-tier fields when a clone needs exact invoices from this table.
 */
export function costMicros(provider: string, model: string, inputTokens: number, outputTokens: number): bigint {
  const p = PRICES[`${provider}/${model}`];
  if (!p) throw new Error(`No price for ${provider}/${model} in src/core/ai/prices.ts`);
  const raw = BigInt(inputTokens) * BigInt(p.inputPerMTok) + BigInt(outputTokens) * BigInt(p.outputPerMTok);
  return (raw + 999_999n) / 1_000_000n;
}
