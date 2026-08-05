/**
 * Token & reduction estimation (v0.4.8 Phase 5: Measurement Reliability).
 *
 * These are ESTIMATES unless an exact tokenizer is wired in. We deliberately do NOT
 * hard-code any vendor's prices; monetary figures appear only when a PricingProfile
 * is explicitly configured. The product claim is "maximum SAFE reduction while
 * preserving downstream task performance" — never "fewer tokens = better answers".
 *
 * Two kinds of quantity are mixed together in ordinary conversation about "how big is
 * this" and must not be, because only one of them can ever be exact without a real
 * tokenizer:
 *
 *   EXACT (no estimation involved)    byte count (UTF-8), Unicode code point count
 *   ESTIMATED (always approximate)    token count, until a real tokenizer is injected
 *
 * `TokenEstimate` below reports both kinds side by side, tagged with `method` and
 * `approx`, so a caller — or a future calibration profile — can tell which number is
 * which rather than silently treating an estimate as if it were counted.
 */

/**
 * A token counter. The default is a rough heuristic; a model-specific tokenizer can
 * be injected later (e.g. per Ollama model) without changing call sites.
 */
export type TokenEstimator = (text: string) => number;

/**
 * Which estimator produced a token count — recorded so a manifest or evidence record
 * can say what kind of number it is, not just the number itself.
 */
export type MeasurementMethod =
  /** `chars/4`, uniform across the whole text. The original fallback; kept for
   *  comparison and as an explicit opt-out of CJK weighting. */
  | "chars-per-token-heuristic"
  /** CJK code points weighted ~1.5 chars/token, everything else ~4 chars/token
   *  (see `estimateTokensCjkWeighted`). The DEFAULT as of v0.4.8: this product's own
   *  primary use case is Japanese student records, where the flat heuristic
   *  systematically over-counts (CJK text tokenizes far denser than 4 chars/token in
   *  every mainstream BPE tokenizer), making "reduction" numbers look better than
   *  they are on the exact content this product exists to handle. */
  | "cjk-weighted-heuristic"
  /** An exact, model-specific tokenizer was injected via `setTokenEstimator`. */
  | "exact-tokenizer";

/** Rough heuristic: ~4 characters per token (English/code average). Uniform — does
 *  not distinguish CJK from Latin script. Kept as an explicit, named option; no
 *  longer the default (see `MeasurementMethod`). */
export const estimateTokens: TokenEstimator = (text: string): number => {
  return Math.ceil(text.length / 4);
};

/**
 * CJK Unified Ideographs, Hiragana, Katakana and Hangul — scripts where mainstream BPE
 * tokenizers (Claude's included) commonly split much closer to 1 token per character
 * than 1 token per 4 characters. Deliberately conservative (~1.5 chars/token, not 1:1):
 * this is still a heuristic, not a real tokenizer, and overstating precision here would
 * be exactly the "unsubstantiated claim" this phase exists to remove.
 */
const CJK_RANGE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힣]/u;

/**
 * Default token estimator (v0.4.8). Counts CJK and non-CJK code points separately and
 * weights them differently, instead of treating every character as worth the same
 * ~0.25 tokens. Numerically IDENTICAL to `estimateTokens` for pure-ASCII/Latin text
 * (nothing changes for the common non-CJK case).
 */
export const estimateTokensCjkWeighted: TokenEstimator = (text: string): number => {
  if (text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RANGE.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.5) + Math.ceil(other / 4);
};

/** The estimator used unless one is injected. */
export let activeTokenEstimator: TokenEstimator = estimateTokensCjkWeighted;

/** Which `MeasurementMethod` `activeTokenEstimator` currently represents. Updated by
 *  `setTokenEstimator` so `tokenEstimate()` can report an honest method name instead
 *  of guessing from function identity. */
let activeMeasurementMethod: MeasurementMethod = "cjk-weighted-heuristic";

/**
 * Swap in a model-specific tokenizer (returns the previous one). `method` defaults to
 * `"exact-tokenizer"` — the whole point of injecting a real tokenizer is that its
 * output is no longer the heuristic; pass an explicit `method` only when injecting a
 * DIFFERENT heuristic (e.g. reverting to `estimateTokens` for comparison).
 */
export function setTokenEstimator(
  fn: TokenEstimator,
  method: MeasurementMethod = "exact-tokenizer",
): TokenEstimator {
  const prev = activeTokenEstimator;
  activeTokenEstimator = fn;
  activeMeasurementMethod = method;
  return prev;
}

/** Which `MeasurementMethod` is currently active, for a caller (e.g. a manifest
 *  writer) that needs to record it without also needing a `TokenEstimate`. */
export function currentMeasurementMethod(): MeasurementMethod {
  return activeMeasurementMethod;
}

/** Exact UTF-8 byte length. Never an estimate. */
export function byteCount(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Exact Unicode code point count (not UTF-16 code units — `text.length` over-counts
 *  any character outside the Basic Multilingual Plane). Never an estimate. */
export function codePointCount(text: string): number {
  let count = 0;
  for (const _ch of text) count += 1;
  return count;
}

export interface TokenEstimate {
  /** UTF-16 code units (`string.length`) — kept for backward compatibility with
   *  existing `beforeChars`/`afterChars` accounting. Prefer `codePoints` for a
   *  script-independent count. */
  chars: number;
  /** Exact UTF-8 byte length. Never an estimate. */
  bytes: number;
  /** Exact Unicode code point count. Never an estimate. */
  codePoints: number;
  /** ESTIMATED. Never treat as exact without checking `method === "exact-tokenizer"`. */
  tokens: number;
  /** Always true until an exact tokenizer is configured. */
  approx: boolean;
  /** Which estimator produced `tokens`. */
  method: MeasurementMethod;
}

export function tokenEstimate(text: string, estimator: TokenEstimator = activeTokenEstimator): TokenEstimate {
  const method: MeasurementMethod =
    estimator === activeTokenEstimator
      ? activeMeasurementMethod
      : estimator === estimateTokens
        ? "chars-per-token-heuristic"
        : estimator === estimateTokensCjkWeighted
          ? "cjk-weighted-heuristic"
          : "exact-tokenizer";
  return {
    chars: text.length,
    bytes: byteCount(text),
    codePoints: codePointCount(text),
    tokens: estimator(text),
    approx: method !== "exact-tokenizer",
    method,
  };
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
  /** Which estimator produced `beforeTokens`/`afterTokens`. */
  method: MeasurementMethod;
  filesExcluded: number;
  filesSummarized: number;
  sensitiveMasked: number;
  sourceModified: number; // always 0 by invariant
}

/**
 * Char-count-only fallback for `reductionReport()`: the accounting loops that call it
 * track a running CHAR COUNT, not the original text, so CJK weighting (which needs to
 * inspect actual characters) is not possible here — this is honestly labeled
 * `"chars-per-token-heuristic"` rather than falsely claiming the CJK-weighted method,
 * precisely BECAUSE it cannot tell CJK from Latin script without the text itself.
 */
function estimateFromCharCount(chars: number): number {
  return Math.ceil(chars / 4);
}

export function reductionReport(input: {
  beforeChars: number;
  afterChars: number;
  /** Precomputed token counts (from an injected tokenizer or a prior `tokenEstimate`
   *  call). Falls back to `estimateFromCharCount` — a char-count-only approximation,
   *  see its doc comment — when omitted. */
  beforeTokens?: number;
  afterTokens?: number;
  /** true = counts are estimates (default when tokens not provided). */
  approx?: boolean;
  /** Which estimator produced `beforeTokens`/`afterTokens`, when the caller knows
   *  (e.g. from a `tokenEstimate()` call). Recorded on the fallback path automatically. */
  method?: MeasurementMethod;
  filesExcluded?: number;
  filesSummarized?: number;
  sensitiveMasked?: number;
}): ReductionReport {
  const beforeTokens = input.beforeTokens ?? estimateFromCharCount(input.beforeChars);
  const afterTokens = input.afterTokens ?? estimateFromCharCount(input.afterChars);
  const method: MeasurementMethod =
    input.method ?? (input.beforeTokens === undefined ? "chars-per-token-heuristic" : activeMeasurementMethod);
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
    method,
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
