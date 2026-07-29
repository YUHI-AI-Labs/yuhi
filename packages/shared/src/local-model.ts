/**
 * Local-model provider contract.
 *
 * Yuhi's "Prepare locally" route can use a LOCAL model (never a cloud API) to
 * summarize or reduce context before it is sent to a frontier agent. The provider
 * is a replaceable adapter — Ollama is the first one, but the RouteExecutor and
 * processors depend only on this interface, never on a vendor.
 *
 * INVARIANTS:
 *  - Everything runs on the user's machine; no cloud calls happen here.
 *  - A provider never downloads a model on its own (that requires explicit user action).
 */

export type LocalModelErrorCode =
  | "NOT_RUNNING" // endpoint unreachable (e.g. Ollama not started)
  | "MODEL_NOT_FOUND" // the requested model is not installed locally
  | "TIMEOUT" // the request exceeded its time budget
  | "CANCELLED" // the caller aborted the request
  | "MALFORMED_RESPONSE" // the provider replied with something we can't parse
  | "EMPTY_RESPONSE" // the normalized final answer was empty
  | "REQUEST_FAILED"; // any other non-success response

/** A typed error with an actionable hint. Never contains raw user content. */
export class LocalModelError extends Error {
  readonly code: LocalModelErrorCode;
  readonly hint?: string;
  constructor(
    code: LocalModelErrorCode,
    message: string,
    opts: { hint?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "LocalModelError";
    this.code = code;
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

export interface HealthResult {
  /** Is the provider reachable? */
  ok: boolean;
  /** Human-readable status (safe to print). */
  detail: string;
  endpoint: string;
  /** Installed model names, when reachable. */
  models?: string[];
}

export interface GenerateOptions {
  /** Override the provider's default model for this call. */
  model?: string;
  /** System prompt / instruction. */
  system?: string;
  temperature?: number;
  /** Upper bound on output tokens (best-effort; provider-dependent). */
  maxTokens?: number;
  /** Per-call timeout in ms (overrides the provider default). */
  timeoutMs?: number;
  /** Caller cancellation. */
  signal?: AbortSignal;
}

export interface LocalModelProvider {
  /** Stable id, e.g. "ollama". */
  readonly id: string;
  /** Base endpoint, e.g. "http://localhost:11434". */
  readonly endpoint: string;
  /** The model used when GenerateOptions.model is not given. */
  readonly defaultModel: string;
  /** Probe reachability + list installed models. NEVER throws. */
  health(): Promise<HealthResult>;
  /** List installed model names. Throws LocalModelError on failure. */
  listModels(): Promise<string[]>;
  /** Generate text fully locally. Throws LocalModelError on failure. */
  generate(prompt: string, opts?: GenerateOptions): Promise<string>;
}

/** How the local model is configured in yuhi.yaml (`local_model:` block). */
export interface LocalModelConfig {
  provider: string; // "ollama"
  endpoint: string; // http://localhost:11434
  model: string; // e.g. gemma3:4b
  timeoutMs: number;
}

export const DEFAULT_LOCAL_MODEL: LocalModelConfig = {
  provider: "ollama",
  endpoint: "http://127.0.0.1:11434",
  model: "qwen3:1.7b",
  timeoutMs: 120_000,
};

/**
 * The transmission state of a prepared artifact. Local summarization succeeding does
 * NOT make output sendable — it must pass the deterministic safety-check first.
 * Flow: summarize-local → pending-safety-check → (pseudonymize) → safety-check →
 * approved (or blocked).
 */
export type TransmissionState = "pending-safety-check" | "blocked" | "approved";

/**
 * A recommended model tier shown during setup. Sizes are APPROXIMATE and may drift
 * with the Ollama distribution — read live size from Ollama when available and fall
 * back to these labels. Never downloaded automatically.
 */
export interface ModelTier {
  id: string;
  tier: "default" | "quality";
  label: string;
  /** Approximate on-disk download size (fallback when Ollama can't report it). */
  approxSize: string;
  blurb: string;
}

/**
 * First-run recommendations. `qwen3:1.7b` is the default (smaller download, faster
 * setup, runs on ordinary laptops; sufficient for summarize/classify/extract/reduce).
 * `qwen3:4b` is the higher-quality upgrade. Preselect the default but ALWAYS require
 * explicit confirmation before `ollama pull`.
 */
export const MODEL_TIERS: ModelTier[] = [
  {
    id: "qwen3:1.7b",
    tier: "default",
    label: "Recommended for most users",
    approxSize: "~1.4 GB",
    blurb: "Fast setup · Lower memory use · Local processing",
  },
  {
    id: "qwen3:4b",
    tier: "quality",
    label: "Higher-quality option",
    approxSize: "~2.5 GB",
    blurb: "Larger download · Better preservation and summarization quality",
  },
];

/** Model ids in preference order (default first). */
export const RECOMMENDED_MODELS = MODEL_TIERS.map((m) => m.id) as readonly string[];
