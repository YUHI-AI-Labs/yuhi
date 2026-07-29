import type { Processor, ProcessorResult } from "@yuhi/shared";

export interface ValidatorOptions {
  /**
   * Raw values that MUST NOT appear in the output (e.g. original names/IDs).
   * These are used only for checking and are never emitted in the audit.
   */
  forbid: string[];
  /** Human labels aligned with `forbid`, for safe problem messages. */
  labels?: string[];
}

/**
 * A privacy safety-check. Confirms none of the forbidden raw values survived a
 * transformation before the output is allowed to leave the machine. It is honest:
 * passing means "these specific values are gone", not "re-identification is
 * impossible".
 */
export function createValidator(options: ValidatorOptions): Processor {
  const forbid = options.forbid.filter(Boolean);
  const labels = options.labels ?? [];
  return {
    id: "safety-check",
    version: "1.0.0",
    kind: "validation",
    inputType: "text/plain",
    outputType: "text/plain",
    process(input: string): ProcessorResult {
      const problems: string[] = [];
      forbid.forEach((value, i) => {
        if (value && input.includes(value)) {
          problems.push(`A raw ${labels[i] ?? "identifier"} is still present in the output.`);
        }
      });
      const ok = problems.length === 0;
      return {
        output: input,
        safePreview: ok
          ? `Safety check passed: none of the ${forbid.length} protected value(s) are present`
          : `Safety check failed: ${problems.length} protected value(s) still present`,
        externalTransmissionAllowed: ok,
        audit: {
          processorId: "safety-check",
          version: "1.0.0",
          kind: "validation",
          itemsChanged: 0,
          note: `${forbid.length} value(s) checked · ${ok ? "pass" : "fail"}`,
        },
        validation: { ok, problems },
      };
    },
  };
}
