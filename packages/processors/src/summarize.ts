import {
  normalizeModelResponse,
  type GenerateOptions,
  type LocalModelProvider,
  type Processor,
  type ProcessorResult,
  type ReductionMode,
} from "@yuhi/shared";

const SUMMARY_SYSTEM =
  "You are a local context preprocessor. Summarize the input concisely and " +
  "factually for a downstream engineering task. Preserve key facts, structure, " +
  "decisions, and data. Do NOT invent information and do NOT add commentary. " +
  "Output only the summary.";

const CONSOLIDATE_SYSTEM =
  "Combine the following partial summaries into one concise, non-redundant summary. " +
  "Preserve all distinct facts. Output only the summary.";

export interface SummarizeOptions {
  /** The local model provider (e.g. Ollama). Injected — no vendor hardcoding. */
  provider: LocalModelProvider;
  /** Override the provider's default model. */
  model?: string;
  /** Approx characters per chunk (split on line boundaries). Default 6000. */
  chunkChars?: number;
  /** Safety cap on chunks. Default 24. Behavior when exceeded depends on `mode`. */
  maxChunks?: number;
  /** Maximum completion tokens per local-model request. Default 768. */
  maxOutputTokens?: number;
  /** Maximum concurrent chunk requests. Default 2; output order stays deterministic. */
  maxParallelRequests?: number;
  /**
   * Reduction mode governs what happens when the input exceeds `maxChunks`:
   *  - conservative → throw (input exceeds the safe limit; nothing is omitted silently)
   *  - balanced     → process the cap and mark PARTIAL with a visible warning
   *  - aggressive   → process the cap with a prominent warning
   * Default "balanced".
   */
  mode?: ReductionMode;
  /** Caller cancellation, forwarded to every model call. */
  signal?: AbortSignal;
}

/** Thrown by summarize-local under conservative mode when input exceeds the cap. */
export class InputTooLargeError extends Error {
  readonly totalChunks: number;
  readonly maxChunks: number;
  constructor(totalChunks: number, maxChunks: number) {
    super(
      `Input is ${totalChunks} chunks but the safe limit is ${maxChunks}. ` +
        `Split the input, raise the limit, or use balanced/aggressive reduction mode.`,
    );
    this.name = "InputTooLargeError";
    this.totalChunks = totalChunks;
    this.maxChunks = maxChunks;
  }
}

/** Split text into chunks no larger than ~chunkChars, breaking on line boundaries. */
export function chunkText(text: string, chunkChars: number): string[] {
  if (text.length <= chunkChars) return text.length ? [text] : [];
  const lines = text.split(/\r?\n/);
  const chunks: string[] = [];
  let cur = "";
  for (const line of lines) {
    if (cur.length + line.length + 1 > chunkChars && cur.length > 0) {
      chunks.push(cur);
      cur = "";
    }
    // A single line longer than the budget becomes its own (oversized) chunk.
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * `summarize-local` — a local-model processor. Summarizes text ON THE MACHINE via
 * the injected provider, chunking large inputs and consolidating. Never modifies
 * originals; the summary is NOT considered safe to send until a later safety-check
 * passes (we set externalTransmissionAllowed=true only to mean "this step produced
 * sendable-shaped output" — the RouteExecutor still gates on safety-check).
 */
export function createSummarizer(options: SummarizeOptions): Processor {
  const provider = options.provider;
  const chunkChars = options.chunkChars ?? 6000;
  const maxChunks = options.maxChunks ?? 24;
  const mode: ReductionMode = options.mode ?? "balanced";
  const maxParallelRequests = Math.max(1, Math.floor(options.maxParallelRequests ?? 2));

  return {
    id: "summarize-local",
    version: "1.0.0",
    kind: "local-model",
    inputType: "text/plain",
    outputType: "text/plain",
    async process(input: string): Promise<ProcessorResult> {
      const allChunks = chunkText(input, chunkChars);
      const omitted = Math.max(0, allChunks.length - maxChunks);

      // Chunk-cap policy (no SILENT omission).
      if (omitted > 0 && mode === "conservative") {
        throw new InputTooLargeError(allChunks.length, maxChunks);
      }
      const chunks = allChunks.slice(0, maxChunks);

      // Run independent chunk summaries with bounded concurrency. Results are
      // written by index so consolidation remains deterministic regardless of
      // completion order.
      const partials = new Array<string>(chunks.length);
      let nextIndex = 0;
      const workers = Array.from(
        { length: Math.min(maxParallelRequests, chunks.length) },
        async () => {
          while (true) {
            const index = nextIndex++;
            if (index >= chunks.length) return;
            partials[index] = normalizeModelResponse(
              await provider.generate(chunks[index]!, buildOpts(options, SUMMARY_SYSTEM)),
            );
          }
        },
      );
      const settled = await Promise.allSettled(workers);
      const failure = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) throw failure.reason;

      let output = partials.join("\n\n");
      if (partials.length > 1) {
        output = normalizeModelResponse(
          await provider.generate(output, buildOpts(options, CONSOLIDATE_SYSTEM)),
        );
      }

      const beforeChars = input.length;
      const afterChars = output.length;
      const pct = Math.round((beforeChars > 0 ? 1 - afterChars / beforeChars : 0) * 100);
      const modelName = options.model ?? provider.defaultModel;

      const warning =
        omitted > 0
          ? mode === "aggressive"
            ? ` ⚠️ AGGRESSIVE: ${omitted} chunk(s) omitted — output is incomplete.`
            : ` ⚠️ Partial: ${omitted} chunk(s) omitted (input exceeded the cap).`
          : "";

      return {
        output,
        safePreview: `Summarized ${beforeChars}→${afterChars} chars (${pct}% smaller) locally.${warning}`,
        // Local summarization succeeding does NOT make output sendable. It is only
        // sendable after the deterministic safety-check passes downstream.
        externalTransmissionAllowed: false,
        audit: {
          processorId: "summarize-local",
          version: "1.0.0",
          kind: "local-model",
          itemsChanged: chunks.length,
          note:
            `local summary via ${provider.id}/${modelName}; ${chunks.length}/${allChunks.length} chunk(s)` +
            `; parallelism ${Math.min(maxParallelRequests, Math.max(1, chunks.length))}` +
            (omitted > 0 ? `; ${omitted} omitted (${mode})` : "") +
            "; pending safety-check",
        },
      };
    },
  };
}

function buildOpts(o: SummarizeOptions, system: string): GenerateOptions {
  const g: GenerateOptions = { system, maxTokens: o.maxOutputTokens ?? 768 };
  if (o.model !== undefined) g.model = o.model;
  if (o.signal !== undefined) g.signal = o.signal;
  return g;
}
