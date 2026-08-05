/**
 * The compression kernel contract (spec §7, architecture §3).
 *
 * Rules every compressor must satisfy: deterministic · streaming-friendly ·
 * timeout · cancellable · thread-safe (no shared mutable state; everything travels
 * in `ctx`) · REVERSIBLE (every omission carries a retrievable locator) ·
 * self-verifying · safe on failure.
 *
 * Reversibility is what separates this from summarization: nothing is lost, it is
 * "not yet delivered".
 */

import type { ContentKind, ObjectId } from "@yuhi/context-store";
import { activeTokenEstimator } from "@yuhi/shared";

/** A bounded prefix of the content, used for cheap dispatch in `supports()`. */
export interface Sample {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export function sampleOf(content: string, limit = 4096): Sample {
  const bytes = Buffer.byteLength(content, "utf8");
  return { text: content.slice(0, limit), bytes, truncated: content.length > limit };
}

/** A region the compressor did not deliver, and how to get it. */
export interface Omission {
  readonly objectId: ObjectId;
  /** A locator in this compressor's grammar: JSONPath for json, `L12-L88` for text. */
  readonly locator: string;
  readonly kind: string;
  readonly tokensOmitted: number;
  /** Element/key count for container omissions, when meaningful. */
  readonly items?: number;
}

export interface RemovedSummary {
  readonly kind: string;
  readonly count: number;
}

export interface CompressInput {
  readonly objectId: ObjectId;
  readonly revision: number;
  readonly kind: ContentKind;
  readonly content: string;
  /** Best-effort target for the delivered view. Never a reason to lose a region. */
  readonly tokenBudget?: number;
}

export interface CompressContext {
  /** Injected clock — inline `Date.now()` would make output non-deterministic. */
  readonly now: () => string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly estimateTokens: (text: string) => number;
}

export function defaultCompressContext(overrides: Partial<CompressContext> = {}): CompressContext {
  return {
    now: overrides.now ?? (() => new Date().toISOString()),
    timeoutMs: overrides.timeoutMs ?? 2_000,
    // Delegates to the CURRENT `activeTokenEstimator` on every call (v0.4.8 Phase 5),
    // not a snapshot of whichever estimator was active when this context was built —
    // matching `@yuhi/shared`'s `tokenEstimate()`, which Static Prepare already reads
    // live. Before this fix, Dynamic Context was pinned to the raw chars/4 heuristic
    // and never picked up `setTokenEstimator()` at all: Static Prepare and Dynamic
    // Context reduction numbers could silently diverge for a reason that had nothing
    // to do with the content, only with which surface asked.
    estimateTokens: overrides.estimateTokens ?? ((text: string) => activeTokenEstimator(text)),
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  };
}

export interface CompressResult {
  readonly compressorId: string;
  readonly compressorVersion: string;
  /** The candidate delivery bytes. Still subject to the exact-output safety rescan. */
  readonly text: string;
  /** Structural landmarks preserved verbatim; Safe Apply anchors to these. */
  readonly anchors: readonly string[];
  readonly omissions: readonly Omission[];
  readonly removed: readonly RemovedSummary[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /** Copied from the compressor so the runtime can decide whether to advertise retrieval. */
  readonly hintPolicy?: HintPolicy;
}

export type VerifyOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Whether the agent should be invited to retrieve what was omitted.
 *
 * `offer-retrieval` — arbitrary content was withheld and the answer may depend on it
 *   (JSON bodies, byte windows, fragments). Print the retrieve template.
 * `answer-complete` — the compressor preserves everything load-bearing by contract
 *   (test failures + anchors; search counts + file list). The omitted lines are still
 *   recorded in the ledger and reachable via `yuhi_explain_context`, but advertising a
 *   call template invites the agent to spend a turn it does not need.
 *
 * This distinction came out of measurement: on the test-failure task the compact result
 * cut tool-output tokens by ~86% and still cost MORE than baseline, because the agent
 * took extra turns around the hint.
 */
export type HintPolicy = "offer-retrieval" | "answer-complete";

export interface Compressor {
  readonly id: string;
  readonly version: string;
  /** Defaults to `offer-retrieval` when absent — the conservative choice. */
  readonly hintPolicy?: HintPolicy;
  supports(kind: ContentKind, sample: Sample): boolean;
  compress(input: CompressInput, ctx: CompressContext): Promise<CompressResult>;
  estimateTokens(text: string): number;
  /** Postcondition self-check. A failed verify is treated exactly like a throw. */
  verify(input: CompressInput, result: CompressResult): VerifyOutcome;
}

export class CompressionAborted extends Error {
  constructor(readonly reason: "timeout" | "cancelled") {
    super(`Compression ${reason}`);
    this.name = "CompressionAborted";
  }
}

export function throwIfAborted(ctx: CompressContext): void {
  if (ctx.signal?.aborted) throw new CompressionAborted("cancelled");
}

/**
 * Run a compressor under a hard wall-clock limit. A compressor that hangs must not
 * hang the agent; the runtime turns the failure into `withheld`, never a raw fallback.
 */
export async function runWithLimit<T>(fn: () => Promise<T>, ctx: CompressContext): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CompressionAborted("timeout")), ctx.timeoutMs);
        ctx.signal?.addEventListener("abort", () => reject(new CompressionAborted("cancelled")), { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
