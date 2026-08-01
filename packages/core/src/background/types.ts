/**
 * Yuhi v0.3.5 "Progressive Context" — BackgroundPreparationQueue types.
 *
 * This module models deferred heavy preparation work (document extraction, OCR,
 * local summarization) that runs AFTER Yuhi Mode has already launched. Only
 * safety-verified results are ever published back into the agent-visible
 * workspace.
 *
 * Invariant: absolute filesystem paths live ONLY in internal state
 * (`BackgroundPreparationItem.sourceArtifactPath`, and the store's on-disk
 * records). They must NEVER appear in any public projection returned to the CLI,
 * VS Code, or the agent. Public shapes carry repo-relative paths only.
 */

/** The three kinds of deferred heavy work the queue processes. */
export type BackgroundPreparationKind =
  | "document-extraction"
  | "ocr"
  | "summarize-local";

export const BACKGROUND_PREPARATION_KINDS: readonly BackgroundPreparationKind[] = [
  "document-extraction",
  "ocr",
  "summarize-local",
] as const;

/**
 * A unit of deferred work.
 *
 * INTERNAL shape: `sourceArtifactPath` is an absolute path to the original
 * artifact (the PDF/DOCX/etc.) and must never be surfaced publicly. Use
 * {@link projectItem} to obtain a public, path-safe projection.
 */
export interface BackgroundPreparationItem {
  itemId: string;
  runId: string;
  contextId: string;
  /** Repo-relative path of the source file (public-safe). */
  relpath: string;
  kind: BackgroundPreparationKind;
  /** Absolute path to the source artifact — INTERNAL ONLY. */
  sourceArtifactPath: string;
  /** Higher runs first. */
  priority: number;
  /** Epoch ms (measured on the injected clock at enqueue time). */
  createdAt: number;
}

/**
 * Lifecycle STATE of an item. Distinct from the reason code (which explains
 * *why* an item reached a terminal state).
 *
 * - `kept-local` is a SAFE terminal outcome: the original was withheld and
 *   nothing was published, but this is expected/non-erroneous behavior (e.g. a
 *   safety rejection or an unavailable provider). It is not `failed`.
 */
export type BackgroundPreparationStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "kept-local";

/**
 * Stable, privacy-safe reason vocabulary. A reason code explains an outcome; it
 * never carries a raw error message, secret, or absolute path. STATUS answers
 * "what state", REASON answers "why".
 */
export const BACKGROUND_REASON_CODES = [
  "background-pending",
  "background-processing",
  "background-completed",
  "background-cancelled",
  "background-timeout",
  "background-provider-unavailable",
  "background-extraction-failed",
  // Distinct from a generic provider outage: the OCR capability was not configured/
  // available, so a scanned/image-only document could not be recovered.
  "background-ocr-unavailable",
  // The document-extraction step recovered too little text and handed the document off
  // to a dependent OCR item (this item itself published nothing — kept local).
  "background-ocr-deferred",
  "background-safety-rejected",
  "background-publication-failed",
  "background-state-corrupt",
] as const;

export type BackgroundReasonCode = (typeof BACKGROUND_REASON_CODES)[number];

/** Terminal (or in-progress) result of processing one item. */
export interface BackgroundPreparationResult {
  itemId: string;
  status: BackgroundPreparationStatus;
  /** Repo-relative path of the published, safety-verified artifact (public-safe). */
  preparedRelpath?: string;
  reasonCode?: BackgroundReasonCode;
  /** Wall-clock ms consumed by processing (measured on the injected clock). */
  elapsedMs: number;
}

/**
 * The idempotency inputs that, together, uniquely identify a piece of work.
 * A completed item with the same key is never re-run; duplicates dedupe.
 */
export interface IdempotencyInputs {
  sourceContentHash: string;
  processorVersion: string;
  policyHash: string;
}

/** Arguments to enqueue a new item. `itemId`/`createdAt` are generated when omitted. */
export interface EnqueueInput extends IdempotencyInputs {
  runId: string;
  contextId: string;
  relpath: string;
  kind: BackgroundPreparationKind;
  /** Absolute path to the source artifact — INTERNAL ONLY. */
  sourceArtifactPath: string;
  priority?: number;
  itemId?: string;
  createdAt?: number;
}

/**
 * Public, path-safe projection of an item + its current outcome. This is the
 * ONLY item shape that may cross a public boundary (CLI/VS Code/agent). It
 * intentionally omits `sourceArtifactPath` and any absolute path.
 */
export interface PublicBackgroundItem {
  itemId: string;
  runId: string;
  contextId: string;
  relpath: string;
  kind: BackgroundPreparationKind;
  priority: number;
  createdAt: number;
  status: BackgroundPreparationStatus;
  reasonCode?: BackgroundReasonCode;
  /** Repo-relative path of the published artifact, when published. */
  preparedRelpath?: string;
}

/**
 * Injectable clock + timer so per-item timeouts and wall-time budgets can be
 * driven by a fake clock in tests (no real sleeps). The default uses the system
 * clock and an unref'd timer (never keeps the process alive on its own).
 */
export interface BackgroundClock {
  /** Wall clock in ms. */
  now(): number;
  /** Schedule `callback` after `ms`; returns a function that cancels it. */
  setTimer(callback: () => void, ms: number): () => void;
}

export const systemBackgroundClock: BackgroundClock = {
  now: () => Date.now(),
  setTimer: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    (timer as { unref?: () => void }).unref?.();
    return () => clearTimeout(timer);
  },
};

/** Map a non-terminal status to its default reason code (for status queries). */
export function defaultReasonForStatus(
  status: BackgroundPreparationStatus,
): BackgroundReasonCode | undefined {
  switch (status) {
    case "pending":
      return "background-pending";
    case "processing":
      return "background-processing";
    case "completed":
      return "background-completed";
    case "cancelled":
      return "background-cancelled";
    case "timed-out":
      return "background-timeout";
    default:
      return undefined;
  }
}
