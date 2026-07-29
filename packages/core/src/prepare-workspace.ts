import { lstat, mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  processorId,
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
  transmission: TransmissionState;
  beforeChars: number;
  afterChars: number;
  /** true when the file was intentionally left out of the prepared output. */
  omitted?: boolean;
  /** Non-sensitive error note when status === "error". */
  error?: string;
  /** Metadata-only transformation labels; never contains source content. */
  transformations?: ("summarized" | "pseudonymized" | "masked")[];
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

async function captureSourceIntegrity(
  root: string,
  files: FileInfo[],
): Promise<Map<string, SourceIntegrityEntry>> {
  try {
    const rootReal = await realpath(root);
    const snapshot = new Map<string, SourceIntegrityEntry>();
    for (const info of files) {
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
        continue;
      }
      if (!stat.isFile() || info.flags.isSymlink) throw new Error(SOURCE_INTEGRITY_ERROR);
      snapshot.set(relpath, {
        type: "file",
        device: stat.dev,
        inode: stat.ino,
        digest: sha256(await readFile(absPath)),
      });
    }
    return snapshot;
  } catch {
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

/**
 * Shared "prepare to disk" API used by both the CLI and the VS Code extension.
 *
 * Scans `dir`, routes each file via the policy, then for every summarize target runs
 * the LOCAL preparation pipeline (summarize-local → pseudonymize → safety-check).
 * `allow` files are copied verbatim; excluded routes (keep-local / exclude / runtime-only
 * / metadata-only / ask) and binary/symlink files are omitted. Nothing is ever sent to a
 * cloud service and SOURCE FILES ARE NEVER MODIFIED — output is written only under
 * <dir>/.yuhi/prepared/<runId>/.
 */
export async function prepareWorkspace(
  dir: string,
  options: PrepareWorkspaceOptions = {},
): Promise<PrepareReport> {
  const { provider, config, mode, signal, onProgress, createdAt, agent } = options;

  const plan = await computePlan(dir, {
    ...(agent !== undefined ? { agent } : {}),
    interactive: false,
  });
  const root = plan.context.root;
  const salt = plan.context.policyHash;
  const effectiveMode: ReductionMode =
    mode ?? config?.budget?.reduction_mode ?? plan.context.config.budget?.reduction_mode ?? "balanced";

  const runId = randomUUID();
  const outDir = path.join(root, ".yuhi", "prepared", runId);
  await mkdir(outDir, { recursive: true });
  onProgress?.(`Preparing locally into ${path.join(".yuhi", "prepared", runId)} (${effectiveMode})`);

  const infoByPath = new Map<string, FileInfo>(plan.scan.files.map((f) => [f.relpath, f]));
  const sourceIntegrityBefore = await captureSourceIntegrity(root, plan.scan.files);

  const files: PreparedFileEntry[] = [];
  const provenance: ProvenanceEntry[] = [];
  let beforeTokens = 0;
  let afterTokens = 0;
  let approx = false;
  let filesSummarized = 0;
  let filesExcluded = 0;
  let sensitiveMasked = 0;

  for (const decision of plan.evaluation.decisions) {
    if (signal?.aborted) throw new DOMException("prepareWorkspace aborted", "AbortError");

    const info = infoByPath.get(decision.relpath);
    const relpath = decision.relpath;

    // Omit binary/symlink/large-unreadable and excluded routes.
    const binaryOrSymlink = !!info && (info.flags.isBinary || info.flags.isSymlink);
    if (!info || binaryOrSymlink || isExcludedAction(decision.action)) {
      filesExcluded += 1;
      files.push({
        relpath,
        action: decision.action,
        status: "skipped",
        transmission: "blocked",
        beforeChars: info?.size ?? 0,
        afterChars: 0,
        omitted: true,
      });
      continue;
    }

    const content = await readFile(info.absPath, "utf8");

    if (isSummarizeTarget(decision)) {
      onProgress?.(`Prepare locally: ${relpath}`);
      const prep = await runLocalPreparation(content, PREPARE_PIPELINE, {
        ...(provider !== undefined ? { provider } : {}),
        salt,
        mode: effectiveMode,
        ...(signal !== undefined ? { signal } : {}),
      });

      const entry: PreparedFileEntry = {
        relpath,
        action: decision.action,
        status: prep.status,
        transmission: prep.transmission,
        beforeChars: prep.reduction.beforeChars,
        afterChars: prep.reduction.afterChars,
        ...(prep.error !== undefined ? { error: prep.error } : {}),
      };

      if (prep.status === "ok" && prep.transmission === "approved") {
        await writeMirrored(outDir, relpath, prep.output);
        provenance.push({ relpath, source: relpath, action: decision.action });
        const before = tokenEstimate(content);
        const after = tokenEstimate(prep.output);
        beforeTokens += before.tokens;
        afterTokens += after.tokens;
        approx = approx || before.approx || after.approx;
        filesSummarized += 1;
        const masked = prep.audits
          .filter((a) => a.processorId === "pseudonymize")
          .reduce((n, a) => n + a.itemsChanged, 0);
        entry.transformations = [
          "summarized",
          ...(masked > 0 ? (["pseudonymized", "masked"] as const) : []),
        ];
        entry.maskedValues = masked;
        entry.transformed = prep.output !== content;
        if (masked > 0) sensitiveMasked += 1;
      } else {
        // Blocked or errored → never written to the prepared tree.
        entry.omitted = true;
        filesExcluded += 1;
      }
      files.push(entry);
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
      transmission: "approved",
      beforeChars: content.length,
      afterChars: content.length,
      transformed: false,
    });
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

  onProgress?.("Verifying source workspace integrity.");
  await options.beforeIntegrityVerification?.();
  let sourceIntegrityAfter: Map<string, SourceIntegrityEntry>;
  try {
    const afterPlan = await computePlan(dir, {
      ...(agent !== undefined ? { agent } : {}),
      interactive: false,
    });
    sourceIntegrityAfter = await captureSourceIntegrity(root, afterPlan.scan.files);
  } catch {
    throw new Error(SOURCE_INTEGRITY_ERROR);
  }
  assertSameIntegrity(sourceIntegrityBefore, sourceIntegrityAfter);
  const originalSourceFilesModified = 0;

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
        transmission: f.transmission,
        beforeChars: f.beforeChars,
        afterChars: f.afterChars,
        ...(f.omitted ? { omitted: true } : {}),
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
  };
  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  onProgress?.(`Prepared ${provenance.length} file(s); manifest written.`);

  return {
    runId,
    outDir,
    report,
    files,
    blocked: files.filter((f) => f.status === "blocked"),
    errors: files.filter((f) => f.status === "error"),
    decisions: plan.evaluation.decisions,
    sourceModified: originalSourceFilesModified,
  };
}

/** Write `content` under `outDir`, mirroring a repo-relative POSIX relpath. */
async function writeMirrored(outDir: string, relpath: string, content: string): Promise<void> {
  const abs = path.join(outDir, ...relpath.split("/"));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
