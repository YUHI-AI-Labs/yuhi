/**
 * Processor plugin contract.
 *
 * Deterministic processors and local-model processors share ONE interface.
 * This is an internal/developer concept — it is never surfaced in the UI, which
 * only shows the user-facing routes (Send / Remove secrets / Prepare locally /
 * Runtime only / Keep local).
 *
 * INVARIANT: an audit record must NEVER contain raw sensitive values.
 */
export type ProcessorKind = "rule-based" | "local-model" | "validation";

/** How a processor is referenced in a rule's `processors:` list. */
export type ProcessorSpec = string | ({ id: string } & Record<string, unknown>);

/** The processor id from a spec (string form or object form). */
export function processorId(spec: ProcessorSpec): string {
  return typeof spec === "string" ? spec : spec.id;
}

/** Metadata-only audit entry — safe to persist and show. No raw values. */
export interface ProcessorAudit {
  processorId: string;
  version: string;
  kind: ProcessorKind;
  /** How many spans/items the processor changed (count only). */
  itemsChanged: number;
  /** Optional non-sensitive note, e.g. "4 identifiers pseudonymized". */
  note?: string;
}

export interface ProcessorValidation {
  ok: boolean;
  problems: string[];
}

export interface ProcessorResult {
  /** The transformed text (for text processors). */
  output: string;
  /** Safe-to-display summary of what happened (no raw secret values). */
  safePreview: string;
  /** Whether this processor's OUTPUT may be transmitted to an external agent. */
  externalTransmissionAllowed: boolean;
  audit: ProcessorAudit;
  /** Present for validation processors (and any processor that self-validates). */
  validation?: ProcessorValidation;
}

export interface Processor {
  id: string;
  version: string;
  kind: ProcessorKind;
  /** e.g. "text/plain", "text/csv". */
  inputType: string;
  outputType: string;
  /** Transform input. May be sync (rule-based) or async (local model). */
  process(input: string, opts?: Record<string, unknown>): ProcessorResult | Promise<ProcessorResult>;
}
