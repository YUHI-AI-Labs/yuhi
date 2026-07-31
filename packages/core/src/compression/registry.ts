/**
 * CompressorRegistry — routes a file to a language compressor, or keeps it FULL.
 * The single place the prepare pipeline talks to; the core never switches on language.
 */
import { tokenEstimate } from "@yuhi/shared";
import type {
  CompressionInput,
  CompressionResult,
  CompressionWarning,
  SourceCompressor,
} from "./types.js";

/** Deterministic token estimate for a string (shared with the rest of Yuhi). */
export function estimateTokens(s: string): number {
  return tokenEstimate(s).tokens;
}

/** Build a FULL (no-compression) result — used when there is no compressor, or on failure. */
export function fullResult(
  input: CompressionInput,
  warnings: CompressionWarning[] = [],
): CompressionResult {
  const t = estimateTokens(input.content);
  return {
    representation: "full",
    originalTokens: t,
    compressedTokens: t,
    content: input.content,
    symbols: [],
    warnings,
  };
}

export class CompressorRegistry {
  private readonly compressors: SourceCompressor[] = [];

  register(compressor: SourceCompressor): this {
    this.compressors.push(compressor);
    return this;
  }

  find(path: string, content: string): SourceCompressor | undefined {
    return this.compressors.find((c) => c.supports(path, content));
  }

  /**
   * Compress a file, or keep it FULL. NEVER throws. Unsupported language, a thrown
   * compressor, empty output, or non-reducing output all fall back to the original
   * content with a recorded warning — so a compression failure never loses or
   * corrupts a file.
   */
  async compress(input: CompressionInput): Promise<CompressionResult> {
    const compressor = this.find(input.relpath, input.content);
    if (!compressor) {
      return fullResult(input, [
        { code: "unsupported-language", message: `No structure compressor for ${input.relpath}` },
      ]);
    }
    try {
      const result = await compressor.compress(input);
      if (result.representation === "compressed") {
        if (!result.content.trim()) {
          return fullResult(input, [
            { code: "empty-output", message: "Compressor produced empty output; kept full." },
          ]);
        }
        if (result.compressedTokens >= result.originalTokens) {
          return fullResult(input, [
            { code: "too-small", message: "Compression did not reduce tokens; kept full." },
            ...result.warnings,
          ]);
        }
      }
      return result;
    } catch (error) {
      return fullResult(input, [
        { code: "parse-failed", message: (error as Error)?.message ?? String(error) },
      ]);
    }
  }
}
