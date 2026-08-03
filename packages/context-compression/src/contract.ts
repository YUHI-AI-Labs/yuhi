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
import { estimateTokens } from "@yuhi/shared";

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
    estimateTokens: overrides.estimateTokens ?? estimateTokens,
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
}

export type VerifyOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface Compressor {
  readonly id: string;
  readonly version: string;
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
