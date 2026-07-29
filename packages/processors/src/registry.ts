import type { ProcessorKind } from "@yuhi/shared";

/** Static, non-sensitive description of a built-in processor (for docs/`doctor`). */
export interface ProcessorInfo {
  id: string;
  version: string;
  kind: ProcessorKind;
  /** The user-facing route this processor helps implement. */
  route: string;
  summary: string;
}

/**
 * Built-in processors. Local-model processors (e.g. summarize-local via Ollama)
 * plug in through the same shape — the provider is a replaceable adapter, never
 * hard-wired into the product identity.
 */
export const BUILTIN_PROCESSORS: ProcessorInfo[] = [
  {
    id: "pseudonymize",
    version: "1.0.0",
    kind: "rule-based",
    route: "Prepare locally",
    summary: "Replace identifiers with stable pseudonyms; mapping kept local.",
  },
  {
    id: "safety-check",
    version: "1.0.0",
    kind: "validation",
    route: "Prepare locally",
    summary: "Confirm protected values are gone before anything is sent.",
  },
  {
    id: "summarize-local",
    version: "1.0.0",
    kind: "local-model",
    route: "Prepare locally",
    summary: "Summarize/reduce content with a local model (Ollama) before sending.",
  },
];
