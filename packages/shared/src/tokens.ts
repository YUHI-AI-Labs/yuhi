/**
 * Token & reduction estimation.
 *
 * These are ESTIMATES unless an exact tokenizer is wired in. We deliberately do NOT
 * hard-code any vendor's prices; monetary figures appear only when a PricingProfile
 * is explicitly configured. The product claim is "maximum SAFE reduction while
 * preserving downstream task performance" — never "fewer tokens = better answers".
 */

/**
 * A token counter. The default is a rough heuristic; a model-specific tokenizer can
 * be injected later (e.g. per Ollama model) without changing call sites.
 */
export type TokenEstimator = (text: string) => number;

/** Rough heuristic: ~4 characters per token (English/code average). FALLBACK ONLY. */
export const estimateTokens: TokenEstimator = (text: string): number => {
  return Math.ceil(text.length / 4);
};

/** The estimator used unless one is injected. */
export let activeTokenEstimator: TokenEstimator = estimateTokens;

/** Swap in a model-specific tokenizer (returns the previous one). */
export function setTokenEstimator(fn: TokenEstimator): TokenEstimator {
  const prev = activeTokenEstimator;
  activeTokenEstimator = fn;
  return prev;
}

export interface TokenEstimate {
  chars: number;
  tokens: number;
  /** Always true until an exact tokenizer is configured. */
  approx: boolean;
}

export function tokenEstimate(text: string, estimator: TokenEstimator = activeTokenEstimator): TokenEstimate {
  return { chars: text.length, tokens: estimator(text), approx: estimator === estimateTokens };
}

/** Context budget: how aggressively to reduce, and what must be preserved. */
export type ReductionMode = "conservative" | "balanced" | "aggressive";

export interface ContextBudget {
  maxInputTokens?: number;
  reductionMode: ReductionMode;
  /** Kinds of content to preserve (e.g. requirements, errors, API signatures). */
  preserve: string[];
}

export const DEFAULT_BUDGET: ContextBudget = {
  reductionMode: "balanced",
  preserve: [],
};

/** A per-run summary of what preparation saved. Token values are estimates. */
export interface ReductionReport {
  beforeChars: number;
  afterChars: number;
  beforeTokens: number;
  afterTokens: number;
  /** Signed: negative = preparation produced MORE tokens than the source. */
  tokensSaved: number;
  /** Signed fraction; negative = increase. */
  percentReduction: number;
  /** false when beforeTokens === 0 (nothing to estimate). */
  hasData: boolean;
  approx: boolean;
  filesExcluded: number;
  filesSummarized: number;
  sensitiveMasked: number;
  sourceModified: number; // always 0 by invariant
}

export function reductionReport(input: {
  beforeChars: number;
  afterChars: number;
  /** Precomputed token counts (from an injected tokenizer). Falls back to chars/4. */
  beforeTokens?: number;
  afterTokens?: number;
  /** true = counts are estimates (default when tokens not provided). */
  approx?: boolean;
  filesExcluded?: number;
  filesSummarized?: number;
  sensitiveMasked?: number;
}): ReductionReport {
  const beforeTokens = input.beforeTokens ?? Math.ceil(input.beforeChars / 4);
  const afterTokens = input.afterTokens ?? Math.ceil(input.afterChars / 4);
  return {
    beforeChars: input.beforeChars,
    afterChars: input.afterChars,
    beforeTokens,
    afterTokens,
    // SIGNED and unclamped: negative tokensSaved / percentReduction means preparation
    // produced MORE tokens than the source (e.g. summarizing already-tiny content).
    // Callers must display an increase honestly and never fabricate a reduction.
    tokensSaved: beforeTokens - afterTokens,
    percentReduction: beforeTokens > 0 ? 1 - afterTokens / beforeTokens : 0,
    /** false when there was nothing to estimate (beforeTokens === 0) → show "unavailable". */
    hasData: beforeTokens > 0,
    approx: input.approx ?? input.beforeTokens === undefined,
    filesExcluded: input.filesExcluded ?? 0,
    filesSummarized: input.filesSummarized ?? 0,
    sensitiveMasked: input.sensitiveMasked ?? 0,
    sourceModified: 0,
  };
}

/** Optional, user-configured pricing. Core ships NO default prices. */
export interface PricingProfile {
  label: string;
  /** Cost per 1,000 input tokens, in `currency`. */
  inputPer1kTokens: number;
  currency: string;
}

export interface CostEstimate {
  amount: number;
  currency: string;
  approx: boolean;
}

/** Estimate cost for a token count under a configured pricing profile. */
export function estimateCost(tokens: number, profile: PricingProfile): CostEstimate {
  return {
    amount: (tokens / 1000) * profile.inputPer1kTokens,
    currency: profile.currency,
    approx: true,
  };
}
