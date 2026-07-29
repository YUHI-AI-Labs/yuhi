import {
  processorId,
  type LocalModelProvider,
  type ProcessorAudit,
  type ProcessorResult,
  type ProcessorSpec,
  type ReductionMode,
  type TransmissionState,
} from "@yuhi/shared";
import {
  createPseudonymizer,
  createSummarizer,
  createValidator,
  inMemoryMappingStore,
} from "@yuhi/processors";
import type { Plan } from "./plan.js";

export interface RouteResult {
  /** Transformed content. */
  output: string;
  /** false → the file must NOT be sent (a validation processor failed). */
  allowed: boolean;
  audits: ProcessorAudit[];
  /** Safe-to-show summaries, one per processor. */
  steps: string[];
}

/** Heuristic: pull identifier-like values from a CSV (name/id/email columns). */
function extractCsvIdentifiers(content: string): string[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const header = lines[0]!.split(",").map((h) => h.trim());
  const idCols: number[] = [];
  header.forEach((h, i) => {
    if (/(^|[_\s])(name|id|email|e-mail|phone|student|patient)/i.test(h)) idCols.push(i);
  });
  if (idCols.length === 0) return [];
  const ids = new Set<string>();
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    for (const i of idCols) {
      const v = (cells[i] ?? "").trim();
      if (v) ids.add(v);
    }
  }
  return [...ids];
}

/**
 * The RouteExecutor for the `prepare-locally` route. Processors are *parts*; this
 * is the *workflow* that runs them in order (e.g. pseudonymize → safety-check).
 * Everything runs on the local machine; a failed validation blocks the file.
 */
export function runPrepareLocally(
  content: string,
  specs: ProcessorSpec[],
  opts: { salt?: string } = {},
): RouteResult {
  const identifiers = extractCsvIdentifiers(content);
  const store = inMemoryMappingStore();
  let output = content;
  const audits: ProcessorAudit[] = [];
  const steps: string[] = [];

  for (const spec of specs) {
    const id = processorId(spec);
    if (id === "pseudonymize") {
      const r = createPseudonymizer({
        identifiers,
        ...(opts.salt !== undefined ? { salt: opts.salt } : {}),
        store,
      }).process(output) as ProcessorResult;
      output = r.output;
      audits.push(r.audit);
      steps.push(r.safePreview);
    } else if (id === "safety-check") {
      const r = createValidator({
        forbid: identifiers,
        labels: identifiers.map(() => "identifier"),
      }).process(output) as ProcessorResult;
      audits.push(r.audit);
      steps.push(r.safePreview);
      if (r.validation && !r.validation.ok) {
        return { output, allowed: false, audits, steps };
      }
    }
    // Future processors (generalize, summarize-local, …) plug in here.
  }
  return { output, allowed: true, audits, steps };
}

/**
 * Build the per-file content transformer the workspace uses. For `prepare-locally`
 * files it runs the configured pipeline (or a safe default) and returns the
 * transformed bytes — or null to block the file when validation fails.
 */
export function buildPrepareContent(plan: Plan): (relpath: string, bytes: Buffer) => Buffer | null {
  const byPath = new Map(plan.evaluation.decisions.map((d) => [d.relpath, d]));
  const salt = plan.context.policyHash;
  return (relpath, bytes) => {
    const decision = byPath.get(relpath);
    const specs: ProcessorSpec[] =
      decision?.processors && decision.processors.length > 0
        ? decision.processors
        : ["pseudonymize", "safety-check"];
    const r = runPrepareLocally(bytes.toString("utf8"), specs, { salt });
    return r.allowed ? Buffer.from(r.output, "utf8") : null;
  };
}

export interface LocalPreparationResult extends RouteResult {
  /** "ok" = prepared & safe; "blocked" = failed safety-check; "error" = a step threw. */
  status: "ok" | "blocked" | "error";
  /**
   * Sendability gate. Output is only "approved" after a deterministic safety-check
   * passes. If summarization ran but no safety-check did, it stays
   * "pending-safety-check" (NOT sendable). Callers must send only when "approved".
   */
  transmission: TransmissionState;
  /** Size reduction from local summarization (chars). */
  reduction: { beforeChars: number; afterChars: number; ratio: number };
  /** Non-sensitive error note, if status === "error". */
  error?: string;
}

/**
 * ASYNC prepare-locally pipeline that can include the local-model `summarize-local`
 * step (Ollama). Unlike `runPrepareLocally` (sync, deterministic only), this awaits
 * the provider. Order: summarize-local → pseudonymize → safety-check. The original
 * is never touched (input is a copy); a failed safety-check blocks transmission.
 *
 * No cloud calls occur — the provider is a LOCAL model.
 */
export async function runLocalPreparation(
  content: string,
  specs: ProcessorSpec[],
  opts: {
    provider?: LocalModelProvider;
    salt?: string;
    signal?: AbortSignal;
    /** Reduction mode for summarize-local (conservative fails on overflow, etc.). */
    mode?: ReductionMode;
  } = {},
): Promise<LocalPreparationResult> {
  const identifiers = extractCsvIdentifiers(content);
  const store = inMemoryMappingStore();
  const audits: ProcessorAudit[] = [];
  const steps: string[] = [];
  const beforeChars = content.length;
  let output = content;
  let safetyChecked = false;

  try {
    for (const spec of specs) {
      const id = processorId(spec);
      if (id === "summarize-local") {
        if (!opts.provider) {
          return {
            output,
            allowed: false,
            status: "error",
            transmission: "pending-safety-check",
            audits,
            steps,
            reduction: { beforeChars, afterChars: output.length, ratio: 0 },
            error: "No local model provider configured (run `yuhi setup-local-ai`).",
          };
        }
        const summarizer = createSummarizer({
          provider: opts.provider,
          ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        });
        const r = (await summarizer.process(output)) as ProcessorResult;
        output = r.output;
        audits.push(r.audit);
        steps.push(r.safePreview);
      } else if (id === "pseudonymize") {
        const r = createPseudonymizer({
          identifiers,
          ...(opts.salt !== undefined ? { salt: opts.salt } : {}),
          store,
        }).process(output) as ProcessorResult;
        output = r.output;
        audits.push(r.audit);
        steps.push(r.safePreview);
      } else if (id === "safety-check") {
        const r = createValidator({
          forbid: identifiers,
          labels: identifiers.map(() => "identifier"),
        }).process(output) as ProcessorResult;
        audits.push(r.audit);
        steps.push(r.safePreview);
        if (r.validation && !r.validation.ok) {
          return {
            output,
            allowed: false,
            status: "blocked",
            transmission: "blocked",
            audits,
            steps,
            reduction: { beforeChars, afterChars: output.length, ratio: reduce(beforeChars, output.length) },
          };
        }
        safetyChecked = true;
      }
    }
  } catch (e) {
    const err = e as { message?: string; code?: string };
    return {
      output,
      allowed: false,
      status: "error",
      transmission: "blocked",
      audits,
      steps,
      reduction: { beforeChars, afterChars: output.length, ratio: reduce(beforeChars, output.length) },
      error: err.code ? `${err.code}: ${err.message ?? ""}`.trim() : (err.message ?? "preparation failed"),
    };
  }

  const afterChars = output.length;
  return {
    output,
    allowed: true,
    status: "ok",
    // Only "approved" once a deterministic safety-check has actually passed.
    transmission: safetyChecked ? "approved" : "pending-safety-check",
    audits,
    steps,
    reduction: { beforeChars, afterChars, ratio: reduce(beforeChars, afterChars) },
  };
}

function reduce(before: number, after: number): number {
  return before > 0 ? 1 - after / before : 0;
}
