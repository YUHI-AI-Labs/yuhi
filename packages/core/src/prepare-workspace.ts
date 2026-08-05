import { copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isSafelyYuhiManaged, writeWorkspaceMarker } from "./workspace-marker.js";
import { PDF_INSPECTION_LIMIT_BYTES, OFFICE_DOCUMENT_INSPECTION_LIMIT_BYTES, type DocumentSourceType } from "./document-artifact.js";
import { availableParallelism, totalmem } from "node:os";
import { homedir, platform } from "node:os";
import path from "node:path";
import {
  processorId,
  createStudentAliasContext,
  decodeTextBuffer,
  classifyStudentRecordTable,
  parseDelimitedTable,
  splitTablePreamble,
  requiresPseudonymization,
  tabularVerificationValues,
  tabularResidueCells,
  inspectXlsxRecords,
  pseudonymizeXlsxRecords,
  xlsxContainsAnyValue,
  xlsxCellText,
  tokenEstimate,
  reductionReport,
  type Action,
  type LocalModelProvider,
  type ParsedDelimitedTable,
  type ReductionMode,
  type ReductionReport,
  type ProcessorSpec,
  type TransmissionState,
  type FileDecision,
  type FileInfo,
  type DocumentInspector,
  type StudentAliasContext,
  YUHI_VERSION,
} from "@yuhi/shared";
import { isArchivePath, zipEncryptionFromHeader } from "@yuhi/shared";
import { computeContextId, type ContextIdSourceFile } from "./context-id.js";
import {
  buildDeliveryIntegritySummary,
  type DeliveryIntegritySummary,
} from "./delivery-integrity.js";
import {
  buildContentFamilies,
  duplicateAliasText,
  type ContentFamilyMetrics,
  type FamilyCandidate,
} from "./content-families.js";
import { runDetectors, redactText } from "@yuhi/scanner";
import type { YuhiConfig } from "@yuhi/config";
import { computePlan } from "./plan.js";
// Type-only import — erased at build, so it never loads the compression parser. The
// compression MODULE is loaded lazily (dynamic import) only when `compress: true`.
import type { BudgetFileInput } from "./compression/index.js";
import {
  DEFAULT_PREPARE_SAFETY_MODE,
  escalatesUnverified,
  requiresZeroFindings,
  safetyModeLabel,
  type SafetyMode,
} from "./safety-mode.js";
import { runLocalPreparation } from "./route-executor.js";
import {
  BackgroundQueue,
  privateBackgroundDir,
  buildPublicStatus,
  writePublicStatus,
  writePrivateAliasRegistry,
  type BackgroundPreparationKind,
} from "./background/index.js";
import { writePrivateRunSourceBinding } from "./patch/private-state.js";
import {
  buildWithheldRedactions,
  documentIdFor,
  redactMetadata,
  withheldDisplayName,
} from "./metadata-boundary.js";
import {
  buildPublicPreparedContextSummary,
  type PublicPreparedContextSummary,
} from "./public-prepared-summary.js";
import {
  buildYuhiModeSummary,
  renderYuhiModeHandoff,
  type YuhiModeSummary,
} from "./yuhi-mode-summary.js";

/** The pipeline every summarize target is run through (local model → mask → gate). */
const PREPARE_PIPELINE: ProcessorSpec[] = ["summarize-local", "pseudonymize", "safety-check"];

/**
 * Default hard per-file wall-clock cap on the inline local-model (`summarize-local` /
 * Ollama) call. A stalled local model must NEVER trap the "Preparing safe copies"
 * loop: after this many ms the in-flight request is aborted and the file is routed
 * to kept-local (never delivered un-inspected) so Yuhi Mode still launches.
 */
export const DEFAULT_LOCAL_MODEL_TIMEOUT_MS = 10_000;

/**
 * Injectable clock + timer so the per-file local-model timeout can be driven by a
 * fake clock in tests (no real sleeps). The default uses the system clock and an
 * unref'd `setTimeout` (it never keeps the process alive on its own).
 */
export interface DeadlineScheduler {
  /** Monotonic-ish wall clock in ms. */
  now(): number;
  /** Schedule `callback` after `ms`; returns a function that cancels it. */
  setTimer(callback: () => void, ms: number): () => void;
}

/** Real-time scheduler used in production. */
export const systemDeadlineScheduler: DeadlineScheduler = {
  now: () => Date.now(),
  setTimer: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    (timer as { unref?: () => void }).unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * Stable, privacy-safe warning vocabulary for the local-model reliability fix. Each
 * record carries the repo-relative path only (never an absolute path or any secret /
 * source content) and lives in the manifest / degraded-completion surface — NOT the
 * public aggregate report.
 */
export interface PreparationWarning {
  relpath: string;
  stage: "summarize-local";
  reason:
    | "local-summary-timeout"
    | "local-model-unavailable"
    | "local-model-disabled"
    | "local-summary-deferred";
  /** "kept-local" — the FILE was withheld; "summary-skipped" — an already-delivered
   *  file's optional context summary was skipped (the file itself stays delivered). */
  action: "kept-local" | "summary-skipped";
  /** Wall-clock ms the timed-out call consumed before it was aborted. */
  elapsedMs?: number;
}

/** Result of a time-bounded local-model call. `elapsedMs` (measured on the injected
 *  clock) feeds the cumulative run budget for BOTH outcomes. */
type TimedLocalModelResult<T> =
  | { status: "ok"; value: T; elapsedMs: number }
  | { status: "timeout"; elapsedMs: number };

/**
 * Run a single inline local-model call under a HARD per-file timeout.
 *
 * A fresh `AbortController` is created for this call; when the timeout fires the
 * controller is aborted (so a signal-aware provider cancels its request) and the
 * result resolves as `{ status: "timeout" }` — the loop continues, and if the
 * provider ignores the abort its late result is simply ignored (never awaited, never
 * piled up). The GLOBAL `parentSignal` (user Cancel) still rejects with `AbortError`
 * exactly as before, so intentional cancellation stays fatal while a per-file timeout
 * does not. Only one such call is ever in flight at a time (the loop is sequential).
 */
async function runLocalModelCall<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  scheduler: DeadlineScheduler,
  parentSignal: AbortSignal | undefined,
): Promise<TimedLocalModelResult<T>> {
  if (parentSignal?.aborted) throw new DOMException("prepareWorkspace aborted", "AbortError");
  const controller = new AbortController();
  const start = scheduler.now();
  let cancelTimer: () => void = () => {};
  let onParentAbort: (() => void) | undefined;
  const detach = (): void => {
    cancelTimer();
    if (onParentAbort && parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
  };
  try {
    return await new Promise<TimedLocalModelResult<T>>((resolve, reject) => {
      let settled = false;
      cancelTimer = scheduler.setTimer(() => {
        if (settled) return;
        settled = true;
        controller.abort(); // cancel the wedged provider request (best-effort)
        resolve({ status: "timeout", elapsedMs: Math.max(0, scheduler.now() - start) });
      }, ms);
      onParentAbort = () => {
        if (settled) return;
        settled = true;
        controller.abort();
        reject(new DOMException("prepareWorkspace aborted", "AbortError"));
      };
      parentSignal?.addEventListener("abort", onParentAbort, { once: true });
      work(controller.signal).then(
        (value) => {
          if (settled) return;
          settled = true;
          resolve({ status: "ok", value, elapsedMs: Math.max(0, scheduler.now() - start) });
        },
        (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
    });
  } finally {
    detach();
  }
}

/**
 * Per-format inspection limits (isolated constants — easy to make configurable).
 * There is deliberately NO single all-format 2 MB gate: text and spreadsheets are
 * de-identified regardless of size.
 */
/**
 * Ceiling for loading a NON-PDF file fully into memory to inspect/transform. Text and
 * XLSX are de-identified up to this size (no longer skipped at 2 MB); beyond it a file
 * is passed through unverified with an honest "too large to process locally" warning
 * rather than risking OOM on a 16 GB machine. (True streaming for larger files is a
 * follow-up; the limit is detected and reported, never silently mislabeled.)
 */
export const MAX_INMEMORY_TRANSFORM_BYTES = 128 * 1024 * 1024;

/**
 * Document formats whose ORIGINAL binary must never be delivered to the agent — a
 * sanitized Markdown companion (or a safe placeholder) is delivered instead. Detected
 * by extension so ZIP-based Office files (classified "binary") are still caught.
 */
function documentSourceType(relpath: string): DocumentSourceType | undefined {
  const ext = relpath.slice(relpath.lastIndexOf(".")).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".docm") return "docm";
  if (ext === ".pptx") return "pptx";
  if (ext === ".pptm") return "pptm";
  return undefined;
}

/** Human MB rounding for messages. */
function mbLabel(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1);
}

/**
 * Per-format size strategy. Returns a pass-through warning reason when the file is too
 * large to inspect locally for its type, or `undefined` when it should be inspected/
 * transformed normally. Only SIZE is decided here — explicit policy blocks and
 * symlinks are handled by the caller and always take precedence over size.
 */
export function oversizePassThroughReason(fileType: string, sizeBytes: number): string | undefined {
  if (fileType === "pdf") {
    return sizeBytes > PDF_INSPECTION_LIMIT_BYTES
      ? `PDF is ${mbLabel(sizeBytes)} MB — over the 64 MB PDF inspection limit. ` +
          "Passed through as-is without inspection or transformation. Review before sharing."
      : undefined;
  }
  return sizeBytes > MAX_INMEMORY_TRANSFORM_BYTES
    ? `File is ${mbLabel(sizeBytes)} MB — too large to inspect or transform locally ` +
        "without exhausting memory. Passed through as-is with a warning. Review before sharing."
    : undefined;
}

function cloneStudentAliases(context: StudentAliasContext): StudentAliasContext {
  return {
    identifierToEntity: new Map(context.identifierToEntity),
    entityIdentifiers: new Map(
      [...context.entityIdentifiers].map(([entity, identifiers]) => [
        entity,
        new Map(identifiers),
      ]),
    ),
    columnTokens: new Map(context.columnTokens),
    columnTokenCounts: new Map(context.columnTokenCounts),
    nextEntity: context.nextEntity,
    attributeTokens: new Map(context.attributeTokens),
    // Must be carried: dropping it would re-mint a fresh token prefix per file and
    // silently break cross-file linkage (#11).
    entityBucketTokens: new Map(context.entityBucketTokens),
    // Carried for the same reason: dropping these would silently break cross-format
    // name/email reuse in prose (0.4.7 — see `text-deidentify.ts`).
    directValueTokens: new Map(context.directValueTokens),
    directValueEntity: new Map(context.directValueEntity),
  };
}

/** One prepared (or skipped) file, as recorded in the manifest and the report. */
export interface PreparedFileEntry {
  /**
   * Repo-relative POSIX path as presented in the prepared output tree. When the
   * original path contained a direct identifier, this is the PSEUDONYMIZED path
   * (what Claude sees); the original is kept only in `originalRelpath` below.
   */
  relpath: string;
  /**
   * The original repo-relative path when `relpath` was pseudonymized to strip an
   * identifier from the filename. PRIVATE mapping — held in memory for the local UI
   * and never written to an agent-visible surface (see `metadata-boundary.ts`).
   */
  originalRelpath?: string;
  /**
   * Stable public identity of this file's source document (`doc-<hex>`). This is what
   * agent-visible surfaces use to line an entry up across manifest / status / summary
   * when its filename may not cross the boundary.
   */
  documentId?: string;
  /** The policy action that routed this file. */
  action: Action;
  /** Preparation outcome; "skipped" for verbatim/omitted files that weren't run. */
  status: "ok" | "blocked" | "error" | "skipped";
  outcome?:
    | "included-unchanged"
    | "included-transformed"
    | "included-unverified"
    | "excluded-by-user"
    | "excluded-by-policy"
    | "local-only-unverified"
    // v0.3.6: the original carries a KNOWN sensitive finding (not merely "not yet
    // inspected"), so it never leaves the machine in any Safety Mode; only a
    // verified companion may reach the agent.
    | "local-only-known-risk"
    | "local-only-unsupported"
    | "local-only-transformation-failed"
    | "blocked-high-risk"
    | "malformed"
    | "failed"
    // v0.3.5: the file's original stays local-only, but a persistent background item
    // was successfully enqueued to produce its safe companion after Yuhi Mode launches.
    | "background-processing-pending";
  /** Public, agent-neutral availability state. Never implies verification from mere inclusion. */
  availabilityStatus?: AgentAvailabilityStatus;
  inspectionStatus?: "verified" | "pending" | "failed" | "not-applicable";
  backgroundStatus?: "none" | "pending" | "processing" | "completed" | "failed" | "cancelled";
  originalShared?: boolean;
  warningCode?: "inspection-pending" | "inspection-failed" | "verification-incomplete";
  knownFindingsPresent?: boolean;
  transmission: TransmissionState;
  beforeChars: number;
  afterChars: number;
  /** true when the file was intentionally left out of the prepared output. */
  omitted?: boolean;
  /** Non-sensitive error note when status === "error". */
  error?: string;
  /** Metadata-only transformation labels; never contains source content. */
  transformations?: ("summarized" | "aggregated" | "pseudonymized" | "masked")[];
  /** Number of values changed by the local pseudonymization/masking processor. */
  maskedValues?: number;
  /** True only when an included Prepared Workspace file differs byte-for-byte from source. */
  transformed?: boolean;
  /**
   * Document-processing record when this entry is a sanitized companion / placeholder
   * for a PDF/DOCX/PPTX original that was NOT shared with the agent. `relpath` is the
   * delivered companion; `originalRelpath` is the source document (manifest-only).
   */
  document?: {
    sourceType: DocumentSourceType;
    sourceSize: number;
    extractionMethod: string;
    extractionStatus: "extracted" | "unsupported" | "failed" | "skipped-oversize" | "pending";
    deliveredArtifactType:
      | "sanitized-pdf-companion"
      | "sanitized-docx-companion"
      | "sanitized-pptx-companion"
      | "safe-placeholder"
      | "none";
    /** ALWAYS false for PDF/DOCX/DOCM/PPTX/PPTM — the original never reaches the agent. */
    originalSharedWithAgent: boolean;
    redactionCount: number;
    residualNameRisk: boolean;
    macroDetected: boolean;
    embeddedObjectCount: number;
    imageCount: number;
    hiddenContentDetected: boolean;
    extractedParagraphCount: number;
    extractedTableCount: number;
    extractedSlideCount: number;
    extractedNotesCount: number;
    finalArtifactScanStatus?: "clean" | "identifier-warning" | "credential-removed";
  };
  /**
   * Result of the mandatory FINAL-ARTIFACT rescan: the delivered file was reopened
   * from disk and its actual bytes scanned. `true` = no source identifier survived;
   * `false` = identifiers (or credentials) were found in the delivered file, so it
   * must never be reported as de-identified/verified. `undefined` = not applicable.
   */
  finalRescanVerified?: boolean;
  /**
   * TRUE when the UNTRANSFORMED original was delivered because a safe transformation
   * could not be produced or verified. This is the fact behind "Raw fallback used";
   * it must never be hardcoded or re-derived by a render layer.
   */
  rawFallback?: boolean;
  /** Set when this artifact is a redundant copy of another delivered representation
   *  and was replaced by a short alias pointing at the canonical one (#15/P1-B). */
  duplicateOfFamily?: string;
  canonicalRelpath?: string;
  /** Public document id of the canonical representation, for alias traceability. */
  canonicalDocumentId?: string;
  /**
   * Tri-state result of the post-transformation privacy scan for THIS file.
   * `not-applicable` means the scan was never run (nothing was transformed);
   * `failed` means residue was found. A failed scan must never be presented as
   * "not applicable" — that reads as "this check does not apply here".
   */
  postTransformScan?: "passed" | "failed" | "not-applicable";
  /** Privacy-safe aggregate finding categories persisted in manifest schema v2. */
  findingCategoryCounts?: Record<string, number>;
  /** Privacy-safe aggregate finding severities persisted in manifest schema v2. */
  findingSeverityCounts?: Record<string, number>;
  /** High/critical findings left unresolved in a file sent unchanged. */
  unresolvedHighRiskCount?: number;
  inspection?: {
    fileType: FileInfo["inspection"]["fileType"];
    inspectionAttempted: boolean;
    inspectionSucceeded: boolean;
    parserAvailable: boolean;
    scannerAvailable: boolean;
    transformerAvailable: boolean;
    postTransformVerifierAvailable: boolean;
    contentVerified: boolean;
    documentStatus?: "inspected" | "unavailable" | "failed";
    extractionMethod?: "pdf-text" | "ocr" | "none";
    pageCount?: number;
    warnings?: string[];
    summaryStatus?: "created" | "rejected" | "unavailable";
    summaryRelpath?: string;
  };
  limitation?:
    | "inspection-unavailable"
    | "inspection-incomplete"
    | "transformation-unavailable"
    | "verification-failed";
  /** Why a transform failed — set on degraded-included AND kept-local files. Never
   *  silently "safety": an unknown internal error is categorized `unknown`, not a
   *  safety decision, and its exact reason is preserved in `error`. */
  failureCategory?:
    | "structural"
    | "conflicting-identifiers"
    | "reidentification-risk"
    | "unresolved-secret"
    | "unknown";
  /** Set when a Safety Mode preset (Strict / Maximum Privacy) kept this file local
   *  even though Balanced would have delivered it — an escalation, not a failure. */
  keptLocalBySafetyMode?: SafetyMode;
  /**
   * v0.3.3 structure-compression outcome for this delivered file. Only set when the
   * optional compression pass ran (`compress: true`); otherwise absent and the run is
   * byte-for-byte identical to a run without compression.
   *   `full`       — delivered unchanged.
   *   `compressed` — implementation bodies omitted (delivered file overwritten).
   *   `excluded`   — dropped from the delivered workspace to fit the token budget.
   */
  contextRepresentation?: "full" | "compressed" | "excluded";
  /** Flat budget/compression reason (user-included/entry-point/compressed/parse-failed/budget/...). */
  compressionReason?: string;
  /** Estimated tokens of the delivered file BEFORE compression. */
  originalTokens?: number;
  /** Estimated tokens actually delivered (0 when excluded). */
  preparedTokens?: number;
}

export type AgentAvailabilityStatus =
  | "available-verified"
  | "available-with-warning"
  | "transformed-available"
  | "background-processing"
  | "excluded-known-risk"
  | "excluded-by-user"
  | "processing-failed";

function refreshPublicAvailability(files: PreparedFileEntry[]): void {
  for (const file of files) {
    const pending = file.outcome === "background-processing-pending";
    const included = !file.omitted && file.status === "ok" && file.transmission === "approved";
    const warning = included && (pending || file.outcome === "included-unverified");
    file.availabilityStatus = file.outcome === "excluded-by-user"
      ? "excluded-by-user"
      : included && file.transformed
        ? "transformed-available"
        : warning
          ? "available-with-warning"
          : included
            ? "available-verified"
            : pending
              ? "background-processing"
              : file.status === "error" || file.outcome === "failed" || file.outcome === "local-only-transformation-failed"
                ? "processing-failed"
                : "excluded-known-risk";
    file.inspectionStatus = warning || pending
      ? "pending"
      : file.availabilityStatus === "processing-failed"
        ? "failed"
        : included
          ? "verified"
          : "not-applicable";
    file.backgroundStatus = pending ? "pending" : file.backgroundStatus ?? "none";
    file.originalShared = file.document?.originalSharedWithAgent ??
      (included && !file.transformed && file.outcome === "included-unverified");
    if (warning) file.warningCode = "inspection-pending";
    else if (file.availabilityStatus === "processing-failed") file.warningCode = "inspection-failed";
    else delete file.warningCode;
    file.knownFindingsPresent = Object.values(file.findingCategoryCounts ?? {})
      .some((count) => count > 0);
  }
}

/** One file's line in the compression summary (aggregate + relpath — public-safe). */
export interface CompressionFileReport {
  relpath: string;
  representation: "full" | "compressed" | "excluded";
  reason: string;
  originalTokens: number;
  preparedTokens: number;
}

/**
 * Aggregate outcome of the optional v0.3.3 structure-compression pass, mirroring the
 * budget selector's summary. Present on `PrepareReport` only when `compress: true`.
 * All numbers are aggregate; the per-file list carries only relpaths (already shown in
 * the review), so this whole structure is safe to surface to the CLI / VS Code.
 */
export interface CompressionReport {
  originalTokens: number;
  preparedTokens: number;
  reductionPercent: number;
  fullFiles: number;
  compressedFiles: number;
  excludedFiles: number;
  compressionReductionTokens: number;
  exclusionReductionTokens: number;
  targetBudget: number | null;
  actualTokens: number;
  status: "within-budget" | "best-effort" | "no-budget";
  budgetReason?: string;
  warnings: string[];
  files: CompressionFileReport[];
}

/** Classify a transformation-failure reason. Structural failures are eligible for
 *  degraded inclusion; the rest are concrete safety reasons or an explicit unknown. */
export function classifyTransformFailure(
  reason: string,
): "structural" | "conflicting-identifiers" | "reidentification-risk" | "unknown" {
  if (
    reason.startsWith("Malformed delimited table:") ||
    reason.startsWith("Workbook contains no supported identifiable table") ||
    reason.startsWith("Unsupported")
  ) {
    return "structural";
  }
  if (
    reason.includes("Conflicting direct identifier") ||
    reason.includes("could not preserve entity uniqueness")
  ) {
    return "conflicting-identifiers";
  }
  if (
    reason.includes("changed a non-identifier value") ||
    reason.includes("failed privacy verification") ||
    reason.includes("failed Yuhi privacy rescan")
  ) {
    return "reidentification-risk";
  }
  return "unknown";
}

/**
 * Parse a delimited table, transparently recovering the table region when strict
 * parsing fails only because of a leading metadata preamble. Mirrors the shared
 * transform's preamble handling so verification/metrics see the same rows.
 */
function parseTabularRegion(text: string): ParsedDelimitedTable {
  try {
    return parseDelimitedTable(text);
  } catch (error) {
    if (error instanceof Error && /inconsistent column count/.test(error.message)) {
      const stripped = splitTablePreamble(text);
      if (stripped) return stripped.table;
    }
    throw error;
  }
}

/** Metadata-safe handoff summary for files not copied into the workspace. Individual
 * names stay in the user-only Review surface, never in agent instructions. */
function describeUnavailableFiles(files: PreparedFileEntry[]): string[] {
  const kept = files.filter((f) => f.omitted);
  if (kept.length === 0) return [];
  const byCategory = new Map<string, number>();
  for (const file of kept) {
    const category = file.failureCategory ?? file.outcome ?? "policy";
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
  }
  return [
    "## Files unavailable to the agent",
    "",
    `${kept.length} file(s) were excluded because of an actual finding or explicit policy.`,
    "Individual names are available only in Yuhi's user-facing Review file decisions.",
    "",
    ...[...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
      ([category, count]) => `- ${category}: ${count}`,
    ),
    "",
  ];
}

/** Metadata-safe count of files available with a warning. */
function describeUnverifiedFiles(files: PreparedFileEntry[]): string[] {
  const unverified = files.filter(
    (f) =>
      !f.omitted &&
      (f.outcome === "included-unverified" || f.outcome === "background-processing-pending"),
  );
  if (unverified.length === 0) return [];
  return [
    "## Files included but not fully verified",
    "",
    `${unverified.length} file(s) are available with warnings while local inspection continues.`,
    "Inspection unavailable or pending does not imply that a file is safe or verified.",
    "",
  ];
}

/** Maps each prepared output file back to its source path. */
export interface ProvenanceEntry {
  relpath: string;
  source: string;
  action: Action;
}

/** Structured result returned to the CLI / VS Code. */
export interface PrepareReport {
  runId: string;
  /**
   * Deterministic, agent-independent Context ID (`sha256:<hex>`, v0.3.4). Same
   * repo state + same prep settings ⇒ identical id; changing the AGENT does not
   * change it. Computed from the same inputs the pipeline already has (no re-scan).
   *
   * ALWAYS present on a report produced by {@link prepareWorkspace}. Optional on
   * the TYPE only so a report reconstructed from a legacy on-disk manifest (which
   * predates the field) still satisfies the interface.
   */
  contextId?: string;
  /** Absolute path of <dir>/.yuhi/prepared/<runId>. */
  outDir: string;
  /** Aggregate reduction across processed files (token values are estimates). */
  report: ReductionReport;
  files: PreparedFileEntry[];
  /** Files whose safety-check blocked transmission (never written as sendable). */
  blocked: PreparedFileEntry[];
  /** Files whose preparation errored (e.g. provider unavailable). */
  errors: PreparedFileEntry[];
  /** Policy/scanner provenance used for metadata-only review and metrics. */
  decisions?: FileDecision[];
  /** Verified count of changed source files. Successful preparation currently reports 0. */
  sourceModified: number;
  /** The resolved effective Safety Mode this run was prepared with. */
  safetyMode: SafetyMode;
  /**
   * v0.3.3 local-model reliability: present when the inline `summarize-local` model
   * timed out or was disabled by the circuit breaker / budget. Lets the CLI / VS Code
   * reach "Ready … with warnings" instead of hanging in "Preparing…". Public-safe:
   * warnings carry repo-relative paths only, never absolute paths or content.
   */
  degraded?: {
    localModelDisabled: boolean;
    /** Files withheld (kept local) because the local model timed out / was disabled. */
    filesKeptLocalAfterTimeout: number;
    /** How many summarize-local calls actually hit the per-file timeout. */
    localModelTimeouts: number;
    /** Why the circuit opened, when it did. */
    circuitBreakerReason?:
      | "per-file-timeout"
      | "time-budget-exceeded"
      | "call-count-exceeded"
      | "deferred";
    warnings: PreparationWarning[];
  };
  /** v0.3.3 structure-compression summary; present ONLY when `compress: true`. */
  compression?: CompressionReport;
  /** One public-safe summary shared by every product surface. */
  publicSummary?: PublicPreparedContextSummary;
  /** Canonical user-facing Yuhi Mode projection shared by all product surfaces. */
  yuhiModeSummary?: YuhiModeSummary;
  /** Duplicate-content families over the delivered artifacts (#15/P1-B). */
  contentFamilies?: ContentFamilyMetrics;
  /** Privacy-safe tabular acceptance metadata shared by CLI and VS Code. */
  tabularAcceptance?: {
    entitiesPseudonymized: number;
    identifierColumnsTransformed: number;
    analyticalColumnsPreserved: number;
    postTransformScanPassed: boolean;
    malformedTables: number;
    unverifiedTransformations: number;
    /**
     * TRUE when at least one untransformed original was delivered as a fallback.
     * Was typed as the literal `false`, so no surface could ever report a raw
     * fallback that actually happened (#12).
     */
    rawFallbackUsed: boolean;
    /** Per-surface delivery facts; the single source of truth for render layers. */
    deliveryIntegrity?: DeliveryIntegritySummary;
    launchAllowed: boolean;
    claudeCodeStarted: false;
    unsupportedOrUnverifiedFiles?: number;
    restrictedUnresolvedFiles?: number;
    hasLimitations?: boolean;
    pdfInspected?: number;
    ocrProcessed?: number;
    unverifiedDocuments?: number;
    documentSummariesCreated?: number;
    documentSummariesRejected?: number;
    documentContextBeforeTokens?: number;
    documentContextAfterTokens?: number;
    textDocumentsInspected?: number;
    agentHandoffCreated?: boolean;
    localModelProvider?: string;
    localModelName?: string;
    localModelRequests?: number;
    localModelSucceeded?: number;
    localModelFailed?: number;
    localModelInputChars?: number;
    localModelOutputChars?: number;
    localModelElapsedMs?: number;
    localModelMaxConcurrency?: number;
    localModelConfiguredParallelism?: number;
  };
}

export interface PrepareWorkspaceOptions {
  /** Local model provider used for the summarize-local step. */
  provider?: LocalModelProvider;
  /** Lazily creates a provider only when a summarize-local step is reached. */
  providerFactory?: () => LocalModelProvider;
  /** Optional local document inspector override (primarily for embedding/tests). */
  documentInspector?: DocumentInspector;
  /** Include PDFs as pending and perform optional document intelligence after launch. */
  deferDocumentInspection?: boolean;
  /** Loaded config (currently informational; budget.reduction_mode is a mode fallback). */
  config?: YuhiConfig;
  /** Reduction aggressiveness; falls back to config.budget.reduction_mode, else "balanced". */
  mode?: ReductionMode;
  /** Cancellation. */
  signal?: AbortSignal;
  /** Optional UI progress callback (safe-to-show messages only). */
  onProgress?: (msg: string) => void;
  /** Structured, count-based progress for UI surfaces. Never contains file paths. */
  onProgressDetail?: (event: PreparationProgressEvent) => void;
  /** Override adaptive local-model request concurrency. */
  localModelParallelism?: number;
  /** Optional caller-supplied ISO timestamp for a deterministic manifest.createdAt. */
  createdAt?: string;
  /** Agent id to route for (defaults to config default). */
  agent?: string;
  /** Test seam used to simulate source races immediately before the final integrity check. */
  beforeIntegrityVerification?: () => void | Promise<void>;
  /** Test/embedding override for Yuhi's managed Prepared Workspace base directory. */
  managedWorkspaceBase?: string;
  /** Explicit, caller-confirmed exclusions for a new recovery run. */
  excludeRelpaths?: readonly string[];
  /** Explicit, caller-confirmed warning inclusion. Known credentials/policy blocks still win. */
  includeWithWarningRelpaths?: readonly string[];
  /** User-owned type decisions, expressed as lowercase extensions including the dot. */
  includeWithWarningExtensions?: readonly string[];
  excludeExtensions?: readonly string[];
  /** Safety Mode preset — shapes the effective policy (defaults to Balanced). */
  safetyMode?: SafetyMode;
  /** Deterministic lifecycle seam for cancellation/recovery integration. */
  onCheckpoint?: (checkpoint: PreparationCheckpoint) => void;
  /**
   * Opt-in v0.3.3 structure compression. When false (default) NOTHING compression-
   * related — including the `typescript` parser — is ever loaded, and the prepared
   * output is byte-for-byte identical to today. When true, delivered source files may
   * be body-omitted or (under a token budget) excluded from the delivered workspace.
   * SOURCE FILES ARE NEVER TOUCHED; only files under the managed workspace change.
   */
  compress?: boolean;
  /** User-facing compression choice. `auto` is the recommended default. */
  compressionMode?: "off" | "auto" | "on";
  /** Best-effort token budget for the delivered context; null/undefined = no budget. */
  tokenBudget?: number | null;
  /** Files at/under this many tokens stay full (too small to be worth compressing). */
  compressionThresholdTokens?: number;
  /**
   * Hard per-file wall-clock cap (ms) on the inline local-model (`summarize-local` /
   * Ollama) call. A single stalled call must never trap the loop. Default
   * `DEFAULT_LOCAL_MODEL_TIMEOUT_MS` (10 000). On exceed, the file is kept local and
   * the circuit opens (see below).
   */
  localModelTimeoutMs?: number;
  /**
   * Cumulative local-model wall-time budget (ms) for the WHOLE run. When the local
   * model is not hung but merely slow across thousands of files, exceeding this cap
   * opens the circuit so the run still finishes fast. Default 60 000. Measured on
   * `deadlineScheduler` so it is deterministic in tests.
   */
  localModelTotalBudgetMs?: number;
  /**
   * Max provider-backed `summarize-local` calls per run. Exceeding it opens the
   * circuit (belt-and-braces with the time budget). Default 50. `0` opens the circuit
   * from the START — no provider call is ever made (see `deferLocalSummary`).
   */
  localModelMaxCalls?: number;
  /**
   * Foreground-budget-zero: when true (or `localModelMaxCalls === 0`) the circuit is
   * OPEN FROM THE START — every summarize target is immediately kept local with ZERO
   * provider calls and zero waiting. Used by VS Code's foreground prepare so Yuhi Mode
   * launches instantly; the local summaries run later in the background. Kept-local
   * files are never delivered un-inspected.
   */
  deferLocalSummary?: boolean;
  /** Injectable clock + timer for the local-model timeout / budget (tests use a fake
   *  clock so timeouts fire with no real sleeps). Defaults to the system clock. */
  deadlineScheduler?: DeadlineScheduler;
}

/** Defaults for the local-model reliability caps (all overridable via options). */
export const DEFAULT_LOCAL_MODEL_TOTAL_BUDGET_MS = 60_000;
export const DEFAULT_LOCAL_MODEL_MAX_CALLS = 50;

export type PreparationCheckpoint = "workspace-created";

export type PreparationProgressPhase =
  | "discover"
  | "scan"
  | "prepare"
  | "context"
  | "verify";

export interface PreparationProgressEvent {
  phase: PreparationProgressPhase;
  label: string;
  current?: number;
  total?: number;
  elapsedSeconds: number;
}

/** Conservative local-model concurrency. A typical 16 GB Windows PC uses 2. */
export function recommendedLocalModelParallelism(
  memoryBytes = totalmem(),
  logicalCpus = availableParallelism(),
): number {
  const gib = memoryBytes / (1024 ** 3);
  if (gib < 14 || logicalCpus < 4) return 1;
  if (gib < 28 || logicalCpus < 8) return 2;
  return 3;
}

export type PrepareWorkspaceOutcome =
  | { kind: "success"; report: PrepareReport; launchAllowed: boolean }
  | { kind: "cancelled"; launchAllowed: false };

/** OS-appropriate Yuhi-owned location, deliberately outside the source workspace. */
export function managedWorkspaceBaseDir(): string {
  if (process.env.YUHI_HOME) return path.join(process.env.YUHI_HOME, "workspaces");
  if (platform() === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Yuhi", "workspaces");
  }
  if (platform() === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "Yuhi", "workspaces");
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), "yuhi", "workspaces");
}

/** How many recent prepared workspaces are always retained, newest first. */
export const KEEP_RECENT_WORKSPACES = 3;
/** Prepared workspaces beyond the retained set are pruned once older than this. */
export const WORKSPACE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Prune old prepared workspaces so they cannot accumulate and fill the disk (each
 * run is a full copy — several GB for a large workspace, and a nearly-full disk
 * causes preparation write failures). Keeps the `KEEP_RECENT_WORKSPACES` newest runs
 * unconditionally, then deletes any older run that is also older than
 * `WORKSPACE_MAX_AGE_MS`. The current run is never touched. Best-effort: cleanup must
 * never fail a preparation, so all errors are swallowed. Returns the paths removed.
 */
export async function pruneManagedWorkspaces(
  managedBase: string,
  currentRunId: string,
  now: number,
): Promise<string[]> {
  const removed: string[] = [];
  try {
    const entries = await readdir(managedBase, { withFileTypes: true });
    const runs: { name: string; mtimeMs: number }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === currentRunId) continue;
      try {
        const info = await stat(path.join(managedBase, entry.name));
        runs.push({ name: entry.name, mtimeMs: info.mtimeMs });
      } catch {
        /* unreadable entry — skip */
      }
    }
    runs.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    const cutoff = now - WORKSPACE_MAX_AGE_MS;
    for (const run of runs.slice(KEEP_RECENT_WORKSPACES)) {
      if (run.mtimeMs >= cutoff) continue; // still within the retention window
      const dir = path.join(managedBase, run.name);
      // SAFETY: only ever delete a directory we can positively confirm Yuhi created
      // (valid `.yuhi-managed.json` marker, not a symlink). A missing/invalid marker
      // or a non-Yuhi directory is left untouched — never deleted by directory name.
      if (!(await isSafelyYuhiManaged(dir))) continue;
      try {
        await rm(dir, { recursive: true, force: true });
        removed.push(run.name);
      } catch {
        /* best-effort — a locked/in-use run is left for next time */
      }
    }
  } catch {
    /* base dir missing or unreadable — nothing to prune */
  }
  return removed;
}

export const SOURCE_INTEGRITY_ERROR =
  "Source workspace changed during preparation. Yuhi cannot verify source integrity for this run.";

interface SourceIntegrityEntry {
  type: "file" | "symlink";
  device: number;
  inode: number;
  digest?: string;
  linkTarget?: string;
  resolvedTarget?: string;
}

function normalizedSourcePath(relpath: string): string {
  const normalized = path.posix.normalize(relpath.replaceAll("\\", "/")).replace(/^\.\/+/, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(SOURCE_INTEGRITY_ERROR);
  }
  return normalized;
}

/**
 * True when a pure-digit token reads as a date or time rather than an ID: `20260715`
 * (YYYYMMDD), `202607` (YYYYMM), `0722` (MMDD), `110046` (HHMMSS). Calendar-valid
 * only — `9999990001` has no 99th month, so it is not a date.
 */
function isDateLikeDigits(token: string): boolean {
  const asMonth = (value: string): boolean => Number(value) >= 1 && Number(value) <= 12;
  const asDay = (value: string): boolean => Number(value) >= 1 && Number(value) <= 31;
  if (token.length === 8) {
    return asMonth(token.slice(4, 6)) && asDay(token.slice(6, 8));
  }
  if (token.length === 6) {
    // YYYYMM, or a HHMMSS timestamp (`110046`).
    if (asMonth(token.slice(4, 6))) return true;
    return Number(token.slice(0, 2)) <= 23 && Number(token.slice(2, 4)) <= 59 && Number(token.slice(4, 6)) <= 59;
  }
  return token.length <= 4;
}

/**
 * A path token is a direct identifier if it looks like a keyed ID (letter prefix
 * + digits, e.g. `A000000`, `EMP12345`), contains an email, or is a long pure-digit
 * run that is NOT a date/time (`9999990001` — a real student number; school exports
 * arrive as `9999990001 評定-0722.xlsx`). Short digit groups and calendar-valid dates
 * stay intact so useful non-identifying context in the name survives.
 */
function isIdentifierToken(token: string): boolean {
  if (token.includes("@")) return true;
  if (/^\d{5,}$/.test(token) && !isDateLikeDigits(token)) return true;
  return /^[A-Za-z]{1,6}\d{3,}[A-Za-z0-9]*$/.test(token);
}

/**
 * Replace direct-identifier tokens in each segment of a repo-relative path with a
 * stable, non-reversible pseudonym (`ID-<hash>`), keeping directory structure,
 * separators, dates, and the file extension intact. Deterministic within a
 * workspace (same salt + token → same pseudonym), so a joinable identifier that
 * appears in several filenames maps consistently. The reverse mapping is never
 * derivable from the output — it lives only in the manifest.
 */
function pseudonymizeIdentifierPath(relpath: string, salt: string): string {
  const token = (value: string): string =>
    "ID-" + createHash("sha256").update(`${salt}:filename:${value}`).digest("hex").slice(0, 8);
  const rewriteSegment = (segment: string): string =>
    segment
      // Split on separators but KEEP them, so the name reads the same minus the ID.
      .split(/([-_.\s]+)/)
      .map((part) => (isIdentifierToken(part) ? token(part) : part))
      .join("");
  const ext = path.posix.extname(relpath);
  const withoutExt = ext ? relpath.slice(0, -ext.length) : relpath;
  return (
    withoutExt
      .split("/")
      .map((segment) => rewriteSegment(segment))
      .join("/") + ext
  );
}

function containedBy(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

export const INTEGRITY_HASH_CONCURRENCY = Math.min(8, availableParallelism());
const INTEGRITY_FILE_TIMEOUT_MS = 30_000;

async function streamHashForIntegrity(absPath: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException("prepareWorkspace aborted", "AbortError");
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absPath);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(hash.digest("hex"));
    };
    const abort = () => {
      const error = signal?.aborted
        ? new DOMException("prepareWorkspace aborted", "AbortError")
        : new Error(SOURCE_INTEGRITY_ERROR);
      stream.destroy(error);
    };
    const timer = setTimeout(abort, INTEGRITY_FILE_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on("error", (error) => finish(error));
    stream.on("end", () => finish());
  });
}

/**
 * OS-generated files that the operating system rewrites on its own schedule
 * (Finder touches `.DS_Store` whenever a folder is viewed). They are never
 * meaningful source content, and a preparation run can easily outlive one of
 * their mutations — so they MUST be excluded from the source-integrity assertion,
 * otherwise a benign `.DS_Store` change fails the entire preparation. This never
 * relaxes integrity for real content; only OS junk is exempted.
 */
function isVolatileSourcePath(relpath: string): boolean {
  const segments = relpath.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (base === ".DS_Store" || base === "Thumbs.db" || base === "ehthumbs.db") return true;
  if (base === "desktop.ini" || base === ".localized") return true;
  if (base.startsWith("._")) return true; // AppleDouble resource forks
  return segments.some(
    (segment) =>
      segment === ".Spotlight-V100" ||
      segment === ".Trashes" ||
      segment === ".fseventsd" ||
      segment === ".TemporaryItems" ||
      segment === "__MACOSX",
  );
}

async function captureSourceIntegrity(
  root: string,
  files: FileInfo[],
  options: {
    signal?: AbortSignal;
    phase: "before" | "after";
    onProgress?: (message: string) => void;
  },
): Promise<Map<string, SourceIntegrityEntry>> {
  try {
    const rootReal = await realpath(root);
    const snapshot = new Map<string, SourceIntegrityEntry>();
    let nextIndex = 0;
    let completed = 0;
    const capture = async (info: FileInfo): Promise<void> => {
      if (options.signal?.aborted) {
        throw new DOMException("prepareWorkspace aborted", "AbortError");
      }
      const relpath = normalizedSourcePath(info.relpath);
      // Skip OS-generated volatile files so their background churn (e.g. Finder
      // rewriting `.DS_Store` mid-run) can never fail the whole preparation. Both
      // the "before" and "after" passes skip identically, so the sets stay aligned.
      if (isVolatileSourcePath(relpath)) return;
      if (snapshot.has(relpath)) throw new Error(SOURCE_INTEGRITY_ERROR);
      const absPath = path.resolve(root, ...relpath.split("/"));
      if (!containedBy(path.resolve(root), absPath) || path.resolve(info.absPath) !== absPath) {
        throw new Error(SOURCE_INTEGRITY_ERROR);
      }
      const stat = await lstat(absPath);
      if (stat.isSymbolicLink()) {
        if (!info.flags.isSymlink) throw new Error(SOURCE_INTEGRITY_ERROR);
        const linkTarget = await readlink(absPath);
        const resolved = await realpath(absPath);
        if (!containedBy(rootReal, resolved)) throw new Error(SOURCE_INTEGRITY_ERROR);
        snapshot.set(relpath, {
          type: "symlink",
          device: stat.dev,
          inode: stat.ino,
          linkTarget,
          resolvedTarget: path.relative(rootReal, resolved).replaceAll(path.sep, "/"),
        });
      } else {
        if (!stat.isFile() || info.flags.isSymlink) throw new Error(SOURCE_INTEGRITY_ERROR);
        snapshot.set(relpath, {
          type: "file",
          device: stat.dev,
          inode: stat.ino,
          digest: await streamHashForIntegrity(absPath, options.signal),
        });
      }
      completed += 1;
      if (completed === files.length || completed % 25 === 0) {
        options.onProgress?.(
          `Verifying source workspace integrity (${options.phase} ${completed}/${files.length})`,
        );
      }
    };
    const worker = async (): Promise<void> => {
      while (nextIndex < files.length) {
        const index = nextIndex;
        nextIndex += 1;
        await capture(files[index]!);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(INTEGRITY_HASH_CONCURRENCY, Math.max(1, files.length)) },
        () => worker(),
      ),
    );
    return snapshot;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(SOURCE_INTEGRITY_ERROR);
  }
}

/**
 * Fail-closed source-integrity assertion: any change to a NON-volatile source file
 * between the before/after snapshots aborts the run (TOCTOU / symlink-swap / type
 * confusion defense — see the "fail-closed source integrity" tests). Volatile
 * OS-generated files (`.DS_Store`, …) are already excluded at capture time, so their
 * background churn cannot reach this assertion.
 */
/** List the source paths that changed between the before/after snapshots (added,
 *  removed, or content/identity change). Non-throwing — used both to fail closed and
 *  to report WHICH files changed for diagnosis. */
function listChangedIntegrity(
  before: Map<string, SourceIntegrityEntry>,
  after: Map<string, SourceIntegrityEntry>,
): string[] {
  const changed = new Set<string>();
  for (const [relpath, expected] of before) {
    const actual = after.get(relpath);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) changed.add(relpath);
  }
  for (const relpath of after.keys()) if (!before.has(relpath)) changed.add(relpath);
  return [...changed];
}

function assertSameIntegrity(
  before: Map<string, SourceIntegrityEntry>,
  after: Map<string, SourceIntegrityEntry>,
): void {
  if (listChangedIntegrity(before, after).length > 0) throw new Error(SOURCE_INTEGRITY_ERROR);
}

function findingCategory(detector: string): string {
  const id = detector.toLowerCase();
  if (id === "tabular-direct-identifier-column") return "direct-identifier-column";
  if (id.startsWith("tabular-associated-")) return id.replace("tabular-associated-", "");
  if (id === "tabular-malformed-sensitive-data") return "malformed-sensitive-table";
  if (id.includes("email")) return "email";
  if (id.includes("phone")) return "phone";
  if (id.includes("student")) return "student-id";
  if (id.includes("employee")) return "employee-id";
  if (id.includes("salary") || id.includes("tax")) return "salary-or-tax";
  if (id.includes("bank") || id.includes("iban")) return "bank-account";
  if (id.includes("national") || id.includes("ssn")) return "national-id";
  if (id.includes("private-key")) return "private-key";
  // An entropy hit is an unclassified credential, not a benign string.
  if (id.includes("entropy")) return "credential";
  if (id.includes("token")) return "access-token";
  if (id.includes("key") || id.includes("secret") || id.includes("entropy")) return "credential";
  return id || "custom";
}

/** Actions kept out of the prepared output entirely. */
function isExcludedAction(action: Action): boolean {
  return (
    action === "block" ||
    action === "local-only" ||
    action === "ask" ||
    action === "inject" ||
    action === "metadata-only"
  );
}

/** A file is a summarize target if routed prepare-locally / summarize-local, or its
 *  rule pipeline explicitly asks for the local-model summarize step. */
function isSummarizeTarget(decision: FileDecision): boolean {
  if (decision.action === "prepare-locally" || decision.action === "summarize-local") return true;
  return (decision.processors ?? []).some((p) => processorId(p) === "summarize-local");
}

function isRedactTarget(decision: FileDecision): boolean {
  return decision.action === "redact";
}

/**
 * Shared "prepare to disk" API used by both the CLI and the VS Code extension.
 *
 * Scans `dir`, routes each file via the policy, then for every summarize target runs
 * the LOCAL preparation pipeline (summarize-local → pseudonymize → safety-check).
 * `allow` files are copied verbatim; excluded routes (keep-local / exclude / runtime-only
 * / metadata-only / ask) and binary/symlink files are omitted. Nothing is ever sent to a
 * cloud service and SOURCE FILES ARE NEVER MODIFIED — output is written only under
 * Yuhi's OS-managed workspace directory under an opaque run id.
 */
export async function prepareWorkspace(
  dir: string,
  options: PrepareWorkspaceOptions = {},
): Promise<PrepareReport> {
  const { provider, providerFactory, config, mode, signal, onProgress, onProgressDetail, createdAt, agent } = options;

  const startedAt = Date.now();
  const progress = (stage: string): void => {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    onProgress?.(`${stage} · ${elapsedSeconds}s`);
  };
  const detail = (
    phase: PreparationProgressPhase,
    label: string,
    current?: number,
    total?: number,
  ): void => {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    onProgressDetail?.({
      phase,
      label,
      ...(current !== undefined ? { current } : {}),
      ...(total !== undefined ? { total } : {}),
      elapsedSeconds,
    });
  };
  progress("Discovering files");
  detail("discover", "Discovering files");
  const extractedDocuments = new Map<string, string>();
  const plan = await computePlan(dir, {
    ...(agent !== undefined ? { agent } : {}),
    interactive: false,
    onDocumentText: (relpath, text) => extractedDocuments.set(relpath, text),
    ...(options.documentInspector ? { documentInspector: options.documentInspector } : {}),
    ...(options.deferDocumentInspection ? { deferDocumentInspection: true } : {}),
    ...(options.safetyMode ? { safetyMode: options.safetyMode } : {}),
  });
  const root = plan.context.root;
  const salt = plan.context.policyHash;
  const effectiveMode: ReductionMode =
    mode ?? config?.budget?.reduction_mode ?? plan.context.config.budget?.reduction_mode ?? "balanced";
  // Safety Mode preset (Balanced default). Strict/Maximum Privacy additionally keep
  // any content that could not be fully verified out of the agent's Prepared
  // Workspace — enforced at the unverified-delivery decision sites below.
  const safetyMode: SafetyMode = options.safetyMode ?? DEFAULT_PREPARE_SAFETY_MODE;
  const keepUnverifiedLocal = escalatesUnverified(safetyMode);
  const localModelParallelism = Math.max(
    1,
    Math.floor(options.localModelParallelism ?? recommendedLocalModelParallelism()),
  );
  // ===== LOCAL-MODEL RELIABILITY (v0.3.3) =====
  // Injectable clock + the three caps that keep the inline summarize-local (Ollama)
  // step from trapping the run — whether it HANGS on one file (per-file timeout) or is
  // merely SLOW across thousands (cumulative time / call-count budget).
  const scheduler = options.deadlineScheduler ?? systemDeadlineScheduler;
  const localModelTimeoutMs = Math.max(
    1,
    Math.floor(options.localModelTimeoutMs ?? DEFAULT_LOCAL_MODEL_TIMEOUT_MS),
  );
  const localModelTotalBudgetMs = Math.max(
    1,
    Math.floor(options.localModelTotalBudgetMs ?? DEFAULT_LOCAL_MODEL_TOTAL_BUDGET_MS),
  );
  const localModelMaxCalls = Math.max(
    0,
    Math.floor(options.localModelMaxCalls ?? DEFAULT_LOCAL_MODEL_MAX_CALLS),
  );
  // Foreground-budget-zero: circuit open from the start, no provider call ever.
  const deferLocalSummary = options.deferLocalSummary === true || localModelMaxCalls === 0;
  // Circuit-breaker + budget state (all measured on `scheduler`, so tests are
  // deterministic). Once `localModelDisabled` is set, NO further provider call is made.
  let localModelDisabled = deferLocalSummary;
  let circuitBreakerReason:
    | "per-file-timeout"
    | "time-budget-exceeded"
    | "call-count-exceeded"
    | "deferred"
    | undefined = deferLocalSummary ? "deferred" : undefined;
  let localModelBudgetSpentMs = 0;
  let localModelCallsMade = 0;
  let filesKeptLocalAfterTimeout = 0;
  const degradedWarnings: PreparationWarning[] = [];
  const recordLocalModelWarning = (
    relpath: string,
    reason: PreparationWarning["reason"],
    action: PreparationWarning["action"],
    elapsedMs?: number,
  ): void => {
    degradedWarnings.push({
      relpath,
      stage: "summarize-local",
      reason,
      action,
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    });
  };
  /**
   * Should the local model be skipped for THIS summarize target? Opens the circuit
   * (once) when the cumulative time budget or call-count cap is already exceeded, so
   * every remaining call is skipped with zero further provider work. Returns a reason
   * when the model must be skipped; `undefined` when a call may proceed.
   */
  const localModelGateClosed = (): boolean => {
    if (localModelDisabled) return true;
    if (localModelCallsMade >= localModelMaxCalls) {
      localModelDisabled = true;
      circuitBreakerReason ??= "call-count-exceeded";
      progress(
        `Local model disabled for this run: ${localModelCallsMade} summarize call(s) reached the ${localModelMaxCalls}-call budget. Remaining files kept local; launch continues.`,
      );
      return true;
    }
    if (localModelBudgetSpentMs >= localModelTotalBudgetMs) {
      localModelDisabled = true;
      circuitBreakerReason ??= "time-budget-exceeded";
      progress(
        `Local model disabled for this run: cumulative local-model time reached the ${localModelTotalBudgetMs}ms budget. Remaining files kept local; launch continues.`,
      );
      return true;
    }
    return false;
  };
  detail("discover", "Files discovered", plan.scan.files.length, plan.scan.files.length);
  let localModelRequests = 0;
  let localModelSucceeded = 0;
  let localModelFailed = 0;
  let localModelInputChars = 0;
  let localModelOutputChars = 0;
  let localModelElapsedMs = 0;
  let localModelActiveRequests = 0;
  let localModelMaxConcurrency = 0;
  let baseProvider = provider;
  let measuredProvider: LocalModelProvider | undefined;
  const getMeasuredProvider = (): LocalModelProvider | undefined => {
    baseProvider ??= providerFactory?.();
    if (!baseProvider) return undefined;
    if (measuredProvider) return measuredProvider;
    const selectedProvider = baseProvider;
    measuredProvider = {
        ...selectedProvider,
        async generate(prompt, generateOptions) {
          localModelRequests += 1;
          localModelInputChars += prompt.length;
          localModelActiveRequests += 1;
          localModelMaxConcurrency = Math.max(localModelMaxConcurrency, localModelActiveRequests);
          const requestStarted = Date.now();
          try {
            const output = await selectedProvider.generate(prompt, generateOptions);
            localModelSucceeded += 1;
            localModelOutputChars += output.length;
            return output;
          } catch (error) {
            localModelFailed += 1;
            throw error;
          } finally {
            localModelElapsedMs += Date.now() - requestStarted;
            localModelActiveRequests -= 1;
          }
        },
      };
    return measuredProvider;
  };

  const runId = randomUUID();
  const managedBase = path.resolve(options.managedWorkspaceBase ?? managedWorkspaceBaseDir());
  const outDir = path.join(managedBase, runId);
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  options.onCheckpoint?.("workspace-created");
  // Stamp a marker so future cleanup can positively confirm this directory is
  // Yuhi-managed and safe to delete (never delete by directory name). Best-effort.
  await writeWorkspaceMarker(outDir, {
    managedBy: "yuhi",
    schemaVersion: 1,
    createdAt: createdAt ?? new Date(Date.now()).toISOString(),
    runId,
  }).catch(() => undefined);
  // Free disk before the heavy copy phase: old prepared workspaces (several GB each)
  // would otherwise accumulate and eventually cause write failures. Best-effort.
  const prunedWorkspaces = await pruneManagedWorkspaces(managedBase, runId, Date.now());
  if (prunedWorkspaces.length > 0) {
    progress(`Cleaned up ${prunedWorkspaces.length} old prepared workspace(s) to free disk space.`);
  }
  try {
  const infoByPath = new Map<string, FileInfo>(plan.scan.files.map((f) => [f.relpath, f]));
  detail("scan", "Scanning sensitive information", 0, plan.scan.files.length);
  const sourceIntegrityBefore = await captureSourceIntegrity(root, plan.scan.files, {
    ...(signal !== undefined ? { signal } : {}),
    phase: "before",
    ...(onProgress !== undefined
      ? {
          onProgress: (message) => {
            const count = message.match(/before (\d+\/\d+)/)?.[1];
            progress(`Scanning sensitive information${count ? ` · ${count} files` : ""}`);
            const matched = message.match(/before (\d+)\/(\d+)/);
            if (matched) detail("scan", "Scanning sensitive information", Number(matched[1]), Number(matched[2]));
          },
        }
      : {}),
  });
  progress(`Scanning sensitive information · ${plan.scan.files.length} files`);
  progress(`Preparing safe copies · 0/${plan.evaluation.decisions.length} files`);
  detail("prepare", "Preparing safe copies", 0, plan.evaluation.decisions.length);

  const files: PreparedFileEntry[] = [];
  const provenance: ProvenanceEntry[] = [];
  // v0.3.5: deferred heavy work to register as persistent BACKGROUND items after the
  // fast phase. Each descriptor pins the ORIGINAL (kept-local) file — enqueued only
  // once the deterministic Context ID is known; on a successful enqueue the paired
  // entry's outcome is flipped to `background-processing-pending` (never before).
  const backgroundEnqueue: {
    entry: PreparedFileEntry;
    kind: BackgroundPreparationKind;
    relpath: string;
    sourceArtifactPath: string;
    sourceContentHash: string;
    processorVersion: string;
    originalSharedWithWarning: boolean;
  }[] = [];
  let beforeTokens = 0;
  let afterTokens = 0;
  let approx = false;
  let filesSummarized = 0;
  let filesExcluded = 0;
  let sensitiveMasked = 0;
  let studentAliases = createStudentAliasContext();
  const explicitExclusions = new Set(options.excludeRelpaths ?? []);
  const explicitWarningInclusions = new Set(options.includeWithWarningRelpaths ?? []);
  const warningExtensions = new Set((options.includeWithWarningExtensions ?? []).map((value) => value.toLowerCase()));
  const excludedExtensions = new Set((options.excludeExtensions ?? []).map((value) => value.toLowerCase()));
  let identifierColumnsTransformed = 0;
  let analyticalColumnsPreserved = 0;
  let transformedSensitiveTables = 0;
  let malformedTables = 0;
  let unverifiedTransformations = 0;
  let unsupportedOrUnverifiedFiles = 0;
  let filenamesPseudonymized = 0;
  let finalIdentifierLeaks = 0;
  let finalCredentialKeptLocal = 0;
  let restrictedUnresolvedFiles = 0;
  let documentSummariesCreated = 0;
  let documentSummariesRejected = 0;
  let documentContextBeforeTokens = 0;
  let documentContextAfterTokens = 0;
  let textDocumentsInspected = 0;
  const documentIndex: {
    relpath: string;
    summaryRelpath?: string;
    method: "pdf-text" | "ocr" | "text";
    pages?: number;
    status: "created" | "rejected" | "unavailable" | "pending";
  }[] = [];

  const prepareContextSummary = async (
    relpath: string,
    extractedText: string | undefined,
    method: "pdf-text" | "ocr" | "text",
    pages?: number,
  ): Promise<{ status: "created" | "rejected" | "unavailable"; summaryRelpath?: string } | undefined> => {
    if (!extractedText) return undefined;

    documentContextBeforeTokens += tokenEstimate(extractedText).tokens;
    const metadata = {
      relpath,
      method,
      ...(pages !== undefined ? { pages } : {}),
    };
    progress(`Generating local document context · ${documentIndex.length + 1}`);
    // Circuit / budget gate: once the local model is disabled (a prior per-file
    // timeout, or the cumulative time / call-count budget), skip the optional summary
    // immediately — no provider call, no 10s wait. The DOCUMENT itself was already
    // delivered on its own inspection above; only this enrichment summary is skipped.
    if (localModelGateClosed()) {
      // Distinguish an INTENTIONAL foreground deferral (deferLocalSummary) from a
      // timeout/budget shutdown, so the manifest reads honestly and never implies the
      // summary will be produced later. Background connection is a future version.
      const gateReason = circuitBreakerReason === "deferred" ? "local-summary-deferred" : "local-model-disabled";
      recordLocalModelWarning(relpath, gateReason, "summary-skipped");
      documentSummariesRejected += 1;
      documentIndex.push({ ...metadata, status: "rejected" });
      return { status: "rejected" };
    }
    const summaryProvider = getMeasuredProvider();
    if (!summaryProvider) {
      progress("Generating local context: skipped (no local model configured)");
      recordLocalModelWarning(relpath, "local-model-unavailable", "summary-skipped");
      documentIndex.push({ ...metadata, status: "unavailable" });
      return { status: "unavailable" };
    }

    let prepared: Awaited<ReturnType<typeof runLocalPreparation>>;
    try {
      // The per-file timeout + AbortController wrap the REAL provider call: the work
      // callback below is what invokes `summarize-local` → `summaryProvider.generate()`
      // (via createSummarizer). If generate never resolves, the timer fires, aborts the
      // request, and this resolves as a timeout — the loop advances instead of hanging.
      progress(`Local context ${relpath}: summarize-local started`);
      localModelCallsMade += 1;
      const outcome = await runLocalModelCall(
        (childSignal) =>
          runLocalPreparation(extractedText, ["summarize-local", "safety-check"], {
            provider: summaryProvider,
            mode: effectiveMode,
            localModelParallelism,
            signal: childSignal,
          }),
        localModelTimeoutMs,
        scheduler,
        signal,
      );
      localModelBudgetSpentMs += outcome.elapsedMs;
      if (outcome.status === "timeout") {
        // Open the circuit on the FIRST per-file timeout: every subsequent summarize
        // target is skipped/kept-local with no further wait. The document stays delivered.
        localModelDisabled = true;
        circuitBreakerReason ??= "per-file-timeout";
        recordLocalModelWarning(relpath, "local-summary-timeout", "summary-skipped", outcome.elapsedMs);
        progress(
          `Local context ${relpath}: summarize-local timed out after ${outcome.elapsedMs}ms → summary skipped; circuit breaker opened (local model disabled for this run); continuing.`,
        );
        documentSummariesRejected += 1;
        documentIndex.push({ ...metadata, status: "rejected" });
        return { status: "rejected" };
      }
      prepared = outcome.value;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      documentSummariesRejected += 1;
      documentIndex.push({ ...metadata, status: "rejected" });
      return;
    }
    // METADATA BOUNDARY: this artifact's NAME is agent-visible, and `.yuhi/` paths are
    // deliberately skipped by the filename de-identification pass below — so the name
    // must come from the document's identity, never from the source basename (which is
    // where the identifier lives: `9999990001 評定-0722.xlsx`).
    const summaryRelpath = `.yuhi/context/${documentIdFor(relpath, salt)}.summary.md`;
    const markdown =
      `# Document Summary\n\n${prepared.output.trim()}\n\n---\n\n` +
      `Generated locally by Yuhi. The extracted source text was not stored.\n`;
    const findings = runDetectors(markdown, {
      entropyThreshold: plan.context.config.scan.entropy_threshold,
      keywords: plan.context.config.scan.keywords,
      relpath: summaryRelpath,
    });
    const personalDataPattern =
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+\d{1,3}[- ]?)?(?:\(\d{2,4}\)[- ]?)?\d{2,4}[- ]\d{2,4}[- ]\d{3,4}|(?:氏名|full\s*name|address|住所)\s*[:：]/i;
    const rejected =
      prepared.status !== "ok" ||
      prepared.transmission !== "approved" ||
      findings.length > 0 ||
      personalDataPattern.test(markdown);
    if (rejected) {
      documentSummariesRejected += 1;
      documentIndex.push({ ...metadata, status: "rejected" });
      return { status: "rejected" };
    }
    await writeMirrored(outDir, summaryRelpath, markdown);
    documentSummariesCreated += 1;
    documentContextAfterTokens += tokenEstimate(markdown).tokens;
    documentIndex.push({ ...metadata, summaryRelpath, status: "created" });
    return { status: "created", summaryRelpath };
  };

  // v0.3.5: PDF/DOCX/PPTX heavy extraction (incl. OCR) no longer runs in the foreground.
  // Documents are enqueued as `document-extraction` items and their sanitized companions
  // are produced + safety-gated + published by `runBackgroundForRun` after launch.

  /**
   * Route a summarize target to KEPT-LOCAL because the local model timed out or was
   * disabled (circuit open / budget). The file's de-identification pipeline never
   * completed, so it is withheld (omitted, `action: "local-only"`) — NEVER delivered
   * un-inspected — and nothing is written to `outDir` for it. Records a privacy-safe
   * warning (relpath only) and counts it for degraded-completion reporting.
   */
  const keepFileLocalAfterLocalModel = (
    relpath: string,
    content: string,
    reason: PreparationWarning["reason"],
    publicError: string,
    elapsedMs?: number,
  ): void => {
    recordLocalModelWarning(relpath, reason, "kept-local", elapsedMs);
    const tok = tokenEstimate(content);
    beforeTokens += tok.tokens;
    approx = approx || tok.approx;
    filesExcluded += 1;
    filesKeptLocalAfterTimeout += 1;
    files.push({
      relpath,
      action: "local-only",
      status: "skipped",
      outcome: "local-only-transformation-failed",
      transmission: "blocked",
      beforeChars: content.length,
      afterChars: 0,
      transformed: false,
      omitted: true,
      limitation: "transformation-unavailable",
      // A timeout is an operational limit, NOT a safety verdict — categorize as unknown.
      failureCategory: "unknown",
      error: publicError,
    });
  };

  let decisionsProcessed = 0;
  for (const decision of plan.evaluation.decisions) {
    if (signal?.aborted) throw new DOMException("prepareWorkspace aborted", "AbortError");

   try {
    const info = infoByPath.get(decision.relpath);
    const relpath = decision.relpath;

    const fileExtension = path.extname(relpath).toLowerCase();
    const explicitlyIncludedWithWarning =
      explicitWarningInclusions.has(relpath) || (!!fileExtension && warningExtensions.has(fileExtension));
    if (explicitExclusions.has(relpath) || (!!fileExtension && excludedExtensions.has(fileExtension))) {
      filesExcluded += 1;
      files.push({
        relpath,
        action: "block",
        status: "skipped",
        outcome: "excluded-by-user",
        transmission: "blocked",
        beforeChars: info?.size ?? 0,
        afterChars: 0,
        omitted: true,
      });
      decisionsProcessed += 1;
      detail("prepare", "Preparing safe copies", decisionsProcessed, plan.evaluation.decisions.length);
      continue;
    }

    // ===== DOCUMENT ROUTING (PDF / DOCX / DOCM / PPTX / PPTM) → BACKGROUND QUEUE =====
    // Progressive Context: document extraction / OCR remains OFF the foreground path.
    // Balanced and Strict make the useful original available WITH AN EXPLICIT WARNING
    // while a private queue item prepares a verified companion. Maximum Privacy keeps
    // the original local. Credentials and explicit blocks never
    // enter this path.
    const docType = info ? documentSourceType(relpath) : undefined;
    if (
      info &&
      docType &&
      !info.flags.isSymlink &&
      decision.action !== "block" &&
      !/(?:private-key|credential|secret-director)/i.test(decision.ruleName)
    ) {
      const before = tokenEstimate(String(info.size));
      beforeTokens += before.tokens;
      approx = true;
      // "Not yet inspected" and "known to contain sensitive data" are DIFFERENT
      // states and must not share one policy. Available-with-warning exists for
      // the former only: a document the scanner already flagged is kept local in
      // every mode, and the agent receives its verified companion instead.
      const knownSensitiveFinding = decision.findings.some(
        (finding) => finding.severity !== "low",
      );
      const shareWithWarning =
        !knownSensitiveFinding &&
        (safetyMode !== "maximum-privacy" || explicitlyIncludedWithWarning);
      if (shareWithWarning) {
        await copyMirrored(outDir, relpath, info.absPath);
        provenance.push({ relpath, source: relpath, action: "allow" });
        afterTokens += before.tokens;
      }
      const entry: PreparedFileEntry = {
        relpath,
        originalRelpath: relpath,
        action: shareWithWarning ? "allow" : "prepare-locally",
        status: shareWithWarning ? "ok" : "skipped",
        outcome: shareWithWarning
          ? "included-unverified"
          : knownSensitiveFinding
            ? "local-only-known-risk"
            : "local-only-unverified",
        transmission: shareWithWarning ? "approved" : "blocked",
        beforeChars: info.size,
        afterChars: shareWithWarning ? info.size : 0,
        transformed: false,
        omitted: !shareWithWarning,
        limitation: "inspection-unavailable",
        availabilityStatus: shareWithWarning ? "available-with-warning" : "background-processing",
        inspectionStatus: "pending",
        backgroundStatus: "pending",
        originalShared: shareWithWarning,
        warningCode: "inspection-pending",
        knownFindingsPresent: knownSensitiveFinding,
        document: {
          sourceType: docType,
          sourceSize: info.size,
          extractionMethod: "none",
          extractionStatus: "pending",
          deliveredArtifactType: "none",
          originalSharedWithAgent: shareWithWarning,
          redactionCount: 0,
          residualNameRisk: false,
          macroDetected: false,
          embeddedObjectCount: 0,
          imageCount: 0,
          hiddenContentDetected: false,
          extractedParagraphCount: 0,
          extractedTableCount: 0,
          extractedSlideCount: 0,
          extractedNotesCount: 0,
        },
      };
      files.push(entry);
      backgroundEnqueue.push({
        entry,
        // A single `document-extraction` item covers PDF text WITH OCR fallback (the
        // injected extractor decides pdf-text vs. OCR) and DOCX/PPTX unzip — all heavy
        // work runs in the background behind the safety-gated publisher.
        kind: "document-extraction",
        relpath,
        sourceArtifactPath: info.absPath,
        // Cheap, stable idempotency seed — never load the (possibly large) document
        // into memory in the foreground just to hash it.
        sourceContentHash: info.sha256 ?? createHash("sha256").update(`${relpath}:${info.size}`).digest("hex"),
        processorVersion: `document-extraction@${YUHI_VERSION}`,
        originalSharedWithWarning: shareWithWarning,
      });
      progress(
        shareWithWarning
          ? `Document ${relpath}: included with an inspection-pending warning; verified companion queued in background.`
          : knownSensitiveFinding
            ? `Document ${relpath}: known sensitive finding — original kept local in every mode; verified companion queued in background.`
            : `Document ${relpath}: original kept local; safe companion queued in background.`,
      );
      decisionsProcessed += 1;
      if (decisionsProcessed % 25 === 0 || decisionsProcessed === plan.evaluation.decisions.length) {
        progress(`Preparing safe copies · ${decisionsProcessed}/${plan.evaluation.decisions.length} files`);
      }
      detail("prepare", "Preparing safe copies", decisionsProcessed, plan.evaluation.decisions.length);
      continue;
    }

    // PER-FORMAT SIZE STRATEGY (no single 2 MB gate). A file too large to inspect for
    // its type — a PDF over 64 MB, or any other file over the in-memory ceiling — is
    // kept local rather than loaded into memory, never hanging or OOM-ing the run.
    // Text and spreadsheets under the ceiling fall through
    // to normal de-identification regardless of size. Explicit policy `block` and
    // symlinks (handled below) always win over size.
    const oversizeReason =
      info && !info.flags.isSymlink && decision.action !== "block"
        ? oversizePassThroughReason(info.inspection.fileType, info.size)
        : undefined;
    if (info && oversizeReason) {
      if (safetyMode === "maximum-privacy" && !explicitlyIncludedWithWarning) {
        // Never deliver content that could not be verified. Keep the oversized file
        // local (not copied to the workspace), without blocking Yuhi Mode.
        unsupportedOrUnverifiedFiles += 1;
        beforeTokens += Math.ceil(info.size / 4);
        approx = true;
        files.push({
          relpath,
          action: "local-only",
          status: "skipped",
          outcome: "local-only-unverified",
          transmission: "blocked",
          beforeChars: info.size,
          afterChars: 0,
          transformed: false,
          omitted: true,
          limitation: "transformation-unavailable",
          failureCategory: "structural",
          keptLocalBySafetyMode: safetyMode,
          error: oversizeReason,
        });
        decisionsProcessed += 1;
        if (decisionsProcessed % 25 === 0 || decisionsProcessed === plan.evaluation.decisions.length) {
          progress(`Preparing safe copies · ${decisionsProcessed}/${plan.evaluation.decisions.length} files`);
        }
        detail("prepare", "Preparing safe copies", decisionsProcessed, plan.evaluation.decisions.length);
        continue;
      }
      await copyMirrored(outDir, relpath, info.absPath);
      provenance.push({ relpath, source: relpath, action: "allow" });
      const estimated = Math.ceil(info.size / 4);
      beforeTokens += estimated;
      afterTokens += estimated;
      approx = true;
      unsupportedOrUnverifiedFiles += 1;
      files.push({
        relpath,
        action: "allow",
        status: "ok",
        outcome: "included-unverified",
        transmission: "approved",
        beforeChars: info.size,
        afterChars: info.size,
        transformed: false,
        omitted: false,
        limitation: "inspection-incomplete",
        availabilityStatus: "available-with-warning",
        inspectionStatus: "pending",
        backgroundStatus: "none",
        originalShared: true,
        warningCode: "inspection-pending",
        knownFindingsPresent: false,
        error: oversizeReason,
      });
      decisionsProcessed += 1;
      detail("prepare", "Preparing safe copies", decisionsProcessed, plan.evaluation.decisions.length);
      continue;
    }

    // ===== ARCHIVE ROUTING =====
    // An archive is opaque to every scanner Yuhi has. Delivering the original
    // "with an inspection-pending warning" would hand the agent bytes that were
    // never de-identified and — when encrypted — never CAN be. Archives therefore
    // never reach the Prepared Workspace, and their entry names are never read,
    // so no archive-internal identifier can reach a public surface.
    if (info && !info.flags.isSymlink && isArchivePath(relpath)) {
      let encryption: ReturnType<typeof zipEncryptionFromHeader> = "unknown";
      try {
        const handle = await open(info.absPath, "r");
        try {
          const head = Buffer.alloc(8);
          const { bytesRead } = await handle.read(head, 0, 8, 0);
          encryption = zipEncryptionFromHeader(head.subarray(0, bytesRead));
        } finally {
          await handle.close();
        }
      } catch {
        encryption = "unknown";
      }
      const reasonCode = encryption === "encrypted"
        ? "encrypted-archive-uninspectable"
        : "archive-uninspectable";
      filesExcluded += 1;
      unsupportedOrUnverifiedFiles += 1;
      beforeTokens += tokenEstimate(String(info.size)).tokens;
      approx = true;
      files.push({
        relpath,
        action: "local-only",
        status: "skipped",
        outcome: "local-only-known-risk",
        transmission: "blocked",
        beforeChars: info.size,
        afterChars: 0,
        transformed: false,
        omitted: true,
        limitation: "inspection-unavailable",
        availabilityStatus: "excluded-known-risk",
        inspectionStatus: "not-applicable",
        backgroundStatus: "none",
        originalShared: false,
        knownFindingsPresent: decision.findings.length > 0,
        error: reasonCode,
      });
      progress(`Archive ${relpath}: ${reasonCode} — kept on this computer; contents never inspected.`);
      decisionsProcessed += 1;
      detail("prepare", "Preparing safe copies", decisionsProcessed, plan.evaluation.decisions.length);
      continue;
    }

    const unverifiedInspection = !!info && !info.inspection.contentVerified;
    const unsupportedInspection = unverifiedInspection && !info.inspection.parserAvailable;
    const unsupportedHighRisk = unverifiedInspection && decision.findings.some(
      (finding) => finding.severity === "high" || finding.severity === "critical",
    );
    const balancedWarningEligible =
      (safetyMode !== "maximum-privacy" || explicitlyIncludedWithWarning) &&
      !!info &&
      !info.flags.isSymlink &&
      // Corrected policy: an uninspectable binary/unknown type is still USEFUL context.
      // Balanced/Strict deliver the original WITH an inspection-pending warning; only
      // KNOWN risks (credentials/private keys via ruleName, high/critical findings) and
      // OS metadata below stay excluded. Maximum Privacy keeps it local (guarded above).
      unverifiedInspection &&
      decision.action === "local-only" &&
      !unsupportedHighRisk &&
      !isArchivePath(relpath) &&
      path.basename(relpath) !== ".DS_Store" &&
      !/(?:credential|private-key|secret-director)/i.test(decision.ruleName) &&
      !decision.findings.some((finding) => finding.severity === "high" || finding.severity === "critical");
    if (balancedWarningEligible) {
      await copyMirrored(outDir, relpath, info.absPath);
      provenance.push({ relpath, source: relpath, action: "allow" });
      const estimated = Math.ceil(info.size / 4);
      beforeTokens += estimated;
      afterTokens += estimated;
      approx = true;
      unsupportedOrUnverifiedFiles += 1;
      files.push({
        relpath,
        action: "allow",
        status: "ok",
        outcome: "included-unverified",
        transmission: "approved",
        beforeChars: info.size,
        afterChars: info.size,
        transformed: false,
        omitted: false,
        limitation: unsupportedInspection ? "inspection-unavailable" : "inspection-incomplete",
        availabilityStatus: "available-with-warning",
        inspectionStatus: "pending",
        backgroundStatus: "none",
        originalShared: true,
        warningCode: "inspection-pending",
        knownFindingsPresent: decision.findings.length > 0,
        inspection: {
          fileType: info.inspection.fileType,
          inspectionAttempted: info.inspection.inspectionAttempted,
          inspectionSucceeded: info.inspection.inspectionSucceeded,
          parserAvailable: info.inspection.parserAvailable,
          scannerAvailable: info.inspection.scannerAvailable,
          transformerAvailable: info.inspection.transformers.length > 0,
          postTransformVerifierAvailable: info.inspection.verifierAvailable,
          contentVerified: false,
        },
      });
      decisionsProcessed += 1;
      detail("prepare", "Preparing safe copies", decisionsProcessed, plan.evaluation.decisions.length);
      continue;
    }
    // Final routing is capability/policy driven. Unsupported content is kept
    // local explicitly; symlinks and policy exclusions remain separate.
    if (!info || info.flags.isSymlink || isExcludedAction(decision.action)) {
      filesExcluded += 1;
      const localOnlyUnverified = unverifiedInspection && decision.action === "local-only";
      if (localOnlyUnverified) unsupportedOrUnverifiedFiles += 1;
      if (unsupportedHighRisk) {
        restrictedUnresolvedFiles += 1;
        unverifiedTransformations += 1;
      }
      files.push({
        relpath,
        action: decision.action,
        status: unsupportedHighRisk ? "error" : "skipped",
        outcome: unsupportedHighRisk
          ? "local-only-unverified"
          : localOnlyUnverified
            ? unsupportedInspection
              ? "local-only-unsupported"
              : "local-only-unverified"
            : "excluded-by-policy",
        transmission: "blocked",
        beforeChars: info?.size ?? 0,
        afterChars: 0,
        omitted: true,
        ...(info
          ? {
              inspection: {
                fileType: info.inspection.fileType,
                inspectionAttempted: info.inspection.inspectionAttempted,
                inspectionSucceeded: info.inspection.inspectionSucceeded,
                parserAvailable: info.inspection.parserAvailable,
                scannerAvailable: info.inspection.scannerAvailable,
                transformerAvailable: info.inspection.transformers.length > 0,
                postTransformVerifierAvailable: info.inspection.verifierAvailable,
                contentVerified: info.inspection.contentVerified,
              },
            }
          : {}),
        ...(localOnlyUnverified
          ? {
              limitation: unsupportedHighRisk
                ? "transformation-unavailable" as const
                : unsupportedInspection
                  ? "inspection-unavailable" as const
                  : "inspection-incomplete" as const,
            }
          : {}),
        ...(unsupportedHighRisk
          ? { error: "Restricted data could not be safely inspected or transformed." }
          : {}),
      });
      decisionsProcessed += 1;
      if (decisionsProcessed % 25 === 0 || decisionsProcessed === plan.evaluation.decisions.length) {
        progress(`Preparing safe copies · ${decisionsProcessed}/${plan.evaluation.decisions.length} files`);
      }
      continue;
    }

    if (
      info.inspection.fileType === "xlsx" &&
      decision.action === "prepare-locally"
    ) {
      progress(`Preparing safe copies · ${decisionsProcessed}/${plan.evaluation.decisions.length} files`);
      const sourceBytes = await readFile(info.absPath);
      const fileAliases = cloneStudentAliases(studentAliases);
      try {
        const transformed = await pseudonymizeXlsxRecords(sourceBytes, fileAliases);
        const verified = await inspectXlsxRecords(transformed.output);
        const rawPresent = await xlsxContainsAnyValue(
          transformed.output,
          new Set(transformed.rawIdentifiers),
        );
        // Best-effort, never all-or-nothing: the workbook PARSED, so its identifier
        // columns are pseudonymized in `transformed.output`. ALWAYS deliver that —
        // never fall back to the 100% raw original just because a stray non-identifier
        // cell still echoes a value or a sheet count differs. The mandatory final
        // gate reopens this exact file and has the last word on whether it may be
        // reported de-identified; anything it still finds is surfaced honestly there.
        const fullyClean =
          !rawPresent &&
          verified.directIdentifierColumns > 0 &&
          verified.sensitiveSheets === transformed.sensitiveSheets;
        if (!fullyClean) {
          // A best-effort-only workbook is not publishable in any mode. The exact
          // transformed candidate is discarded; the raw workbook never becomes a
          // fallback. Yuhi Mode still launches with other safe files.
          unsupportedOrUnverifiedFiles += 1;
          beforeTokens += tokenEstimate(sourceBytes.toString("base64")).tokens;
          approx = true;
          files.push({
            relpath,
            action: "local-only",
            status: "skipped",
            outcome: "local-only-unverified",
            transmission: "blocked",
            beforeChars: sourceBytes.length,
            afterChars: 0,
            transformations: ["pseudonymized", "masked"],
            maskedValues: transformed.valuesReplaced,
            transformed: false,
            omitted: true,
            keptLocalBySafetyMode: safetyMode,
            limitation: "transformation-unavailable",
            failureCategory: "reidentification-risk",
            error: `Best-effort pseudonymization could not be fully verified; kept local by ${safetyModeLabel(safetyMode)}.`,
          });
          decisionsProcessed += 1;
          continue;
        }
        await writeMirrored(outDir, relpath, transformed.output);
        studentAliases = fileAliases;
        provenance.push({ relpath, source: relpath, action: decision.action });
        const before = tokenEstimate(sourceBytes.toString("base64"));
        const after = tokenEstimate(transformed.output.toString("base64"));
        beforeTokens += before.tokens;
        afterTokens += after.tokens;
        approx = true;
        identifierColumnsTransformed += transformed.directIdentifierColumns;
        analyticalColumnsPreserved += transformed.analyticalColumnsPreserved;
        transformedSensitiveTables += transformed.sensitiveSheets;
        sensitiveMasked += transformed.valuesReplaced > 0 ? 1 : 0;
        if (!fullyClean) unsupportedOrUnverifiedFiles += 1;
        files.push({
          relpath,
          action: decision.action,
          status: "ok",
          outcome: fullyClean ? "included-transformed" : "included-unverified",
          transmission: "approved",
          beforeChars: sourceBytes.length,
          afterChars: transformed.output.length,
          transformations: ["pseudonymized", "masked"],
          maskedValues: transformed.valuesReplaced,
          transformed: true,
          ...(fullyClean
            ? {}
            : {
                limitation: "transformation-unavailable" as const,
                failureCategory: "reidentification-risk" as const,
                error:
                  "Workbook pseudonymized best-effort; a value could not be fully separated — see the final privacy rescan.",
              }),
        });
      } catch (error) {
        // Preserve the EXACT reason (never a generic message) and classify it.
        const reason =
          error instanceof Error && error.message
            ? error.message
            : "Workbook could not be transformed.";
        const category = classifyTransformFailure(reason);
        // Transformation failed: raw fallback is forbidden. Keep the workbook local
        // and let Yuhi Mode continue with the rest of the verified workspace.
        const tokens = tokenEstimate(sourceBytes.toString("base64"));
        beforeTokens += tokens.tokens;
        approx = true;
        unsupportedOrUnverifiedFiles += 1;
        files.push({
          relpath,
          action: "local-only",
          status: "skipped",
          outcome: "local-only-transformation-failed",
          transmission: "blocked",
          beforeChars: sourceBytes.length,
          afterChars: 0,
          transformations: [],
          transformed: false,
          omitted: true,
          error: reason,
          limitation: "transformation-unavailable",
          failureCategory: category,
        });
      }
      decisionsProcessed += 1;
      continue;
    }

    if (
      decision.action === "allow" &&
      info.inspection.fileType === "pdf" &&
      info.inspection.contentVerified
    ) {
      const sourceBytes = await readFile(info.absPath);
      await writeMirrored(outDir, relpath, sourceBytes);
      provenance.push({ relpath, source: relpath, action: decision.action });
      if (!info.inspection.contentVerified) unsupportedOrUnverifiedFiles += 1;
      const tokens = tokenEstimate(sourceBytes.toString("base64"));
      beforeTokens += tokens.tokens;
      afterTokens += tokens.tokens;
      approx = true;
      const extractedText = extractedDocuments.get(relpath);
      extractedDocuments.delete(relpath);
      const summary =
        info.inspection.fileType === "pdf" &&
        info.documentInspection?.status === "inspected" &&
        info.documentInspection.extractionMethod !== "none"
          ? await prepareContextSummary(
              relpath,
              extractedText,
              info.documentInspection.extractionMethod,
              info.documentInspection.pageCount,
            )
          : undefined;
      if (options.deferDocumentInspection && info.inspection.fileType === "pdf") {
        documentIndex.push({ relpath, method: "pdf-text", status: "pending" });
      }
      files.push({
        relpath,
        action: decision.action,
        status: "ok",
        outcome: info.inspection.contentVerified ? "included-unchanged" : "included-unverified",
        transmission: "approved",
        beforeChars: sourceBytes.length,
        afterChars: sourceBytes.length,
        transformed: false,
        inspection: {
          fileType: info.inspection.fileType,
          inspectionAttempted: info.inspection.inspectionAttempted,
          inspectionSucceeded: info.inspection.inspectionSucceeded,
          parserAvailable: info.inspection.parserAvailable,
          scannerAvailable: info.inspection.scannerAvailable,
          transformerAvailable: false,
          postTransformVerifierAvailable: info.inspection.verifierAvailable,
          contentVerified: info.inspection.contentVerified,
          ...(info.documentInspection
            ? {
                documentStatus: info.documentInspection.status,
                extractionMethod: info.documentInspection.extractionMethod,
                ...(info.documentInspection.pageCount !== undefined
                  ? { pageCount: info.documentInspection.pageCount }
                  : {}),
                warnings: info.documentInspection.warnings,
                ...(summary ? { summaryStatus: summary.status } : {}),
                ...(summary?.summaryRelpath
                  ? { summaryRelpath: summary.summaryRelpath }
                  : {}),
              }
            : {}),
        },
        ...(!info.inspection.contentVerified ? { limitation: "inspection-unavailable" as const } : {}),
      });
      decisionsProcessed += 1;
      continue;
    }

    // Detect Shift-JIS/CP932 (common for Japanese CSV/Excel exports) so identifier
    // columns are recognized and de-identified instead of passing through as
    // mojibake that still reveals real names to a correctly-decoding reader.
    const content = decodeTextBuffer(await readFile(info.absPath));

    if (isSummarizeTarget(decision) || isRedactTarget(decision)) {
      progress(`Preparing safe copies · ${decisionsProcessed}/${plan.evaluation.decisions.length} files`);
      const rawPipeline =
        decision.processors && decision.processors.length > 0
          ? decision.processors
          : isRedactTarget(decision)
            ? (["redact-secrets", "pseudonymize", "safety-check"] satisfies ProcessorSpec[])
            : PREPARE_PIPELINE;
      // Phase 1 (the fast blocking phase that gates Yuhi Mode) MUST NOT invoke the
      // local model. Ollama summarization is optional Phase-3 enrichment, so drop
      // summarize-local here; de-identification (pseudonymize/safety-check) still
      // runs. The document summary is produced later in the background, if enabled.
      const pipeline = options.deferDocumentInspection
        ? rawPipeline.filter((processor) => processorId(processor) !== "summarize-local")
        : rawPipeline;
      const needsLocalModel = pipeline.some(
        (processor) => processorId(processor) === "summarize-local",
      );
      const fileAliases = cloneStudentAliases(studentAliases);

      // ── LOCAL-MODEL HANG / SLOWNESS PROTECTION ──────────────────────────────
      // Only files that actually invoke `summarize-local` (Ollama) can hang here.
      // When the circuit is already open (an earlier per-file timeout, or the run's
      // cumulative time / call-count budget was reached), keep this file LOCAL right
      // away — its de-identification pipeline never ran, so it must NEVER be delivered
      // un-inspected. Yuhi Mode still launches with the safe files.
      let prep: Awaited<ReturnType<typeof runLocalPreparation>>;
      if (needsLocalModel && localModelGateClosed()) {
        // Two honest cases. INTENTIONAL deferral (deferLocalSummary — e.g. VS Code's
        // foreground prepare runs zero local-model calls): the file is kept local now
        // and is NOT auto-processed later in this version — reason local-summary-deferred.
        // Otherwise the local model was shut down by a timeout/budget — local-model-disabled.
        const deferred = circuitBreakerReason === "deferred";
        keepFileLocalAfterLocalModel(
          relpath,
          content,
          deferred ? "local-summary-deferred" : "local-model-disabled",
          deferred
            ? "This file needs local summarization to be de-identified, which was not run during " +
                "preparation, so it was kept on this computer and not shared. Review or include it later."
            : "Local model was disabled for this run (timeout or budget); this file needs local " +
                "summarization to be de-identified, so it was kept on this computer. Review or include it later.",
        );
        // v0.3.5: an INTENTIONAL foreground deferral (deferLocalSummary) is registered as
        // a persistent background item so its safe companion is produced after launch. A
        // timeout/budget shutdown (local-model-disabled) is NOT auto-processed later — it
        // stays kept-local. The entry becomes `background-processing-pending` only if the
        // enqueue below succeeds; the original file is never delivered un-inspected.
        if (deferred && info) {
          backgroundEnqueue.push({
            entry: files[files.length - 1]!,
            kind: "summarize-local",
            relpath,
            sourceArtifactPath: info.absPath,
            sourceContentHash:
              info.sha256 ?? createHash("sha256").update(content).digest("hex"),
            processorVersion: `summarize-local@${YUHI_VERSION}`,
            originalSharedWithWarning: false,
          });
        }
        decisionsProcessed += 1;
        detail("prepare", "Preparing safe copies", decisionsProcessed, plan.evaluation.decisions.length);
        continue;
      }
      if (needsLocalModel) {
        const pipelineProvider = getMeasuredProvider();
        // The timeout + AbortController below wrap the REAL provider call: the work
        // callback invokes `runLocalPreparation` whose `summarize-local` step calls
        // `pipelineProvider.generate()`. A never-resolving generate() trips the timer.
        progress(`Preparing ${relpath}: summarize-local started`);
        localModelCallsMade += 1;
        const outcome = await runLocalModelCall(
          (childSignal) =>
            runLocalPreparation(content, pipeline, {
              ...(pipelineProvider !== undefined ? { provider: pipelineProvider } : {}),
              salt,
              mode: effectiveMode,
              localModelParallelism,
              studentAliases: fileAliases,
              signal: childSignal,
            }),
          localModelTimeoutMs,
          scheduler,
          signal,
        );
        localModelBudgetSpentMs += outcome.elapsedMs;
        if (outcome.status === "timeout") {
          // FIRST per-file timeout opens the circuit for the rest of the run.
          localModelDisabled = true;
          circuitBreakerReason ??= "per-file-timeout";
          progress(
            `Preparing ${relpath}: summarize-local timed out after ${outcome.elapsedMs}ms → kept local; circuit breaker opened (local model disabled for this run); continuing.`,
          );
          keepFileLocalAfterLocalModel(
            relpath,
            content,
            "local-summary-timeout",
            "Local preparation timed out on this computer; the file was kept local so Yuhi Mode " +
              "could launch. Review or include it later.",
            outcome.elapsedMs,
          );
          decisionsProcessed += 1;
          detail("prepare", "Preparing safe copies", decisionsProcessed, plan.evaluation.decisions.length);
          continue;
        }
        prep = outcome.value;
      } else {
        // No local model in this file's pipeline (e.g. redact: pseudonymize +
        // safety-check) — fully deterministic, cannot hang. Run it directly.
        prep = await runLocalPreparation(content, pipeline, {
          salt,
          mode: effectiveMode,
          localModelParallelism,
          studentAliases: fileAliases,
          ...(signal !== undefined ? { signal } : {}),
        });
      }

      const entry: PreparedFileEntry = {
        relpath,
        action: decision.action,
        status: prep.status,
        outcome: prep.status === "ok" ? "included-transformed" : "local-only-transformation-failed",
        transmission: prep.transmission,
        beforeChars: prep.reduction.beforeChars,
        afterChars: prep.reduction.afterChars,
        ...(prep.error !== undefined ? { error: prep.error } : {}),
      };

      if (prep.status === "ok" && prep.transmission === "approved") {
        // INSTRUMENTED VERIFICATION: run each stage independently and record the
        // first failure, so it is always visible WHERE a file leaves the happy path.
        // `leak` failures mean a raw identifier survived (a real safety problem);
        // everything else is a "could-not-fully-verify" mismatch, not a leak.
        const pseudonymizedTable = prep.audits.some(
          (audit) => audit.processorId === "pseudonymize-student-records",
        );
        const stages: Array<{ stage: string; pass: boolean; leak: boolean }> = [];
        // Table verification only applies when a TABULAR pseudonymizer ran. A
        // summarized/text output is prose, not a table — parsing it as one is
        // expected to fail and must NOT count as a verification failure.
        if (pseudonymizedTable) {
          try {
            const inputTable = parseTabularRegion(content);
            const outputTable = parseTabularRegion(prep.output);
            stages.push({ stage: "parse", pass: true, leak: false });
            const inputClassification = classifyStudentRecordTable(inputTable.rows);
            // Scoped to DIRECT PERSONAL columns. A preserved student id, course code or
            // employee number is policy-compliant output, not residue — comparing every
            // classified column would fail this gate for doing exactly what was asked,
            // and block the delivery of a correctly prepared file.
            const personalIndexes = inputClassification.directIdentifierIndexes.filter(
              (_, offset) =>
                requiresPseudonymization(inputClassification.directIdentifierTypes[offset]!),
            );
            const directIndexes = new Set(personalIndexes);
            const rawIdentifiers = new Set(tabularVerificationValues(content));
            const outputDirectValues = outputTable.rows.slice(1).flatMap((row) =>
              personalIndexes.map((index) => (row[index] ?? "").trim()).filter(Boolean),
            );
            const nonNumericIdentifiers = [...rawIdentifiers].filter(
              (value) => !/^[+-]?(?:\d+|\d*\.\d+)$/.test(value),
            );
            stages.push({ stage: "column-detection", pass: directIndexes.size > 0, leak: false });
            stages.push({ stage: "row-count", pass: outputTable.rows.length === inputTable.rows.length, leak: false });
            stages.push({ stage: "column-width", pass: outputTable.rows.every((row) => row.length === inputTable.rows[0]!.length), leak: false });
            stages.push({ stage: "no-raw-identifier-in-output", pass:
              outputDirectValues.every((value) => !rawIdentifiers.has(value)) &&
              nonNumericIdentifiers.every((value) => !outputTable.rows.some((row) => row.some((cell) => cell.includes(value)))),
              leak: true });
            stages.push({ stage: "non-identifier-unchanged", pass:
              inputTable.rows.slice(1).every((row, rowIndex) =>
                row.every((value, columnIndex) =>
                  directIndexes.has(columnIndex) || outputTable.rows[rowIndex + 1]![columnIndex] === value)),
              leak: false });
            stages.push({ stage: "output-has-identifier-columns", pass: classifyStudentRecordTable(outputTable.rows).directIdentifierColumns > 0, leak: false });
          } catch {
            stages.push({ stage: "parse", pass: false, leak: false });
          }
        }
        const transformedFindings = runDetectors(prep.output, {
          entropyThreshold: plan.context.config.scan.entropy_threshold,
          keywords: plan.context.config.scan.keywords,
          relpath,
        });
        stages.push({
          stage: "privacy-rescan",
          pass: transformedFindings.every(
            (finding) => finding.detector.startsWith("tabular-") ||
              (finding.severity !== "high" && finding.severity !== "critical"),
          ),
          leak: true,
        });
        const firstFail = stages.find((s) => !s.pass);
        // A surviving CREDENTIAL/secret is the one thing that must never be delivered,
        // even best-effort — raw unsafe material is kept on this computer (per policy).
        // Everything else (residual quasi-identifiers, structural mismatch) is a
        // re-identification risk, not a live secret, and is delivered with a warning.
        const survivingCredential = transformedFindings.some(
          (finding) =>
            !finding.detector.startsWith("tabular-") &&
            // A high-entropy string on a secret-like assignment is reported at
            // `medium` — that is exactly the shape of an unredacted AWS secret
            // access key, so a residual one must keep the file local.
            finding.severity !== "low" &&
            findingCategory(finding.detector) === "credential",
        );
        // Always visible: log every stage PASS/FAIL for this file.
        progress(
          `Verify ${relpath}: ${stages.map((s) => `${s.stage}=${s.pass ? "PASS" : "FAIL"}`).join(" ")}` +
            (survivingCredential ? " [credential-kept-local]" : ""),
        );
        if (firstFail && survivingCredential) {
          entry.status = "error";
          entry.action = "local-only";
          entry.transmission = "blocked";
          entry.omitted = true;
          entry.error = "Transformed output failed Yuhi privacy rescan.";
          entry.outcome = "local-only-transformation-failed";
          entry.limitation = "verification-failed";
          entry.failureCategory = "unresolved-secret";
          unverifiedTransformations += 1;
          filesExcluded += 1;
          files.push(entry);
          decisionsProcessed += 1;
          continue;
        }
        if (firstFail) {
          // RELAXED outcome (never keep-local, never give up the whole file): deliver
          // the best-effort TRANSFORMED output — already de-identified as far as it
          // got — with an honest warning + the exact stage that failed. Only an
          // unresolved credential (handled above) is ever kept local.
          await writeMirrored(outDir, relpath, prep.output);
          studentAliases = fileAliases;
          provenance.push({ relpath, source: relpath, action: decision.action });
          const tok = tokenEstimate(prep.output);
          beforeTokens += tokenEstimate(content).tokens;
          afterTokens += tok.tokens;
          approx = approx || tok.approx;
          entry.status = "ok";
          entry.action = "allow";
          entry.transmission = "approved";
          entry.omitted = false;
          entry.transformed = true;
          entry.outcome = "included-unverified";
          entry.limitation = "transformation-unavailable";
          entry.failureCategory = firstFail.leak ? "reidentification-risk" : "structural";
          // The TRANSFORMED output was delivered here (best effort), so this is not a
          // raw fallback — but the scan genuinely FAILED and must say so.
          entry.rawFallback = false;
          entry.postTransformScan = "failed";
          entry.error = `Transformed, but verification did not fully pass (first failure: ${firstFail.stage}). Delivered best-effort with a warning.`;
          unverifiedTransformations += 1;
          unsupportedOrUnverifiedFiles += 1;
          files.push(entry);
          decisionsProcessed += 1;
          continue;
        }
        await writeMirrored(outDir, relpath, prep.output);
        studentAliases = fileAliases;
        provenance.push({ relpath, source: relpath, action: decision.action });
        const before = tokenEstimate(content);
        const after = tokenEstimate(prep.output);
        beforeTokens += before.tokens;
        afterTokens += after.tokens;
        approx = approx || before.approx || after.approx;
        const summarized = prep.audits.some((audit) => audit.processorId === "summarize-local");
        const aggregated = prep.audits.some((audit) => audit.processorId === "aggregate-student-records");
        if (pseudonymizedTable) {
          const table = parseTabularRegion(content);
          const classification = classifyStudentRecordTable(table.rows);
          identifierColumnsTransformed += classification.directIdentifierColumns;
          analyticalColumnsPreserved +=
            (table.rows[0]?.length ?? 0) - classification.directIdentifierColumns;
          transformedSensitiveTables += 1;
        }
        if (summarized) filesSummarized += 1;
        const pseudonymized = prep.audits
          .filter((a) =>
            a.processorId === "pseudonymize" ||
            a.processorId === "pseudonymize-student-records"
          )
          .reduce((n, a) => n + a.itemsChanged, 0);
        const sanitized = prep.audits
          .filter((a) =>
            a.processorId === "sanitize-environment" ||
            a.processorId === "sanitize-credentials"
          )
          .reduce((n, a) => n + a.itemsChanged, 0);
        const masked = pseudonymized + sanitized;
        entry.transformations = [
          ...(summarized ? (["summarized"] as const) : []),
          ...(aggregated ? (["aggregated"] as const) : []),
          ...(pseudonymized > 0 ? (["pseudonymized"] as const) : []),
          ...(masked > 0 ? (["masked"] as const) : []),
        ];
        entry.maskedValues = masked;
        entry.transformed = prep.output !== content;
        if (masked > 0) sensitiveMasked += 1;
      } else {
        // Structured/local transformation could not be verified. Do NOT silently drop
        // the file (degraded inclusion): if the original carries no unresolved secret
        // or credential, include it verbatim with a clear "transformation unavailable"
        // warning so Claude still receives the data. Only keep it LOCAL when a real
        // secret/credential blocks safe inclusion.
        const failureReason = entry.error ?? "Safe local transformation could not be verified.";
        const category = classifyTransformFailure(failureReason);
        if (failureReason.startsWith("Malformed delimited table:")) malformedTables += 1;
        else unverifiedTransformations += 1;
        const originalFindings = runDetectors(content, {
          entropyThreshold: plan.context.config.scan.entropy_threshold,
          keywords: plan.context.config.scan.keywords,
          relpath,
        });
        const blockingSecret = originalFindings.some(
          (finding) =>
            (finding.severity === "high" || finding.severity === "critical") &&
            findingCategory(finding.detector) === "credential",
        );
        // PROMISE: recognized tabular/text (csv/tsv/txt/xlsx) is ALWAYS delivered —
        // transformed if we can, otherwise the ORIGINAL is included with an explicit
        // "not de-identified — review before sharing" warning. It is never silently
        // excluded. The ONLY thing kept local is an unresolved SECRET/credential,
        // which must never leave the machine.
        if (!blockingSecret) {
          // PREFER THE PARTIALLY DE-IDENTIFIED OUTPUT over the raw original.
          //
          // The pipeline can block on a single residual cell — e.g. one person's
          // 氏名 value also appearing in an unclassified フリガナ column — while the
          // rest of the table was fully pseudonymized. Shipping `content` there
          // delivered EVERY raw identifier in the file because of that one cell, and
          // `CLAUDE.md` is explicit: raw unsafe content must never be included as an
          // implicit fallback. A strictly-better artifact always wins; the raw
          // original is used only when the pipeline produced nothing better.
          const changedValues = prep.audits
            .filter(
              (audit) =>
                audit.processorId === "pseudonymize" ||
                audit.processorId === "pseudonymize-student-records",
            )
            .reduce((total, audit) => total + audit.itemsChanged, 0);
          const partiallyDeIdentified = prep.output !== content && changedValues > 0;
          const delivered = partiallyDeIdentified ? prep.output : content;
          await writeMirrored(outDir, relpath, delivered);
          provenance.push({ relpath, source: relpath, action: decision.action });
          const tok = tokenEstimate(delivered);
          beforeTokens += tokenEstimate(content).tokens;
          afterTokens += tok.tokens;
          approx = approx || tok.approx;
          entry.status = "ok";
          entry.action = "allow";
          entry.transmission = "approved";
          entry.omitted = false;
          entry.transformed = partiallyDeIdentified;
          entry.outcome = "included-unverified";
          entry.limitation = "transformation-unavailable";
          entry.failureCategory = category;
          // Size accounting must describe the bytes actually delivered, not a buffer
          // that was discarded.
          entry.afterChars = delivered.length;
          entry.rawFallback = !partiallyDeIdentified;
          entry.postTransformScan = partiallyDeIdentified ? "failed" : "not-applicable";
          entry.error = partiallyDeIdentified
            ? `${failureReason} Delivered the partially de-identified output (${changedValues} ` +
              "value(s) replaced) instead of the raw original; NOT fully verified."
            : failureReason;
          unsupportedOrUnverifiedFiles += 1;
        } else {
          // Unresolved credential/secret: the one case we keep local (never sent).
          entry.status = "error";
          entry.action = "local-only";
          entry.transmission = "blocked";
          entry.error = failureReason;
          entry.outcome = "local-only-transformation-failed";
          entry.limitation = "verification-failed";
          entry.failureCategory = "unresolved-secret";
          entry.omitted = true;
          filesExcluded += 1;
        }
      }
      files.push(entry);
      decisionsProcessed += 1;
      detail("prepare", "Preparing safe copies", decisionsProcessed, plan.evaluation.decisions.length);
      if (decisionsProcessed % 25 === 0 || decisionsProcessed === plan.evaluation.decisions.length) {
        progress(`Preparing safe copies · ${decisionsProcessed}/${plan.evaluation.decisions.length} files`);
      }
      continue;
    }

    // Safety net (file-level, NEVER a launch blocker): a file routed to verbatim
    // send that still carries ANY unresolved high/critical finding is excluded by
    // recommendation (kept on this computer) instead of being sent raw. This
    // guarantees no included file holds an unresolved high-risk finding, so a
    // file-level risk can never force a workspace-level launch block. Launch
    // continues with the remaining safe files; the user may include these later.
    const highRiskFinding = decision.findings.find(
      (finding) => finding.severity === "high" || finding.severity === "critical",
    );
    if (highRiskFinding) {
      const isCredential = findingCategory(highRiskFinding.detector) === "credential";
      const tok = tokenEstimate(content);
      beforeTokens += tok.tokens;
      approx = approx || tok.approx;
      if (isCredential) {
        // The ONE thing kept local: an unresolved credential/secret must never be sent.
        files.push({
          relpath,
          action: "local-only",
          status: "error",
          outcome: "local-only-transformation-failed",
          transmission: "blocked",
          beforeChars: content.length,
          afterChars: 0,
          transformed: false,
          omitted: true,
          limitation: "verification-failed",
          failureCategory: "unresolved-secret",
          error: "Unresolved credential detected; kept on this computer for your protection.",
        });
        filesExcluded += 1;
      } else {
        // High-risk content without a verified transform stays local. This is a file
        // decision, not a workspace launch blocker.
        files.push({
          relpath,
          action: "local-only",
          status: "skipped",
          outcome: "local-only-transformation-failed",
          transmission: "blocked",
          beforeChars: content.length,
          afterChars: 0,
          transformed: false,
          omitted: true,
          limitation: "transformation-unavailable",
          failureCategory: "reidentification-risk",
          error: "High-risk content could not be de-identified; kept local.",
        });
        unsupportedOrUnverifiedFiles += 1;
      }
      decisionsProcessed += 1;
      if (decisionsProcessed % 25 === 0 || decisionsProcessed === plan.evaluation.decisions.length) {
        progress(`Preparing safe copies · ${decisionsProcessed}/${plan.evaluation.decisions.length} files`);
      }
      continue;
    }

    // `allow` (and any remaining sendable route): copy verbatim.
    // INSTRUMENTATION: if a tabular text file reaches the raw passthrough, report the
    // classifier's verdict so a "normal CSV delivered raw" is never silent. When the
    // classifier DOES see direct-identifier columns here, routing and detection
    // disagree — the log names the exact columns so the gap is diagnosable, not guessed.
    if (/\.(?:csv|tsv)$/i.test(relpath)) {
      try {
        const table = parseTabularRegion(content);
        const classification = classifyStudentRecordTable(table.rows);
        if (classification.directIdentifierColumns > 0) {
          progress(
            `Route ${relpath}: passed RAW but classifier found ${classification.directIdentifierColumns} identifier column(s) — routing/detection disagree.`,
          );
        } else {
          progress(`Route ${relpath}: passed raw · no direct-identifier columns detected.`);
        }
      } catch {
        progress(`Route ${relpath}: passed raw · not parseable as a table.`);
      }
    }
    await writeMirrored(outDir, relpath, content);
    // Small text files are already concise; summarize only document-sized inputs.
    if (
      !options.deferDocumentInspection &&
      decision.action === "allow" &&
      /\.(?:md|txt)$/i.test(relpath) &&
      content.length >= 2_000
    ) {
      textDocumentsInspected += 1;
      await prepareContextSummary(relpath, content, "text");
    }
    provenance.push({ relpath, source: relpath, action: decision.action });
    const tok = tokenEstimate(content);
    beforeTokens += tok.tokens;
    afterTokens += tok.tokens;
    approx = approx || tok.approx;
    files.push({
      relpath,
      action: decision.action,
      status: "ok",
      outcome: "included-unchanged",
      transmission: "approved",
      beforeChars: content.length,
      afterChars: content.length,
        transformed: false,
    });
    decisionsProcessed += 1;
    if (decisionsProcessed % 25 === 0 || decisionsProcessed === plan.evaluation.decisions.length) {
      progress(`Preparing safe copies · ${decisionsProcessed}/${plan.evaluation.decisions.length} files`);
    }
   } catch (error) {
      // PER-FILE ISOLATION (never stop): one file that cannot be read or processed
      // — it vanished, was moved, is locked, or is corrupt — must never fail the
      // whole preparation. Skip it with a non-sensitive note and keep going. In a
      // large, active workspace some files inevitably change mid-run.
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      progress(`Skipped ${decision.relpath}: could not be read or processed during preparation.`);
      filesExcluded += 1;
      files.push({
        relpath: decision.relpath,
        action: "local-only",
        status: "error",
        outcome: "local-only-unsupported",
        transmission: "blocked",
        beforeChars: 0,
        afterChars: 0,
        omitted: true,
        error:
          "File could not be read or processed during preparation (it may have changed or been removed); skipped.",
      });
      decisionsProcessed += 1;
    }
  }

  // PROBLEM 1 — filename de-identification: a path like `20260715-110046-A000000.csv`
  // leaks a direct identifier before Claude even opens the file. Rewrite delivered
  // paths so identifier tokens become stable pseudonyms; the reverse mapping is kept
  // ONLY in the manifest (originalRelpath + provenance.source), never in a name Claude
  // sees. Runs before context/index/manifest generation so those reference the safe
  // names. `.yuhi/` internal files are left untouched.
  {
    const claimed = new Set(files.map((file) => file.relpath));
    const renamed = new Map<string, string>();
    for (const entry of files) {
      if (entry.omitted || entry.relpath.startsWith(".yuhi/")) continue;
      const proposed = pseudonymizeIdentifierPath(entry.relpath, salt);
      if (proposed === entry.relpath) continue;
      // Resolve any collision with an existing/claimed name deterministically.
      let candidate = proposed;
      if (claimed.has(candidate)) {
        const ext = path.posix.extname(proposed);
        const stem = ext ? proposed.slice(0, -ext.length) : proposed;
        let n = 2;
        while (claimed.has(candidate)) candidate = `${stem}-${n++}${ext}`;
      }
      try {
        await renameMirrored(outDir, entry.relpath, candidate);
      } catch {
        // If the on-disk rename fails, keep the original name rather than losing the
        // file — de-identifying the name is best-effort, never a launch blocker.
        continue;
      }
      claimed.delete(entry.relpath);
      claimed.add(candidate);
      renamed.set(entry.relpath, candidate);
      entry.originalRelpath = entry.relpath;
      entry.relpath = candidate;
      filenamesPseudonymized += 1;
    }
    for (const record of provenance) {
      const mapped = renamed.get(record.relpath);
      if (mapped) record.relpath = mapped; // source stays = original (the mapping record)
    }
  }

  // ===== SAFETY-MODE CENTRALIZED ESCALATION PASS =====
  // Safety-mode escalation applies only to ACTUAL sensitive findings. Inspection
  // unavailable/incomplete is not a finding and must remain included with a warning in
  // every mode; otherwise one unsupported parser silently empties the agent workspace.
  // Hard blocks (credentials/private keys/explicit policy) were withheld earlier.
  {
    const zeroFindings = requiresZeroFindings(safetyMode);
    for (const entry of files) {
      if (entry.omitted) continue;
      const keepUnverified = keepUnverifiedLocal && entry.outcome === "included-unverified";
      // Maximum Privacy also keeps local any still-delivered file whose transformed
      // copy carried a sensitive finding. A clean verified file is left delivered, and
      // sanitized document companions (safe by construction) are never touched.
      const keepForFinding =
        zeroFindings &&
        !entry.document &&
        ((entry.maskedValues ?? 0) > 0 || (entry.unresolvedHighRiskCount ?? 0) > 0);
      if (!keepUnverified && !keepForFinding) continue;
      // Remove the delivered artifact from the workspace, then mark it local-only —
      // mirrors the final-gate "credential survived → keep local" handling.
      const deliveredAbs = path.join(outDir, ...entry.relpath.split("/"));
      await rm(deliveredAbs, { force: true });
      // afterTokens feeds an ESTIMATE only; approximate the delivered cost from the
      // artifact size and clamp so the running total never goes negative.
      afterTokens = Math.max(0, afterTokens - Math.ceil(entry.afterChars / 4));
      entry.omitted = true;
      entry.status = "skipped";
      entry.action = "local-only";
      entry.transmission = "blocked";
      entry.outcome = "local-only-unverified";
      entry.transformed = false;
      entry.afterChars = 0;
      entry.keptLocalBySafetyMode = safetyMode;
      filesExcluded += 1;
      progress(
        `${safetyModeLabel(safetyMode)}: kept ${entry.relpath} local (${
          keepUnverified ? "unverified content" : "sensitive finding"
        }) — not delivered to the agent.`,
      );
    }
  }

  // ===== v0.3.3 STRUCTURE COMPRESSION (opt-in) =====
  // Runs AFTER the per-file loop, filename de-identification, and the Safety-Mode
  // escalation, and BEFORE the final integrity gate / context building. This is the
  // ONLY place the compression module — and thus the `typescript` parser — is loaded,
  // so a `compress: false` run loads nothing extra and is byte-for-byte identical to a
  // run without compression. It reads DELIVERED files from `outDir`, decides a
  // representation via the deterministic token budget, then rewrites (compressed),
  // removes (excluded), or leaves (full) the DELIVERED copy. SOURCE FILES ARE NEVER
  // READ OR WRITTEN HERE — only files under `outDir` change.
  let compressionReport: CompressionReport | undefined;
  if (options.compress) {
    const compression = await import("./compression/index.js");
    const registry = new compression.CompressorRegistry()
      .register(new compression.TypeScriptCompressor())
      .register(new compression.JavaScriptCompressor())
      .register(new compression.LargeArtifactCompressor());
    const compressionThresholdTokens = options.compressionThresholdTokens ?? 2000;

    interface CompressionCandidate {
      entry: PreparedFileEntry;
      compressedContent?: string;
      /** Specific compressor outcome reason (kept distinct from the budget reason). */
      compressorReason?: string;
      input: BudgetFileInput;
    }
    const candidates: CompressionCandidate[] = [];
    for (const entry of files) {
      // Only agent-facing delivered source text: skip omitted files, Yuhi's own
      // `.yuhi/` internals, and generated document companions/placeholders.
      if (entry.omitted) continue;
      if (entry.relpath.startsWith(".yuhi/")) continue;
      if (entry.document) continue;
      let content: string;
      try {
        content = await readFile(path.join(outDir, ...entry.relpath.split("/")), "utf8");
      } catch {
        continue; // unreadable/binary delivered artifact — leave it exactly as delivered
      }
      const signals = compression.deriveMustKeepSignals(entry.relpath);
      const supported = registry.find(entry.relpath, content) !== undefined;
      // Only files a compressor SUPPORTS are parsed; everything else is measured for the
      // budget as a plain full file (never compressed, never force-excluded if MustKeep).
      const result = supported
        ? await registry.compress({ relpath: entry.relpath, content })
        : undefined;
      const fullTokens = result ? result.originalTokens : compression.estimateTokens(content);
      const parseFailed = result?.warnings.some(
        (w) => w.code === "parse-failed" || w.code === "compressor-unavailable",
      );
      // Distinct compressor outcome (kept SEPARATE per the reason vocabulary): the
      // parser could not be loaded vs a real syntax error vs compressed-but-not-smaller.
      const compressorReason: string | undefined = result?.warnings.some(
        (w) => w.code === "compressor-unavailable",
      )
        ? "compressor-unavailable"
        : result?.warnings.some((w) => w.code === "parse-failed")
          ? "parse-failed"
          : result?.warnings.some((w) => w.code === "too-small")
            ? "compression-not-smaller"
            : undefined;
      const input: BudgetFileInput = {
        relpath: entry.relpath,
        fullTokens,
        ...(result?.representation === "compressed"
          ? { compressedTokens: result.compressedTokens }
          : {}),
        ...(signals.entryPoint ? { entryPoint: true } : {}),
        ...(signals.packageManifest ? { packageManifest: true } : {}),
        ...(signals.configFile ? { configFile: true } : {}),
        ...(signals.agentInstruction ? { agentInstruction: true } : {}),
        ...(parseFailed ? { parseFailed: true } : {}),
      };
      candidates.push({
        entry,
        ...(result?.representation === "compressed" ? { compressedContent: result.content } : {}),
        ...(compressorReason ? { compressorReason } : {}),
        input,
      });
    }

    const budget = compression.selectRepresentations(
      candidates.map((c) => c.input),
      { tokenBudget: options.tokenBudget ?? null, compressionThresholdTokens },
    );
    const decisionByPath = new Map(budget.decisions.map((d) => [d.relpath, d]));

    // APPLY the decisions to the DELIVERED workspace only. The compressors and the
    // budget selector are pure, so identical inputs + options yield identical delivered
    // bytes and an identical summary.
    for (const candidate of candidates) {
      const decision = decisionByPath.get(candidate.input.relpath);
      if (!decision) continue;
      const deliveredAbs = path.join(outDir, ...candidate.entry.relpath.split("/"));
      candidate.entry.contextRepresentation = decision.representation;
      // Split the compressor-outcome reasons from the budget's generic ones, while
      // keeping MustKeep reasons (entry-point, package-manifest, …) authoritative.
      candidate.entry.compressionReason =
        candidate.compressorReason &&
        (decision.reason === "parse-failed" || decision.reason === "not-compressible")
          ? candidate.compressorReason
          : decision.reason;
      candidate.entry.originalTokens = decision.fullTokens;
      candidate.entry.preparedTokens = decision.finalTokens;
      if (decision.representation === "compressed" && candidate.compressedContent !== undefined) {
        // Preserve the useful original at its normal path. The compact form is an
        // additional initial-context representation under .yuhi/context/, never a
        // destructive replacement. Parser/output failure therefore falls back to FULL.
        const compactRelpath = `.yuhi/context/compact/${candidate.entry.relpath}.md`;
        const compact = [
          "# Yuhi compact representation",
          "",
          `Source: ${candidate.entry.relpath}`,
          "",
          "The full original remains available at the source path in this Prepared Workspace.",
          "",
          "```",
          candidate.compressedContent,
          "```",
          "",
        ].join("\n");
        const compactFindings = runDetectors(compact, {
          entropyThreshold: plan.context.config.scan.entropy_threshold,
          keywords: plan.context.config.scan.keywords,
          relpath: compactRelpath,
        });
        if (compactFindings.length === 0) {
          await writeMirrored(outDir, compactRelpath, compact);
          afterTokens = Math.max(0, afterTokens - candidate.input.fullTokens + decision.finalTokens);
        } else {
          candidate.entry.contextRepresentation = "full";
          candidate.entry.compressionReason = "verification-failed-full-fallback";
          candidate.entry.preparedTokens = candidate.input.fullTokens;
        }
      } else if (decision.representation === "excluded") {
        // A token target is advisory. It must never make a useful source file vanish.
        // Keep FULL and report best-effort instead of deleting repository capability.
        void deliveredAbs;
        candidate.entry.contextRepresentation = "full";
        candidate.entry.compressionReason = "budget-unmet-full-fallback";
        candidate.entry.preparedTokens = candidate.input.fullTokens;
      }
    }

    const actualFiles = candidates.map((candidate) => ({
      relpath: candidate.entry.relpath,
      representation: candidate.entry.contextRepresentation === "compressed" ? "compressed" as const : "full" as const,
      reason: candidate.entry.compressionReason ?? "not-compressible",
      originalTokens: candidate.input.fullTokens,
      preparedTokens: candidate.entry.contextRepresentation === "compressed"
        ? candidate.entry.preparedTokens ?? candidate.input.fullTokens
        : candidate.input.fullTokens,
    }));
    const actualOriginal = actualFiles.reduce((sum, file) => sum + file.originalTokens, 0);
    const actualPrepared = actualFiles.reduce((sum, file) => sum + file.preparedTokens, 0);
    const actualReduced = Math.max(0, actualOriginal - actualPrepared);

    compressionReport = {
      originalTokens: actualOriginal,
      preparedTokens: actualPrepared,
      reductionPercent: actualOriginal > 0 ? (actualReduced / actualOriginal) * 100 : 0,
      fullFiles: actualFiles.filter((file) => file.representation === "full").length,
      compressedFiles: actualFiles.filter((file) => file.representation === "compressed").length,
      excludedFiles: 0,
      compressionReductionTokens: actualReduced,
      exclusionReductionTokens: 0,
      targetBudget: budget.summary.targetBudget,
      actualTokens: actualPrepared,
      status: options.tokenBudget === null || options.tokenBudget === undefined
        ? "no-budget"
        : actualPrepared <= options.tokenBudget ? "within-budget" : "best-effort",
      ...(budget.summary.budgetReason !== undefined
        ? { budgetReason: budget.summary.budgetReason }
        : {}),
      warnings: budget.summary.warnings,
      files: actualFiles,
    };
  }

  // ===== MANDATORY FINAL-ARTIFACT SECURITY GATE =====
  // Re-open EVERY delivered CSV/TXT/XLSX from disk — AFTER every write, rename and
  // fallback — and scan the ACTUAL bytes for raw identifier values taken from the
  // SOURCE, plus surviving credentials. No earlier detector result, in-memory
  // buffer, or transform flag is trusted here. This gate is the single source of
  // truth for the safety report: a file may be reported de-identified ONLY if its
  // final bytes on disk contain no source identifier.
  progress("Final privacy gate: rescanning delivered files");
  for (const entry of files) {
    if (entry.omitted) continue;
    if (!/\.(?:csv|tsv|txt|xlsx)$/i.test(entry.relpath)) continue;
    // Files passed through un-inspected because they exceeded the in-memory ceiling
    // are not reopened here — that would re-introduce the OOM the pass-through avoids.
    if (entry.beforeChars > MAX_INMEMORY_TRANSFORM_BYTES) {
      entry.finalRescanVerified = false;
      continue;
    }
    try {
    const sourceRel = entry.originalRelpath ?? entry.relpath;
    const sourceAbs = path.join(root, ...sourceRel.split("/"));
    const deliveredAbs = path.join(outDir, ...entry.relpath.split("/"));
    let sourceValues: string[] = [];
    let deliveredText = "";
    // LAYER 1 — structured full-table rescan (header/body agnostic, never uses
    // dataStartRow). Populated for delimited text below.
    let structuredResidueCells = 0;
    let structuredResidueValues: string[] = [];
    try {
      if (/\.xlsx$/i.test(entry.relpath)) {
        const srcBuf = await readFile(sourceAbs);
        try {
          sourceValues = (await pseudonymizeXlsxRecords(srcBuf, createStudentAliasContext()))
            .rawIdentifiers;
        } catch {
          sourceValues = [];
        }
        deliveredText = await xlsxCellText(await readFile(deliveredAbs));
      } else {
        const sourceText = await readFile(sourceAbs, "utf8");
        deliveredText = await readFile(deliveredAbs, "utf8");
        // Candidate values are collected across EVERY row — a header/body
        // misdetection must not shrink the verification surface.
        sourceValues = tabularVerificationValues(sourceText);
        const structured = tabularResidueCells(sourceText, deliveredText);
        structuredResidueCells = structured.residueCells;
        structuredResidueValues = structured.residueValues;
      }
    } catch {
      // Could not reopen/parse the delivered artifact to verify it → cannot claim
      // safety. Mark unverified honestly rather than silently passing.
      entry.finalRescanVerified = false;
      if (entry.outcome === "included-transformed") entry.outcome = "included-unverified";
      continue;
    }
    // Distinguish distinctive identifiers from ambiguous numbers to avoid false
    // positives: a quiz score of "100" is not a leak just because a student id is
    // also "100". Non-numeric values (names, alphanumeric IDs, emails) are flagged
    // wherever they appear; purely-numeric values only when they survive in an
    // actual identifier COLUMN of the delivered table (never an analytical cell).
    const numericRe = /^[+-]?\d+(?:\.\d+)?$/;
    const candidates = sourceValues.filter((value) => value.length >= 2);
    // LAYER 2 — independent scan of the delivered BYTES. Substring search, so it
    // holds even when the delivered artifact no longer parses as a table.
    const surviving = candidates.filter((value) => !numericRe.test(value) && deliveredText.includes(value));
    const numericValues = candidates.filter((value) => numericRe.test(value));
    if (numericValues.length > 0 && !/\.xlsx$/i.test(entry.relpath)) {
      try {
        const table = parseTabularRegion(deliveredText);
        const idIdx = classifyStudentRecordTable(table.rows).directIdentifierIndexes;
        // EVERY row, row 0 included: a numeric identifier left in a misdetected
        // header row is exactly the residue this gate exists to catch.
        const idCells = new Set(
          table.rows.flatMap((row) => idIdx.map((i) => (row[i] ?? "").trim())),
        );
        for (const value of numericValues) if (idCells.has(value)) surviving.push(value);
      } catch {
        /* unparseable delivered table → rely on the non-numeric check above */
      }
    }
    // Fold LAYER 1 in: a structured residue counts even if the byte scan missed it.
    for (const value of structuredResidueValues) {
      if (!surviving.includes(value)) surviving.push(value);
    }
    const credentialFindings = runDetectors(deliveredText, {
      entropyThreshold: plan.context.config.scan.entropy_threshold,
      keywords: plan.context.config.scan.keywords,
      relpath: entry.relpath,
    }).filter(
      (finding) =>
        (finding.severity === "high" || finding.severity === "critical") &&
        findingCategory(finding.detector) === "credential",
    );
    progress(
      `Final rescan ${entry.relpath}: ${
        surviving.length ? `SURVIVING ${surviving.length} identifier(s)` : "clean"
      } (structured=${structuredResidueCells} cell(s), byte-scan=${
        candidates.filter((v) => deliveredText.includes(v)).length
      } value(s))${credentialFindings.length ? " +credential" : ""}`,
    );
    if (credentialFindings.length > 0) {
      // A credential survived into the delivered file → keep local. Remove it from
      // the workspace so Claude never receives raw secret material.
      await rm(deliveredAbs, { force: true });
      entry.omitted = true;
      entry.status = "error";
      entry.action = "local-only";
      entry.transmission = "blocked";
      entry.outcome = "local-only-transformation-failed";
      entry.failureCategory = "unresolved-secret";
      entry.error = "A credential survived into the final artifact; kept on this computer for your protection.";
      entry.transformed = false;
      entry.finalRescanVerified = false;
      finalCredentialKeptLocal += 1;
      filesExcluded += 1;
    } else if (surviving.length > 0) {
      // Personal identifiers survived (e.g. an XLSX whose transform fell back to the
      // raw original). Per policy the file is still DELIVERED with a warning, but it
      // must NEVER be reported as transformed/verified/handled.
      entry.outcome = "included-unverified";
      entry.failureCategory = "reidentification-risk";
      entry.transformed = false;
      entry.finalRescanVerified = false;
      // Residue was FOUND. Never "not applicable".
      entry.postTransformScan = "failed";
      entry.error =
        `Final artifact still contains ${surviving.length} source identifier value(s); ` +
        "delivered with a warning — NOT de-identified.";
      finalIdentifierLeaks += 1;
    } else {
      entry.finalRescanVerified = true;
      // A file delivered as its raw original was never transformed, so a clean byte
      // scan does not make it "passed" — the scan simply had nothing to verify.
      entry.postTransformScan = entry.rawFallback === true ? "not-applicable" : "passed";
    }
    } catch {
      // The final gate must never fail the whole run: if verifying one delivered
      // file throws (unreadable, unparseable, removed mid-run), mark it unverified
      // and move on rather than aborting a completed preparation.
      entry.finalRescanVerified = false;
    }
  }

  // ===== FINAL GATE for GENERATED DOCUMENT ARTIFACTS (companions / placeholders) =====
  // Re-open each delivered document companion/placeholder from disk and scan the actual
  // bytes for surviving CREDENTIALS. If one is found the artifact is replaced with a
  // safe stub (never delivering the secret) and recorded honestly. Personal identifiers
  // are already redacted by the companion builder and disclosed as residual risk.
  for (const entry of files) {
    if (entry.omitted || !entry.document) continue;
    const deliveredAbs = path.join(outDir, ...entry.relpath.split("/"));
    try {
      const text = await readFile(deliveredAbs, "utf8");
      const credential = runDetectors(text, {
        entropyThreshold: plan.context.config.scan.entropy_threshold,
        keywords: plan.context.config.scan.keywords,
        relpath: entry.relpath,
      }).some(
        (finding) =>
          (finding.severity === "high" || finding.severity === "critical") &&
          findingCategory(finding.detector) === "credential",
      );
      if (credential) {
        const stub = [
          "# Document companion withheld",
          "",
          "Yuhi generated a companion for this document but its final scan detected a",
          "credential-like value, so the companion was NOT shared with the agent.",
          "",
          `- Source type: ${entry.document.sourceType}`,
          "- Original file shared with agent: no",
          "- Companion shared with agent: no (credential detected)",
          "",
        ].join("\n");
        await writeMirrored(outDir, entry.relpath, stub);
        entry.document.finalArtifactScanStatus = "credential-removed";
        entry.document.deliveredArtifactType = "safe-placeholder";
        entry.outcome = "included-unverified";
        entry.transformed = false;
        entry.error = "A credential survived into the generated companion; it was withheld.";
      } else {
        entry.document.finalArtifactScanStatus =
          entry.document.residualNameRisk ? "identifier-warning" : "clean";
      }
    } catch {
      entry.document.finalArtifactScanStatus = "identifier-warning";
    }
  }

  // ===== AGENT-VISIBLE METADATA BOUNDARY =====
  // The withheld set is final here (policy blocks, safety-mode escalation, and both
  // final gates have all run). Give every entry its stable public identity, then build
  // the redaction list for the names that may NOT cross into the prepared workspace:
  // a real filename is identifying data (`9999990001 評定-0722.xlsx`), so withholding
  // a file's bytes while publishing its name would disclose the identifier anyway.
  // `files` itself keeps the private paths — the local UI shows the user their own
  // filenames; only what is WRITTEN at or below `outDir` goes through the boundary.
  for (const entry of files) {
    entry.documentId = documentIdFor(entry.originalRelpath ?? entry.relpath, salt);
  }
  const metadataRedactions = buildWithheldRedactions({
    withheld: files
      .filter((entry) => entry.omitted === true)
      .map((entry) => ({
        sourceRelpath: entry.originalRelpath ?? entry.relpath,
        documentId: entry.documentId ?? documentIdFor(entry.relpath, salt),
      })),
    delivered: files.filter((entry) => entry.omitted !== true).map((entry) => entry.relpath),
  });
  /** Project one agent-visible surface through the boundary before writing it. */
  const publicSurface = <T,>(value: T): T => redactMetadata(value, metadataRedactions);
  /** The public label for an entry: a delivered name, or a kind-only withheld label. */
  const publicEntryName = (entry: PreparedFileEntry): string =>
    entry.omitted === true
      ? withheldDisplayName(
          entry.originalRelpath ?? entry.relpath,
          entry.documentId ?? documentIdFor(entry.relpath, salt),
        )
      : entry.relpath;
  /**
   * The public label for a SOURCE path. Surfaces built from source paths (the document
   * index) must print the DELIVERED name — the source name may have been pseudonymized
   * away or withheld entirely, and printing it would undo either control.
   */
  const publicSourceName = (sourceRelpath: string): string => {
    const entry = files.find((file) => (file.originalRelpath ?? file.relpath) === sourceRelpath);
    return entry
      ? publicEntryName(entry)
      : withheldDisplayName(sourceRelpath, documentIdFor(sourceRelpath, salt));
  };

  extractedDocuments.clear();
  detail("context", "Generating local context", documentIndex.length, documentIndex.length);
  if (documentIndex.length === 0) {
    progress("Generating local context: skipped (no documents requiring summary)");
  }
  {
    // Always write the document index so an agent told to read it never finds it
    // missing. When no documents required summarization, say so honestly (rather
    // than omitting the file), and note that background preparation may add more.
    const documentEntries =
      documentIndex.length > 0
        ? documentIndex.flatMap((document) => [
            `### ${publicSourceName(document.relpath)}`,
            "",
            `- Inspection: ${
              document.method === "ocr"
                ? "OCR"
                : document.method === "text"
                  ? "Text document"
                  : "PDF text extraction"
            }`,
            ...(document.pages !== undefined ? [`- Pages: ${document.pages}`] : []),
            `- Summary: ${
              document.status === "created"
                ? "Created"
                : document.status === "rejected"
                  ? "Rejected by security verification"
                  : document.status === "pending"
                    ? "Pending background inspection"
                    : "Local model unavailable"
            }`,
            ...(document.summaryRelpath ? [`- Context file: ${document.summaryRelpath}`] : []),
            "",
          ])
        : [
            "_No documents required local summarization in this run._",
            "",
            "Prepared project files are available directly in this Prepared Workspace.",
            "If a document summary you expected is missing, it may still be in",
            "background preparation — re-read this index when Yuhi reports an update.",
            "",
          ];
    const index = [
      "# Yuhi Document Context",
      "",
      "Generated locally by Yuhi. Extracted document text is not stored.",
      "",
      "## Documents",
      "",
      ...documentEntries,
    ].join("\n");
    await writeMirrored(outDir, ".yuhi/context/document-index.md", publicSurface(index));
  }

  const beforeChars = files.reduce((n, f) => (f.omitted ? n : n + f.beforeChars), 0);
  const afterChars = files.reduce((n, f) => (f.omitted ? n : n + f.afterChars), 0);
  const report = reductionReport({
    beforeChars,
    afterChars,
    beforeTokens,
    afterTokens,
    approx,
    filesExcluded,
    filesSummarized,
    sensitiveMasked,
  });

  progress(`Verifying prepared output · 0/${files.length} files`);
  detail("verify", "Verifying prepared output", 0, files.length);
  await options.beforeIntegrityVerification?.();
  let sourceIntegrityAfter: Map<string, SourceIntegrityEntry>;
  try {
    const afterPlan = await computePlan(dir, {
      ...(agent !== undefined ? { agent } : {}),
      interactive: false,
      documentInspector: {
        canInspect: () => false,
        inspect: async () => ({
          status: "unavailable",
          extractedTextAvailable: false,
          extractionMethod: "none",
          warnings: ["integrity-pass-does-not-inspect-documents"],
        }),
      },
    });
    sourceIntegrityAfter = await captureSourceIntegrity(root, afterPlan.scan.files, {
      ...(signal !== undefined ? { signal } : {}),
      phase: "after",
      ...(onProgress !== undefined
        ? {
            onProgress: (message) => {
              const count = message.match(/after (\d+\/\d+)/)?.[1];
              progress(`Verifying prepared output${count ? ` · ${count} files` : ""}`);
              const matched = message.match(/after (\d+)\/(\d+)/);
              if (matched) detail("verify", "Verifying prepared output", Number(matched[1]), Number(matched[2]));
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(SOURCE_INTEGRITY_ERROR);
  }
  const changedSources = listChangedIntegrity(sourceIntegrityBefore, sourceIntegrityAfter);
  if (changedSources.length > 0) {
    // Name the culprits (local diagnostic) so a repeated integrity failure is not a
    // mystery — e.g. an editor autosave or a sync client touching a source file.
    progress(
      `Source workspace changed during preparation (${changedSources.length}): ` +
        changedSources.slice(0, 8).join(", "),
    );
    throw new Error(SOURCE_INTEGRITY_ERROR);
  }
  const originalSourceFilesModified = 0;
  progress(`Verifying prepared output · ${files.length}/${files.length} files`);
  detail("verify", "Prepared output verified", files.length, files.length);
  const unresolvedHighRiskFindings = plan.evaluation.decisions.reduce((total, decision) => {
    const file = files.find((candidate) => candidate.relpath === decision.relpath);
    // `included-unverified` (degraded inclusion, uninspected binaries) is already a
    // surfaced "review before sharing" warning and is launch-able; unresolved SECRETS
    // are kept local by the degraded-inclusion gate, so such files do not block launch.
    if (
      !file ||
      file.status !== "ok" ||
      file.omitted ||
      file.action !== "allow" ||
      file.outcome === "included-unverified"
    )
      return total;
    return total + decision.findings.filter(
      (finding) => finding.severity === "high" || finding.severity === "critical",
    ).length;
  }, 0);
  // SINGLE launch decision (one source of truth): the Prepared Workspace is usable
  // when every INCLUDED file was written and approved (i.e. no copy failure). File-
  // level warnings — included-unverified, high-risk finding, mapping conflict,
  // unsupported structure — are informational ONLY and must never block launch or
  // trigger recovery.
  const launchAllowed = files
    .filter((file) => !file.omitted)
    .every((file) => file.status === "ok" && file.transmission === "approved");
  const unresolvedCredential = plan.evaluation.decisions.some((decision) => {
    const file = files.find((candidate) => candidate.relpath === decision.relpath);
    return (
      file?.status === "ok" &&
      !file.omitted &&
      file.action === "allow" &&
      decision.findings.some(
        (finding) =>
          (finding.severity === "high" || finding.severity === "critical") &&
          findingCategory(finding.detector) === "credential",
      )
    );
  });
  const blockedReason = unresolvedCredential
    ? "credential_not_resolved"
    : malformedTables > 0
      ? "table_not_parseable"
      : unverifiedTransformations > 0
        ? "transformation_not_verified"
        : restrictedUnresolvedFiles > 0
          ? "restricted_data_not_resolved"
          : unresolvedHighRiskFindings > 0
            ? "high_risk_finding_not_resolved"
            : "prepared_output_not_verified";

  const availableProjectFiles = files.filter(
    (file) => file.status === "ok" && !file.omitted,
  ).length;
  const transformedProjectFiles = files.filter(
    (file) => file.status === "ok" && !file.omitted && file.transformed,
  ).length;
  const localOnlyProjectFiles = files.filter((file) => file.omitted).length;
  // ONE derivation of the delivery facts, shared by the manifest, the report, the
  // CLI and the VS Code panel. No surface may recompute or hardcode these (#12).
  const deliveryIntegrity = buildDeliveryIntegritySummary(files);
  const rawFallbackUsed = deliveryIntegrity.rawFallbackFiles > 0;

  // Duplicate-content families over the artifacts actually delivered (#15/P1-B).
  // Yuhi's own transform normalizes BOM and line endings away, so distinct source
  // files can become byte-identical deliveries; nothing used to record that.
  const familyCandidates: FamilyCandidate[] = [];
  for (const entry of files) {
    if (entry.omitted) continue;
    if (entry.relpath.startsWith(".yuhi/") || entry.relpath === "manifest.json") continue;
    const abs = path.join(outDir, ...entry.relpath.split("/"));
    try {
      // NO stat-then-read: checking the path and then opening it by name leaves a
      // window in which the file can change (CWE-367). The bytes we actually read
      // are the single source of truth for both content and size, and a directory
      // or unreadable entry simply throws into the catch below.
      const buffer = await readFile(abs);
      const isText = /\.(?:csv|tsv|txt)$/i.test(entry.relpath);
      familyCandidates.push({
        relpath: entry.relpath,
        bytes: buffer.byteLength,
        ...(isText
          ? { text: buffer.toString("utf8") }
          : { sha256: createHash("sha256").update(buffer).digest("hex") }),
        ...(entry.documentId ? { documentId: entry.documentId } : {}),
      });
    } catch {
      // A delivered artifact we cannot reopen simply does not participate.
    }
  }
  const contentFamilies: ContentFamilyMetrics = buildContentFamilies(
    familyCandidates,
    files.reduce((total, f) => total + (f.omitted ? 0 : Math.max(0, f.beforeChars)), 0),
  );

  // Deliver ONE canonical representation per family and replace the redundant TEXT
  // copies with a short alias that names it. The content stays available (at the
  // canonical path), the agent is told which representation to analyse, and the same
  // bytes stop being counted as extra context. Binary artifacts are only recorded,
  // never rewritten — an alias written into an .xlsx would corrupt it.
  let duplicateAliasesWritten = 0;
  for (const family of contentFamilies.families) {
    const canonical = family.members.find((member) => member.canonical);
    if (!canonical) continue;
    for (const member of family.members) {
      if (member.canonical) continue;
      if (!/\.(?:csv|tsv|txt)$/i.test(member.relpath)) continue;
      const entry = files.find((file) => file.relpath === member.relpath);
      if (!entry || entry.omitted) continue;
      const alias = duplicateAliasText(family);
      // The bytes this artifact contributed BEFORE aliasing, so the saving reported
      // is the real one. Estimating the token cost of the byte COUNT (`"195"`) was a
      // meaningless subtraction of ~1 token per file.
      const replacedText = familyCandidates.find(
        (candidate) => candidate.relpath === member.relpath,
      )?.text;
      // ONLY alias when it actually shrinks the agent-visible context. The alias body
      // carries a family id, a canonical path, a public document id and (for a
      // normalized family) a format-loss note, so for a SMALL table the stub is
      // larger than the table it replaces — aliasing there would increase delivered
      // bytes, which is the opposite of the point. The duplicate is still recorded in
      // the family metrics either way.
      if (replacedText !== undefined && alias.length >= replacedText.length) {
        entry.duplicateOfFamily = family.familyId;
        entry.canonicalRelpath = family.canonicalRelpath;
        if (family.canonicalDocumentId) entry.canonicalDocumentId = family.canonicalDocumentId;
        continue;
      }
      await writeMirrored(outDir, member.relpath, alias);
      entry.afterChars = alias.length;
      // `compressed` is what Safe Apply refuses to write back to source
      // (`patch-compressed-source`), which is exactly right for a stub: an agent
      // edit to an alias must never overwrite the real table.
      entry.contextRepresentation = "compressed";
      entry.duplicateOfFamily = family.familyId;
      entry.canonicalRelpath = family.canonicalRelpath;
      if (family.canonicalDocumentId) entry.canonicalDocumentId = family.canonicalDocumentId;
      if (replacedText !== undefined) {
        const saved = tokenEstimate(replacedText).tokens - tokenEstimate(alias).tokens;
        afterTokens -= Math.max(0, saved);
      }
      duplicateAliasesWritten += 1;
    }
  }
  if (duplicateAliasesWritten > 0) {
    progress(
      `Duplicate content: ${duplicateAliasesWritten} redundant representation(s) replaced ` +
        `with a canonical alias across ${contentFamilies.families.length} family(ies).`,
    );
  }


  refreshPublicAvailability(files);
  let publicSummary = buildPublicPreparedContextSummary({
    files,
    ...(compressionReport ? { compression: compressionReport } : {}),
    reduction: report,
    originalWorkspaceModified: originalSourceFilesModified > 0,
    secretsExposed: unresolvedCredential ? 1 : 0,
  });
  const estimatedContextReduction = publicSummary.reductionPercent;
  const agentHandoff = [
    "# Yuhi Agent Handoff",
    "",
    "This handoff was generated locally by Yuhi for the AI agent working in this Prepared Workspace.",
    "",
    "## Start here",
    "",
    "1. Read `.yuhi/context/document-index.md` first — Yuhi's index of prepared document context (always present).",
    "2. Yuhi may continue background document preparation while you work; re-read the index when Yuhi reports an update.",
    "3. Use linked verified summaries as the document map when available.",
    "4. Work only with files available in this Prepared Workspace.",
    "5. If information is missing, tell the user what is missing. Do not search outside the workspace.",
    "",
    "## Preparation status",
    "",
    `- Launch status: ${launchAllowed ? "Ready" : "Not ready"}`,
    `- Project files available: ${availableProjectFiles}`,
    `- Files transformed locally: ${transformedProjectFiles}`,
    `- Documents inspected: ${documentIndex.length}`,
    `- Context summaries created: ${documentSummariesCreated}`,
    `- Files not included: ${localOnlyProjectFiles}`,
    "- Original workspace files modified during preparation: 0",
    `- Estimated context reduction: ${estimatedContextReduction === null ? "Not measured" : `${estimatedContextReduction.toFixed(1)}%`}`,
    `- Estimated tokens: ${publicSummary.originalEstimatedTokens ?? "Not measured"} before → ${publicSummary.preparedEstimatedTokens ?? "Not measured"} after`,
    `- Background pending: ${publicSummary.backgroundPendingFiles}`,
    `- Excluded for safety: ${publicSummary.excludedForSafetyFiles}`,
    `- Kept local after processing failure: ${publicSummary.keptLocalAfterFailureFiles}`,
    "- Actual agent usage may differ because of system prompts, tool output, conversation history, and caching.",
    "",
    ...describeUnavailableFiles(files),
    ...describeUnverifiedFiles(files),
    "## Safety boundary",
    "",
    "- Extracted document text was not persisted.",
    "- Generated summaries were rescanned before inclusion.",
    "- Raw credential files and unresolved secret material are not provided as project context.",
    "- Do not assume missing files are safe to retrieve from another location.",
    "",
    "## Completing the task",
    "",
    "Make changes only inside this Prepared Workspace.",
    "Yuhi does not apply agent changes to the Original Workspace automatically.",
    "When finished, tell the user to run `Yuhi: Review Agent Changes` before applying anything.",
    "",
  ].join("\n");
  // Guaranteed-clean fallback handoff: identical guidance but WITHOUT the per-file
  // listings (which carry the ID-like filenames that can trip the self-rescan). Only
  // counts appear, so it never contains an identifier.
  const listingFreeHandoff = [
    "# Yuhi Agent Handoff",
    "",
    "This handoff was generated locally by Yuhi for the AI agent working in this Prepared Workspace.",
    "",
    "## Start here",
    "",
    "1. Read `.yuhi/context/document-index.md` first — Yuhi's index of prepared document context.",
    "2. Work only with files available in this Prepared Workspace.",
    "3. If information is missing, tell the user what is missing. Do not search outside the workspace.",
    "",
    "## Preparation status",
    "",
    `- Launch status: ${launchAllowed ? "Ready" : "Not ready"}`,
    `- Project files available: ${availableProjectFiles}`,
    `- Files transformed locally: ${transformedProjectFiles}`,
    `- Files not included: ${localOnlyProjectFiles}`,
    `- Estimated context reduction: ${estimatedContextReduction === null ? "Not measured" : `${estimatedContextReduction.toFixed(1)}%`}`,
    `- Estimated tokens: ${publicSummary.originalEstimatedTokens ?? "Not measured"} before → ${publicSummary.preparedEstimatedTokens ?? "Not measured"} after`,
    "",
    "Some files could not be fully verified or were kept local. Their names are omitted",
    "here for safety — open “Review file decisions” in Yuhi for the full list.",
    "",
    "## Safety boundary",
    "",
    "- Extracted document text was not persisted.",
    "- Raw credential files and unresolved secret material are not provided as project context.",
    "- Do not assume missing files are safe to retrieve from another location.",
    "",
  ].join("\n");
  const handoffScan = {
    entropyThreshold: plan.context.config.scan.entropy_threshold,
    keywords: plan.context.config.scan.keywords,
    relpath: ".yuhi/context/AGENT_HANDOFF.md",
  };
  // Yuhi's OWN generated handoff must NEVER fail the whole preparation (never stop).
  // A finding here is almost always a false positive from a listed filename that
  // resembles an ID/phone (e.g. a 10-digit student number). Sanitize and write the
  // handoff instead of aborting a completed run. Escalating fallbacks guarantee the
  // written file is clean:
  //   1. redact detector/entropy spans + mask long digit runs (structured IDs/phones);
  //   2. if anything still trips the scan, drop the per-file listings entirely and
  //      keep only the static, listing-free handoff (counts, not names).
  let safeHandoff = agentHandoff;
  if (runDetectors(agentHandoff, handoffScan).length > 0) {
    const masked = redactText(agentHandoff, handoffScan).redacted.replace(
      /\d{7,}/g,
      "«REDACTED:number»",
    );
    safeHandoff =
      runDetectors(masked, handoffScan).length === 0 ? masked : listingFreeHandoff;
    progress("Agent handoff: sanitized ID-like content from generated listings; handoff still written.");
  }
  await writeMirrored(outDir, ".yuhi/context/AGENT_HANDOFF.md", publicSurface(safeHandoff));

  // Degraded-completion summary for the local-model reliability fix. Present when the
  // inline model timed out / was disabled, so the CLI / VS Code reach "Ready … with
  // warnings" instead of hanging. Public-safe: relpaths only, no absolute paths/content.
  const localModelTimeouts = degradedWarnings.filter(
    (warning) => warning.reason === "local-summary-timeout",
  ).length;
  const degraded =
    degradedWarnings.length > 0 || localModelDisabled
      ? {
          localModelDisabled,
          filesKeptLocalAfterTimeout,
          localModelTimeouts,
          ...(circuitBreakerReason ? { circuitBreakerReason } : {}),
          warnings: degradedWarnings,
        }
      : undefined;

  // Deterministic, agent-independent Context ID (v0.3.4). Derived from the SAME
  // inputs the pipeline already computed — SOURCE file relpaths + content hashes
  // (from the scan; no re-scan), the resolved safety mode, the policy hash, the
  // compression toggle, the token budget, and the reduction settings. It excludes
  // time, randomness (runId), user/machine, absolute paths, and the agent id.
  const manifestSchemaVersion = 2;
  const contextIdSourceFiles: ContextIdSourceFile[] = plan.scan.files.map((file) => ({
    relpath: file.relpath,
    sha256: file.sha256 ?? null,
    size: file.size,
  }));
  const contextId = computeContextId({
    yuhiVersion: YUHI_VERSION,
    manifestSchemaVersion,
    sourceFiles: contextIdSourceFiles,
    safetyMode,
    policyHash: plan.context.policyHash,
    compression: options.compress === true,
    tokenBudget: options.tokenBudget ?? null,
    reductionMode: effectiveMode,
    compressionThresholdTokens: options.compressionThresholdTokens ?? null,
  });

  // The run's alias registry (name/email/… pseudonym tokens minted while transforming
  // tabular files above) MUST be durable BEFORE any item becomes visible in the
  // persistent background queue below — `runBackgroundForRun` is always a LATER,
  // separate process (a resumed CLI session, a fresh VS Code extension host) that can
  // start draining the queue as soon as an item is enqueued, and without the registry
  // a document companion cannot reuse the SAME `PERSON-001` token a CSV in this run
  // already minted (0.4.7, `docs/design/0.4.7_document_privacy.md`). Best-effort and
  // private-only, same posture as `writePrivateRunSourceBinding` below: a write
  // failure never blocks or delays Yuhi Mode, and `runBackgroundForRun` safely falls
  // back to an empty registry if this is absent (documents are still fully masked and
  // independently verified either way — see `alias-registry-store.ts`'s doc comment).
  if (backgroundEnqueue.length > 0) {
    await writePrivateAliasRegistry(managedBase, runId, studentAliases).catch(() => {});
  }

  // ===== v0.3.5 FOREGROUND → BACKGROUND QUEUE REGISTRATION =====
  // Persist each deferred item into the run's PRIVATE queue (under the managed base,
  // NOT the agent-visible prepared root) so the heavy work (summarize-local / document
  // extraction / OCR) runs AFTER Yuhi Mode has launched. The foreground made ZERO
  // heavy-processor calls; this is only durable JSON book-keeping. A file's status
  // becomes `background-processing-pending` ONLY after its enqueue succeeds — an enqueue
  // failure leaves it kept-local (never mislabeled), and its original stays local-only.
  if (backgroundEnqueue.length > 0) {
    try {
      // Private state lives OUTSIDE every agent-visible root; the agent never sees the
      // queue records (which carry absolute source paths). `managedBase` contains all
      // run dirs, so `<managedBase>/.internal/background/<runId>` is not a prepared root.
      const queue = await BackgroundQueue.open(privateBackgroundDir(managedBase, runId));
      for (const pending of backgroundEnqueue) {
        try {
          await queue.enqueue({
            runId,
            contextId,
            relpath: pending.relpath,
            // The public half of the boundary: an agent-facing path ONLY when the
            // original was actually delivered (Balanced's include-with-warning). The
            // public status and any published companion use this, never `relpath`.
            ...(pending.entry.omitted !== true ? { publicRelpath: pending.entry.relpath } : {}),
            ...(pending.entry.documentId ? { documentId: pending.entry.documentId } : {}),
            kind: pending.kind,
            sourceArtifactPath: pending.sourceArtifactPath,
            sourceContentHash: pending.sourceContentHash,
            processorVersion: pending.processorVersion,
            policyHash: plan.context.policyHash,
            originalSharedWithWarning: pending.originalSharedWithWarning,
          });
          // Pending is asserted ONLY on a durable enqueue success.
          pending.entry.outcome = "background-processing-pending";
        } catch {
          // Enqueue failed for this item → keep it local-only; do not mislabel it.
        }
      }
      // Seed the PUBLIC, path-safe status file the agent/CLI/UI reads (all pending).
      // Contains only counts + safe per-item fields — never an absolute/staging path.
      await writePublicStatus(outDir, buildPublicStatus(queue.list(runId))).catch(() => {});
    } catch {
      // The queue could not be opened → every deferred file stays kept-local. The run
      // still launches; nothing is delivered un-inspected.
    }
  }

  // Queue registration changes local-only candidates into the distinct durable
  // background-pending state. Recompute the ONE shared summary only after that state is
  // final, then replace the handoff with a compact count-only version. Pending is never
  // reported as excluded and no individual filename enters agent instructions.
  refreshPublicAvailability(files);
  publicSummary = buildPublicPreparedContextSummary({
    files,
    ...(compressionReport ? { compression: compressionReport } : {}),
    reduction: report,
    originalWorkspaceModified: originalSourceFilesModified > 0,
    secretsExposed: unresolvedCredential ? 1 : 0,
  });
  const initialIndexText = await readFile(path.join(outDir, ".yuhi/context/document-index.md"), "utf8")
    .catch(() => "");
  const compactEntries = files.filter((file) => file.contextRepresentation === "compressed");
  const largeCompactEntries = compactEntries.filter((file) => /\.(?:html?|json|csv|tsv|log)$/i.test(file.relpath));
  const largeArtifactReduction = largeCompactEntries.reduce(
    (sum, file) => sum + Math.max(0, (file.originalTokens ?? 0) - (file.preparedTokens ?? 0)),
    0,
  );
  const structuralReduction = compactEntries.reduce(
    (sum, file) => sum + Math.max(0, (file.originalTokens ?? 0) - (file.preparedTokens ?? 0)),
    0,
  ) - largeArtifactReduction;
  let yuhiModeSummary = buildYuhiModeSummary({
    files,
    prepared: publicSummary,
    launchAllowed,
    compressionMode: options.compressionMode ?? (options.compress === true ? "auto" : "off"),
    initialAgentContextTokens: tokenEstimate(initialIndexText).tokens,
    largeArtifactsRepresented: largeCompactEntries.length,
    reductionByStructuralCompression: Math.max(0, structuralReduction),
    reductionByLargeArtifactRepresentation: largeArtifactReduction,
    delivery: {
      rawFallbackFiles: deliveryIntegrity.rawFallbackFiles,
      identifierResidueFiles: deliveryIntegrity.identifierResidueFiles,
    },
  });
  let finalHandoff = renderYuhiModeHandoff(yuhiModeSummary);
  yuhiModeSummary = buildYuhiModeSummary({
    files,
    prepared: publicSummary,
    launchAllowed,
    compressionMode: yuhiModeSummary.contextEfficiency.compressionMode,
    initialAgentContextTokens: tokenEstimate(initialIndexText + finalHandoff).tokens,
    largeArtifactsRepresented: largeCompactEntries.length,
    reductionByStructuralCompression: Math.max(0, structuralReduction),
    reductionByLargeArtifactRepresentation: largeArtifactReduction,
    delivery: {
      rawFallbackFiles: deliveryIntegrity.rawFallbackFiles,
      identifierResidueFiles: deliveryIntegrity.identifierResidueFiles,
    },
  });
  finalHandoff = renderYuhiModeHandoff(yuhiModeSummary);
  await writeMirrored(outDir, ".yuhi/context/AGENT_HANDOFF.md", publicSurface(finalHandoff));
  await writeMirrored(
    outDir,
    ".yuhi/yuhi-mode-summary.json",
    publicSurface(JSON.stringify(yuhiModeSummary, null, 2) + "\n"),
  );

  const manifest = {
    schemaVersion: manifestSchemaVersion,
    // Deterministic Context ID — the agent-independent identity of this prepared
    // context. Emitted into the Context Manifest so any agent adapter can attach a
    // per-run Agent Session to it (see @yuhi/agents session manifest).
    contextId,
    ...(createdAt !== undefined ? { createdAt } : {}),
    runId,
    reductionMode: effectiveMode,
    // The RESOLVED effective Safety Mode this run was prepared with (not the raw input).
    // Consumed by freshness checks: selecting a different mode makes the run stale.
    safetyMode,
    ...(compressionReport ? { compression: compressionReport } : {}),
    publicSummary,
    yuhiModeSummary,
    files: files.map((f) => {
      // Decisions are keyed by the ORIGINAL path; a pseudonymized entry must look up
      // its decision by originalRelpath, not the Claude-facing name.
      const lookupPath = f.originalRelpath ?? f.relpath;
      const decision = plan.evaluation.decisions.find((d) => d.relpath === lookupPath);
      return {
        // METADATA BOUNDARY: `manifest.json` sits INSIDE the prepared workspace, so it
        // is agent-visible. A delivered file keeps the (already de-identified) name the
        // agent can see anyway; a WITHHELD file is reduced to its identity plus a
        // kind-only label, and `originalRelpath` — the private pseudonym mapping — is
        // never written here at all.
        relpath: publicEntryName(f),
        documentId: f.documentId ?? documentIdFor(lookupPath, salt),
        ...(f.omitted ? { displayName: publicEntryName(f) } : {}),
        action: f.action,
        status: f.status,
        outcome: f.outcome,
        ...(f.failureCategory ? { failureCategory: f.failureCategory } : {}),
        ...(f.error ? { reason: f.error } : {}),
        transmission: f.transmission,
        beforeChars: f.beforeChars,
        afterChars: f.afterChars,
        ...(f.omitted ? { omitted: true } : {}),
        ...(f.inspection ? { inspection: f.inspection } : {}),
        ...(f.limitation ? { limitation: f.limitation } : {}),
        ...(f.error !== undefined ? { error: f.error } : {}),
        ...(f.transformations !== undefined ? { transformations: f.transformations } : {}),
        ...(f.maskedValues !== undefined ? { maskedValues: f.maskedValues } : {}),
        ...(f.transformed !== undefined ? { transformed: f.transformed } : {}),
        ...(f.rawFallback !== undefined ? { rawFallback: f.rawFallback } : {}),
        ...(f.duplicateOfFamily ? { duplicateOfFamily: f.duplicateOfFamily } : {}),
        ...(f.canonicalRelpath ? { canonicalRelpath: f.canonicalRelpath } : {}),
        ...(f.canonicalDocumentId ? { canonicalDocumentId: f.canonicalDocumentId } : {}),
        ...(f.postTransformScan !== undefined ? { postTransformScan: f.postTransformScan } : {}),
        ...(f.finalRescanVerified !== undefined
          ? { finalRescanVerified: f.finalRescanVerified }
          : {}),
        ...(f.availabilityStatus ? { availabilityStatus: f.availabilityStatus } : {}),
        ...(f.inspectionStatus ? { inspectionStatus: f.inspectionStatus } : {}),
        ...(f.backgroundStatus ? { backgroundStatus: f.backgroundStatus } : {}),
        ...(f.originalShared !== undefined ? { originalShared: f.originalShared } : {}),
        ...(f.warningCode ? { warningCode: f.warningCode } : {}),
        ...(f.knownFindingsPresent !== undefined
          ? { knownFindingsPresent: f.knownFindingsPresent }
          : {}),
        ...(f.contextRepresentation ? { contextRepresentation: f.contextRepresentation } : {}),
        ...(f.compressionReason ? { compressionReason: f.compressionReason } : {}),
        ...(f.originalTokens !== undefined ? { originalTokens: f.originalTokens } : {}),
        ...(f.preparedTokens !== undefined ? { preparedTokens: f.preparedTokens } : {}),
        ...(f.document ? { document: f.document } : {}),
        ...(decision !== undefined
          ? (() => {
              const findingCategoryCounts: Record<string, number> = {};
              const findingSeverityCounts: Record<string, number> = {};
              for (const finding of decision.findings) {
                const category = findingCategory(finding.detector);
                findingCategoryCounts[category] = (findingCategoryCounts[category] ?? 0) + 1;
                findingSeverityCounts[finding.severity] =
                  (findingSeverityCounts[finding.severity] ?? 0) + 1;
              }
              return {
                ruleName: decision.ruleName,
                reason: decision.reason,
                findingCategoryCounts,
                findingSeverityCounts,
                unresolvedHighRiskCount:
                  f.status === "ok" && !f.omitted && f.action === "allow"
                    ? decision.findings.filter(
                        (finding) => finding.severity === "high" || finding.severity === "critical",
                      ).length
                    : 0,
              };
            })()
          : {}),
      };
    }),
    reduction: report,
    filenamesPseudonymized,
    // NOTE: `provenance` below is projected the same way — `source` (the raw original
    // path) is the private half of the mapping and is dropped, not published.
    finalRescan: {
      identifierLeaks: finalIdentifierLeaks,
      credentialKeptLocal: finalCredentialKeptLocal,
      verified: files.filter((f) => f.finalRescanVerified === true).length,
    },
    provenance: provenance.map((record) => {
      const entry = files.find(
        (file) => file.relpath === record.relpath || file.originalRelpath === record.source,
      );
      return {
        relpath: entry ? publicEntryName(entry) : record.relpath,
        ...(entry?.documentId ? { documentId: entry.documentId } : {}),
        action: record.action,
      };
    }),
    sourceModified: originalSourceFilesModified,
    contentFamilies: {
      sourceBytes: contentFamilies.sourceBytes,
      uniqueContentBytes: contentFamilies.uniqueContentBytes,
      duplicateBytes: contentFamilies.duplicateBytes,
      canonicalDeliveredBytes: contentFamilies.canonicalDeliveredBytes,
      duplicateAliasBytes: contentFamilies.duplicateAliasBytes,
      families: contentFamilies.families,
    },
    status: launchAllowed ? "ready" : "blocked",
    launchAllowed,
    ...(!launchAllowed ? { blockedReason } : {}),
    tabularAcceptance: {
      entitiesPseudonymized: studentAliases.nextEntity - 1,
      identifierColumnsTransformed,
      analyticalColumnsPreserved,
      postTransformScanPassed:
        deliveryIntegrity.postTransformScanFailed === 0 &&
        transformedSensitiveTables > 0 &&
        malformedTables === 0 &&
        unverifiedTransformations === 0,
      malformedTables,
      unverifiedTransformations,
      rawFallbackUsed,
      deliveryIntegrity,
      launchAllowed,
      claudeCodeStarted: false,
      unsupportedOrUnverifiedFiles,
      restrictedUnresolvedFiles,
      hasLimitations:
        unsupportedOrUnverifiedFiles > 0 ||
        unverifiedTransformations > 0 ||
        filesKeptLocalAfterTimeout > 0 ||
        plan.evaluation.decisions.some(
          (decision) => decision.ruleName === "document:personal-information-warning",
        ),
      pdfInspected: plan.scan.files.filter(
        (file) =>
          file.documentInspection?.status === "inspected" &&
          file.documentInspection.extractionMethod === "pdf-text",
      ).length,
      ocrProcessed: plan.scan.files.filter(
        (file) =>
          file.documentInspection?.status === "inspected" &&
          file.documentInspection.extractionMethod === "ocr",
      ).length,
      unverifiedDocuments: plan.scan.files.filter(
        (file) =>
          file.documentInspection !== undefined &&
          file.documentInspection.status !== "inspected",
      ).length,
      documentSummariesCreated,
      documentSummariesRejected,
      documentContextBeforeTokens,
      documentContextAfterTokens,
      textDocumentsInspected,
      agentHandoffCreated: true,
      ...(baseProvider
        ? {
            localModelProvider: baseProvider.id,
            localModelName: baseProvider.defaultModel,
            localModelRequests,
            localModelSucceeded,
            localModelFailed,
            localModelInputChars,
            localModelOutputChars,
            localModelElapsedMs,
            localModelMaxConcurrency,
            localModelConfiguredParallelism: localModelParallelism,
          }
        : {}),
    },
    warnings: {
      unverifiedFilesIncluded: files.filter(
        (file) => file.outcome === "included-unverified" && !file.omitted,
      ).length,
    },
    // Local-model reliability degradation (relpaths only — never absolute paths /
    // content). Present only when the inline model timed out / was disabled, so the
    // manifest of a normal run is byte-for-byte unchanged.
    ...(degraded ? { degraded } : {}),
    security: {
      transformedFiles: files.filter(
        (file) => file.status === "ok" && !file.omitted && file.transformed,
      ).length,
      credentialsRemoved: files.some((file) => {
        const decision = plan.evaluation.decisions.find(
          (candidate) => candidate.relpath === file.relpath,
        );
        return (
          file.status === "ok" &&
          !file.omitted &&
          (decision?.ruleName === "yuhi:environment-sanitized-copy" ||
            decision?.ruleName === "yuhi:credential-sanitized-copy")
        );
      }),
    },
    documentInspection: {
      pdfInspected: plan.scan.files.filter(
        (file) =>
          file.documentInspection?.status === "inspected" &&
          file.documentInspection.extractionMethod === "pdf-text",
      ).length,
      ocrProcessed: plan.scan.files.filter(
        (file) =>
          file.documentInspection?.status === "inspected" &&
          file.documentInspection.extractionMethod === "ocr",
      ).length,
      unverifiedDocuments: plan.scan.files.filter(
        (file) =>
          file.documentInspection !== undefined &&
          file.documentInspection.status !== "inspected",
      ).length,
      summariesCreated: documentSummariesCreated,
      summariesRejected: documentSummariesRejected,
      estimatedContextBeforeTokens: documentContextBeforeTokens,
      estimatedContextAfterTokens: documentContextAfterTokens,
      textDocumentsInspected,
      agentHandoffCreated: true,
      ...(baseProvider
        ? {
            localModelProvider: baseProvider.id,
            localModelName: baseProvider.defaultModel,
            localModelRequests,
            localModelSucceeded,
            localModelFailed,
            localModelInputChars,
            localModelOutputChars,
            localModelElapsedMs,
            localModelMaxConcurrency,
            localModelConfiguredParallelism: localModelParallelism,
          }
        : {}),
    },
  };
  // Structural projection above is the primary control; the boundary pass is the
  // backstop that also covers free-text fields (a policy `reason`, an error note).
  await writeFile(
    path.join(outDir, "manifest.json"),
    JSON.stringify(publicSurface(manifest), null, 2) + "\n",
    "utf8",
  );
  // Patch/source mapping is private operational state. It must never be written to
  // manifest/session/public status or anywhere below the agent-visible workspace.
  // Failure never delays Yuhi Mode startup; the agent-launch gate will fail closed
  // with a metadata-safe snapshot-unavailable error if the binding is absent.
  await writePrivateRunSourceBinding(managedBase, runId, root).catch(() => {});
  progress(`Prepared safe copies · ${provenance.length} files`);

  return {
    runId,
    contextId,
    outDir,
    report,
    files,
    blocked: files.filter((f) => f.status === "blocked"),
    errors: files.filter((f) => f.status === "error"),
    decisions: plan.evaluation.decisions,
    sourceModified: originalSourceFilesModified,
    safetyMode,
    ...(degraded ? { degraded } : {}),
    ...(compressionReport ? { compression: compressionReport } : {}),
    publicSummary,
    yuhiModeSummary,
    contentFamilies,
    tabularAcceptance: {
      entitiesPseudonymized: studentAliases.nextEntity - 1,
      identifierColumnsTransformed,
      analyticalColumnsPreserved,
      postTransformScanPassed:
        deliveryIntegrity.postTransformScanFailed === 0 &&
        transformedSensitiveTables > 0 &&
        malformedTables === 0 &&
        unverifiedTransformations === 0,
      malformedTables,
      unverifiedTransformations,
      rawFallbackUsed,
      deliveryIntegrity,
      launchAllowed,
      claudeCodeStarted: false,
      unsupportedOrUnverifiedFiles,
      restrictedUnresolvedFiles,
      hasLimitations:
        unsupportedOrUnverifiedFiles > 0 ||
        unverifiedTransformations > 0 ||
        filesKeptLocalAfterTimeout > 0 ||
        plan.evaluation.decisions.some(
          (decision) => decision.ruleName === "document:personal-information-warning",
        ),
      pdfInspected: plan.scan.files.filter(
        (file) =>
          file.documentInspection?.status === "inspected" &&
          file.documentInspection.extractionMethod === "pdf-text",
      ).length,
      ocrProcessed: plan.scan.files.filter(
        (file) =>
          file.documentInspection?.status === "inspected" &&
          file.documentInspection.extractionMethod === "ocr",
      ).length,
      unverifiedDocuments: plan.scan.files.filter(
        (file) =>
          file.documentInspection !== undefined &&
          file.documentInspection.status !== "inspected",
      ).length,
      documentSummariesCreated,
      documentSummariesRejected,
      documentContextBeforeTokens,
      documentContextAfterTokens,
      textDocumentsInspected,
      agentHandoffCreated: true,
      ...(baseProvider
        ? {
            localModelProvider: baseProvider.id,
            localModelName: baseProvider.defaultModel,
            localModelRequests,
            localModelSucceeded,
            localModelFailed,
            localModelInputChars,
            localModelOutputChars,
            localModelElapsedMs,
            localModelMaxConcurrency,
            localModelConfiguredParallelism: localModelParallelism,
          }
        : {}),
    },
  };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      await rm(outDir, { recursive: true, force: true });
      progress("Yuhi preparation cancelled");
    }
    throw error;
  }
}

/** Converts intentional cancellation into a typed, non-launchable result. */
export async function prepareWorkspaceOutcome(
  dir: string,
  options: PrepareWorkspaceOptions = {},
): Promise<PrepareWorkspaceOutcome> {
  try {
    const report = await prepareWorkspace(dir, options);
    return {
      kind: "success",
      report,
      launchAllowed: report.tabularAcceptance?.launchAllowed ?? false,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { kind: "cancelled", launchAllowed: false };
    }
    throw error;
  }
}

/** Write `content` under `outDir`, mirroring a repo-relative POSIX relpath. */
async function writeMirrored(outDir: string, relpath: string, content: string | Buffer): Promise<void> {
  const abs = path.join(outDir, ...relpath.split("/"));
  await mkdir(path.dirname(abs), { recursive: true });
  if (typeof content === "string") await writeFile(abs, content, "utf8");
  else await writeFile(abs, content);
}

async function copyMirrored(outDir: string, relpath: string, absPath: string): Promise<void> {
  const abs = path.join(outDir, ...relpath.split("/"));
  await mkdir(path.dirname(abs), { recursive: true });
  // OS-level copy — streams on the filesystem, never buffering the file in JS memory.
  await copyFile(absPath, abs);
}

async function renameMirrored(outDir: string, fromRel: string, toRel: string): Promise<void> {
  const fromAbs = path.join(outDir, ...fromRel.split("/"));
  const toAbs = path.join(outDir, ...toRel.split("/"));
  await mkdir(path.dirname(toAbs), { recursive: true });
  await rename(fromAbs, toAbs);
}
