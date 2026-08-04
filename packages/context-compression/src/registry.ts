/**
 * Compressor selection with safe fallback.
 *
 * Order matters: the most specific compressor first, the generic text window last.
 * A compressor that throws, times out, or fails its own `verify()` is skipped and the
 * next one is tried. When none succeeds the outcome is `failed` — never raw content:
 * the RUNTIME decides what a failure means, and its options are the scanned original
 * or `withheld` (architecture §2).
 */

import { jsonCompressor } from "./json.js";
import { dotenvCompressor } from "./dotenv.js";
import { jsonTolerantCompressor } from "./json-tolerant.js";
import { searchResultsCompressor } from "./search-results.js";
import { testOutputCompressor } from "./test-output.js";
import { textCompressor } from "./text.js";
import {
  runWithLimit,
  sampleOf,
  type CompressContext,
  type CompressInput,
  type CompressResult,
  type Compressor,
} from "./contract.js";

/**
 * Order is the routing policy (ADR-0005, derived from observed traffic):
 * strict JSON → tolerant JSON scan → config (KEY=VALUE) → search results → test/shell
 * output → text window.
 * Most specific first; the generic byte/line window is always last and always available.
 */
export const BUILTIN_COMPRESSORS: readonly Compressor[] = [
  jsonCompressor,
  jsonTolerantCompressor,
  dotenvCompressor,
  searchResultsCompressor,
  testOutputCompressor,
  textCompressor,
];

export interface CompressionAttempt {
  readonly compressorId: string;
  readonly ok: boolean;
  readonly reason?: string;
}

export type CompressionOutcome =
  | { readonly status: "compressed"; readonly result: CompressResult; readonly attempts: readonly CompressionAttempt[] }
  | { readonly status: "failed"; readonly reason: string; readonly attempts: readonly CompressionAttempt[] };

export function selectCompressors(
  input: Pick<CompressInput, "kind" | "content">,
  compressors: readonly Compressor[] = BUILTIN_COMPRESSORS,
): readonly Compressor[] {
  const sample = sampleOf(input.content);
  return compressors.filter((c) => c.supports(input.kind, sample));
}

export async function compressWithFallback(
  input: CompressInput,
  ctx: CompressContext,
  compressors: readonly Compressor[] = BUILTIN_COMPRESSORS,
): Promise<CompressionOutcome> {
  const attempts: CompressionAttempt[] = [];
  for (const compressor of selectCompressors(input, compressors)) {
    try {
      const result = await runWithLimit(() => compressor.compress(input, ctx), ctx);
      const verdict = compressor.verify(input, result);
      if (!verdict.ok) {
        attempts.push({ compressorId: compressor.id, ok: false, reason: verdict.reason });
        continue;
      }
      attempts.push({ compressorId: compressor.id, ok: true });
      return {
        status: "compressed",
        // The compressor declares the policy; the result carries it to the delivery layer.
        result: { ...result, hintPolicy: result.hintPolicy ?? compressor.hintPolicy ?? "offer-retrieval" },
        attempts,
      };
    } catch (err) {
      // Reason strings are compressor-authored, never content-derived: an error
      // message must not become a disclosure channel.
      attempts.push({
        compressorId: compressor.id,
        ok: false,
        reason: err instanceof Error ? err.name : "error",
      });
    }
  }
  return { status: "failed", reason: attempts.length === 0 ? "no-compressor" : "all-compressors-failed", attempts };
}
