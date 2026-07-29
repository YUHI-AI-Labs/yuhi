import { lstat, mkdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { homedir, platform } from "node:os";
import path from "node:path";
import {
  processorId,
  createStudentAliasContext,
  classifyStudentRecordTable,
  parseDelimitedTable,
  tabularDirectIdentifierValues,
  tokenEstimate,
  reductionReport,
  type Action,
  type LocalModelProvider,
  type ReductionMode,
  type ReductionReport,
  type ProcessorSpec,
  type TransmissionState,
  type FileDecision,
  type FileInfo,
} from "@yuhi/shared";
import { runDetectors } from "@yuhi/scanner";
import type { YuhiConfig } from "@yuhi/config";
import { computePlan } from "./plan.js";
import { runLocalPreparation } from "./route-executor.js";

/** The pipeline every summarize target is run through (local model → mask → gate). */
const PREPARE_PIPELINE: ProcessorSpec[] = ["summarize-local", "pseudonymize", "safety-check"];

/** One prepared (or skipped) file, as recorded in the manifest and the report. */
export interface PreparedFileEntry {
  /** Repo-relative POSIX path (mirrored in the prepared output tree). */
  relpath: string;
  /** The policy action that routed this file. */
  action: Action;
  /** Preparation outcome; "skipped" for verbatim/omitted files that weren't run. */
  status: "ok" | "blocked" | "error" | "skipped";
  outcome?:
    | "included-unchanged"
    | "included-transformed"
    | "excluded-by-user"
    | "excluded-by-policy"
    | "local-only-unverified"
    | "local-only-unsupported"
    | "local-only-transformation-failed"
    | "blocked-high-risk"
    | "malformed"
    | "failed";
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
  };
  limitation?:
    | "inspection-unavailable"
    | "inspection-incomplete"
    | "transformation-unavailable"
    | "verification-failed";
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
  /** Privacy-safe tabular acceptance metadata shared by CLI and VS Code. */
  tabularAcceptance?: {
    entitiesPseudonymized: number;
    identifierColumnsTransformed: number;
    analyticalColumnsPreserved: number;
    postTransformScanPassed: boolean;
    malformedTables: number;
    unverifiedTransformations: number;
    rawFallbackUsed: false;
    launchAllowed: boolean;
    claudeCodeStarted: false;
    unsupportedOrUnverifiedFiles?: number;
    restrictedUnresolvedFiles?: number;
    hasLimitations?: boolean;
  };
}

export interface PrepareWorkspaceOptions {
  /** Local model provider used for the summarize-local step. */
  provider?: LocalModelProvider;
  /** Loaded config (currently informational; budget.reduction_mode is a mode fallback). */
  config?: YuhiConfig;
  /** Reduction aggressiveness; falls back to config.budget.reduction_mode, else "balanced". */
  mode?: ReductionMode;
  /** Cancellation. */
  signal?: AbortSignal;
  /** Optional UI progress callback (safe-to-show messages only). */
  onProgress?: (msg: string) => void;
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
}

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

function assertSameIntegrity(
  before: Map<string, SourceIntegrityEntry>,
  after: Map<string, SourceIntegrityEntry>,
): void {
  if (before.size !== after.size) throw new Error(SOURCE_INTEGRITY_ERROR);
  for (const [relpath, expected] of before) {
    const actual = after.get(relpath);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(SOURCE_INTEGRITY_ERROR);
    }
  }
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
  const { provider, config, mode, signal, onProgress, createdAt, agent } = options;

  const startedAt = Date.now();
  const progress = (stage: string): void => {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    onProgress?.(`${stage} · ${elapsedSeconds}s`);
  };
  progress("Discovering files");
  const plan = await computePlan(dir, {
    ...(agent !== undefined ? { agent } : {}),
    interactive: false,
  });
  const root = plan.context.root;
  const salt = plan.context.policyHash;
  const effectiveMode: ReductionMode =
    mode ?? config?.budget?.reduction_mode ?? plan.context.config.budget?.reduction_mode ?? "balanced";

  const runId = randomUUID();
  const managedBase = path.resolve(options.managedWorkspaceBase ?? managedWorkspaceBaseDir());
  const outDir = path.join(managedBase, runId);
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  try {
  const infoByPath = new Map<string, FileInfo>(plan.scan.files.map((f) => [f.relpath, f]));
  const sourceIntegrityBefore = await captureSourceIntegrity(root, plan.scan.files, {
    ...(signal !== undefined ? { signal } : {}),
    phase: "before",
    ...(onProgress !== undefined
      ? {
          onProgress: (message) => {
            const count = message.match(/before (\d+\/\d+)/)?.[1];
            progress(`Scanning sensitive information${count ? ` · ${count} files` : ""}`);
          },
        }
      : {}),
  });
  progress(`Scanning sensitive information · ${plan.scan.files.length} files`);
  progress(`Preparing safe copies · 0/${plan.evaluation.decisions.length} files`);

  const files: PreparedFileEntry[] = [];
  const provenance: ProvenanceEntry[] = [];
  let beforeTokens = 0;
  let afterTokens = 0;
  let approx = false;
  let filesSummarized = 0;
  let filesExcluded = 0;
  let sensitiveMasked = 0;
  const studentAliases = createStudentAliasContext();
  const explicitExclusions = new Set(options.excludeRelpaths ?? []);
  let identifierColumnsTransformed = 0;
  let analyticalColumnsPreserved = 0;
  let transformedSensitiveTables = 0;
  let malformedTables = 0;
  let unverifiedTransformations = 0;
  let unsupportedOrUnverifiedFiles = 0;
  let restrictedUnresolvedFiles = 0;

  let decisionsProcessed = 0;
  for (const decision of plan.evaluation.decisions) {
    if (signal?.aborted) throw new DOMException("prepareWorkspace aborted", "AbortError");

    const info = infoByPath.get(decision.relpath);
    const relpath = decision.relpath;

    if (explicitExclusions.has(relpath)) {
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
      continue;
    }

    const unverifiedInspection = !!info && !info.inspection.contentVerified;
    const unsupportedInspection = unverifiedInspection && !info.inspection.parserAvailable;
    const unsupportedHighRisk = unverifiedInspection && decision.findings.some(
      (finding) => finding.severity === "high" || finding.severity === "critical",
    );
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

    const content = await readFile(info.absPath, "utf8");

    if (isSummarizeTarget(decision) || isRedactTarget(decision)) {
      progress(`Preparing safe copies · ${decisionsProcessed}/${plan.evaluation.decisions.length} files`);
      const pipeline =
        decision.processors && decision.processors.length > 0
          ? decision.processors
          : isRedactTarget(decision)
            ? (["pseudonymize", "safety-check"] satisfies ProcessorSpec[])
            : PREPARE_PIPELINE;
      const prep = await runLocalPreparation(content, pipeline, {
        ...(provider !== undefined ? { provider } : {}),
        salt,
        mode: effectiveMode,
        studentAliases,
        ...(signal !== undefined ? { signal } : {}),
      });

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
        let transformedSafe = true;
        try {
          const inputTable = parseDelimitedTable(content);
          const outputTable = parseDelimitedTable(prep.output);
          const pseudonymizedTable = prep.audits.some(
            (audit) => audit.processorId === "pseudonymize-student-records",
          );
          if (pseudonymizedTable) {
            const inputClassification = classifyStudentRecordTable(inputTable.rows);
            const directIndexes = new Set(inputClassification.directIdentifierIndexes);
            const rawIdentifiers = new Set(tabularDirectIdentifierValues(content));
            const outputDirectValues = outputTable.rows.slice(1).flatMap((row) =>
              inputClassification.directIdentifierIndexes
                .map((index) => (row[index] ?? "").trim())
                .filter(Boolean),
            );
            const nonNumericIdentifiers = [...rawIdentifiers].filter(
              (value) => !/^[+-]?(?:\d+|\d*\.\d+)$/.test(value),
            );
            transformedSafe =
              transformedSafe &&
              outputTable.rows.length === inputTable.rows.length &&
              outputTable.rows.every((row) => row.length === inputTable.rows[0]!.length) &&
              outputDirectValues.every((value) => !rawIdentifiers.has(value)) &&
              nonNumericIdentifiers.every((value) =>
                !outputTable.rows.some((row) => row.some((cell) => cell.includes(value)))
              ) &&
              inputTable.rows.slice(1).every((row, rowIndex) =>
                row.every((value, columnIndex) =>
                  directIndexes.has(columnIndex) ||
                  outputTable.rows[rowIndex + 1]![columnIndex] === value
                )
              );
          }
          const outputClassification = classifyStudentRecordTable(outputTable.rows);
          if (pseudonymizedTable) {
            transformedSafe =
              transformedSafe &&
              outputClassification.directIdentifierColumns > 0;
          }
        } catch {
          const tabularTransformation = prep.audits.some(
            (audit) =>
              audit.processorId === "pseudonymize-student-records" ||
              audit.processorId === "aggregate-student-records",
          );
          if (tabularTransformation) transformedSafe = false;
        }
        const transformedFindings = runDetectors(prep.output, {
          entropyThreshold: plan.context.config.scan.entropy_threshold,
          keywords: plan.context.config.scan.keywords,
          relpath,
        });
        const unresolvedTransformedFindings = transformedFindings.filter(
          (finding) =>
            !finding.detector.startsWith("tabular-") &&
            (finding.severity === "high" || finding.severity === "critical"),
        );
        transformedSafe = transformedSafe && unresolvedTransformedFindings.length === 0;
        if (!transformedSafe) {
          entry.status = "error";
          entry.action = "local-only";
          entry.transmission = "blocked";
          entry.omitted = true;
          entry.error = "Transformed output failed Yuhi privacy rescan.";
          entry.outcome = "local-only-transformation-failed";
          entry.limitation = "verification-failed";
          unverifiedTransformations += 1;
          filesExcluded += 1;
          files.push(entry);
          decisionsProcessed += 1;
          continue;
        }
        await writeMirrored(outDir, relpath, prep.output);
        provenance.push({ relpath, source: relpath, action: decision.action });
        const before = tokenEstimate(content);
        const after = tokenEstimate(prep.output);
        beforeTokens += before.tokens;
        afterTokens += after.tokens;
        approx = approx || before.approx || after.approx;
        const summarized = prep.audits.some((audit) => audit.processorId === "summarize-local");
        const aggregated = prep.audits.some((audit) => audit.processorId === "aggregate-student-records");
        const pseudonymizedTable = prep.audits.some(
          (audit) => audit.processorId === "pseudonymize-student-records",
        );
        if (pseudonymizedTable) {
          const table = parseDelimitedTable(content);
          const classification = classifyStudentRecordTable(table.rows);
          identifierColumnsTransformed += classification.directIdentifierColumns;
          analyticalColumnsPreserved +=
            (table.rows[0]?.length ?? 0) - classification.directIdentifierColumns;
          transformedSensitiveTables += 1;
        }
        if (summarized) filesSummarized += 1;
        const masked = prep.audits
          .filter((a) => a.processorId === "pseudonymize" || a.processorId === "pseudonymize-student-records")
          .reduce((n, a) => n + a.itemsChanged, 0);
        entry.transformations = [
          ...(summarized ? (["summarized"] as const) : []),
          ...(aggregated ? (["aggregated"] as const) : []),
          ...(masked > 0 ? (["pseudonymized", "masked"] as const) : []),
        ];
        entry.maskedValues = masked;
        entry.transformed = prep.output !== content;
        if (masked > 0) sensitiveMasked += 1;
      } else {
        // Blocked or errored → never written to the prepared tree.
        entry.status = "error";
        entry.action = "local-only";
        entry.transmission = "blocked";
        entry.error ??= "Safe local transformation could not be verified.";
        entry.outcome = entry.error.startsWith("Malformed delimited table:")
          ? "malformed"
          : "local-only-transformation-failed";
        if (entry.error.startsWith("Malformed delimited table:")) malformedTables += 1;
        else unverifiedTransformations += 1;
        entry.omitted = true;
        filesExcluded += 1;
      }
      files.push(entry);
      decisionsProcessed += 1;
      if (decisionsProcessed % 25 === 0 || decisionsProcessed === plan.evaluation.decisions.length) {
        progress(`Preparing safe copies · ${decisionsProcessed}/${plan.evaluation.decisions.length} files`);
      }
      continue;
    }

    // `allow` (and any remaining sendable route): copy verbatim.
    await writeMirrored(outDir, relpath, content);
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
  await options.beforeIntegrityVerification?.();
  let sourceIntegrityAfter: Map<string, SourceIntegrityEntry>;
  try {
    const afterPlan = await computePlan(dir, {
      ...(agent !== undefined ? { agent } : {}),
      interactive: false,
    });
    sourceIntegrityAfter = await captureSourceIntegrity(root, afterPlan.scan.files, {
      ...(signal !== undefined ? { signal } : {}),
      phase: "after",
      ...(onProgress !== undefined
        ? {
            onProgress: (message) => {
              const count = message.match(/after (\d+\/\d+)/)?.[1];
              progress(`Verifying prepared output${count ? ` · ${count} files` : ""}`);
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(SOURCE_INTEGRITY_ERROR);
  }
  assertSameIntegrity(sourceIntegrityBefore, sourceIntegrityAfter);
  const originalSourceFilesModified = 0;
  progress(`Verifying prepared output · ${files.length}/${files.length} files`);
  const unresolvedHighRiskFindings = plan.evaluation.decisions.reduce((total, decision) => {
    const file = files.find((candidate) => candidate.relpath === decision.relpath);
    if (!file || file.status !== "ok" || file.omitted || file.action !== "allow") return total;
    return total + decision.findings.filter(
      (finding) => finding.severity === "high" || finding.severity === "critical",
    ).length;
  }, 0);
  const launchAllowed =
    files.every((file) => file.status !== "error") && unresolvedHighRiskFindings === 0;

  const manifest = {
    schemaVersion: 2,
    ...(createdAt !== undefined ? { createdAt } : {}),
    runId,
    reductionMode: effectiveMode,
    files: files.map((f) => {
      const decision = plan.evaluation.decisions.find((d) => d.relpath === f.relpath);
      return {
        relpath: f.relpath,
        action: f.action,
        status: f.status,
        outcome: f.outcome,
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
    provenance,
    sourceModified: originalSourceFilesModified,
    tabularAcceptance: {
      entitiesPseudonymized: studentAliases.nextEntity - 1,
      identifierColumnsTransformed,
      analyticalColumnsPreserved,
      postTransformScanPassed:
        transformedSensitiveTables > 0 && malformedTables === 0 && unverifiedTransformations === 0,
      malformedTables,
      unverifiedTransformations,
      rawFallbackUsed: false,
      launchAllowed,
      claudeCodeStarted: false,
      unsupportedOrUnverifiedFiles,
      restrictedUnresolvedFiles,
      hasLimitations: unsupportedOrUnverifiedFiles > 0,
    },
  };
  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  progress(`Prepared safe copies · ${provenance.length} files`);

  return {
    runId,
    outDir,
    report,
    files,
    blocked: files.filter((f) => f.status === "blocked"),
    errors: files.filter((f) => f.status === "error"),
    decisions: plan.evaluation.decisions,
    sourceModified: originalSourceFilesModified,
    tabularAcceptance: {
      entitiesPseudonymized: studentAliases.nextEntity - 1,
      identifierColumnsTransformed,
      analyticalColumnsPreserved,
      postTransformScanPassed:
        transformedSensitiveTables > 0 && malformedTables === 0 && unverifiedTransformations === 0,
      malformedTables,
      unverifiedTransformations,
      rawFallbackUsed: false,
      launchAllowed,
      claudeCodeStarted: false,
      unsupportedOrUnverifiedFiles,
      restrictedUnresolvedFiles,
      hasLimitations: unsupportedOrUnverifiedFiles > 0,
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

/** Write `content` under `outDir`, mirroring a repo-relative POSIX relpath. */
async function writeMirrored(outDir: string, relpath: string, content: string): Promise<void> {
  const abs = path.join(outDir, ...relpath.split("/"));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}
