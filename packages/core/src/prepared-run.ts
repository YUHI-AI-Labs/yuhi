import * as path from "node:path";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { PrepareReport } from "./prepare-workspace.js";
import { managedWorkspaceBaseDir } from "./prepare-workspace.js";
import { buildPreparedMetrics } from "./prepared-metrics.js";
import { deriveWorkflowState, type YuhiWorkflowState } from "./workflow-state.js";
import { buildAiReadinessReport } from "./ai-readiness-report.js";
import { buildPreparationReport, type PreparationReport } from "./preparation-report.js";

export type PreparedRunStatus = "Success" | "Partial" | "Failed";

export interface SafePreparedRunSummary {
  schemaVersion: 1;
  status: PreparedRunStatus;
  runId: string;
  filesIncluded: number;
  filesTransformed: number;
  filesExcluded: number;
  filesKeptLocal: number;
  entitiesPseudonymized: number;
  identifierColumnsTransformed: number;
  analyticalColumnsPreserved: number;
  malformedTables: number;
  unverifiedTransformations: number;
  unsupportedOrUnverifiedFiles: number;
  restrictedUnresolvedFiles: number;
  hasLimitations: boolean;
  postTransformScanPassed: boolean;
  rawFallbackUsed: false;
  originalSourceFilesModified: number;
  unresolvedHighRiskFindings: number;
  launchAllowed: boolean;
  agentStarted: boolean;
  safeErrorCategory: string[];
  workflowState: YuhiWorkflowState;
  localModelName?: string;
  localModelRequests: number;
  localModelSucceeded: number;
  localModelFailed: number;
  localModelElapsedMs: number;
  localModelMaxConcurrency: number;
  localModelConfiguredParallelism: number;
  /**
   * The shareable Yuhi Preparation Report — aggregate, PUBLIC-SAFE numbers only
   * (no filenames, paths, secret types, or identities). This is what `yuhi report`
   * renders to terminal / Markdown / JSON / SVG for READMEs, PRs, and posts.
   */
  preparationReport: PreparationReport;
}

export function buildSafePreparedRunSummary(report: PrepareReport): SafePreparedRunSummary {
  const metrics = buildPreparedMetrics(report);
  const included = report.files.filter((file) => file.status === "ok" && !file.omitted);
  const acceptance = report.tabularAcceptance;
  // One source of truth: the workspace's launchAllowed. File-level warnings
  // (unresolved high-risk findings in included-unverified files, etc.) never
  // downgrade a launchable workspace — they are surfaced in the UI only.
  const safePreparedOutput = acceptance?.launchAllowed ?? true;
  const status: PreparedRunStatus = !safePreparedOutput ? "Partial" : "Success";
  const malformed = acceptance?.malformedTables ?? 0;
  const unverified = acceptance?.unverifiedTransformations ?? 0;
  const launchAllowed =
    status === "Success" &&
    safePreparedOutput;
  // Public-safe shareable report — aggregate numbers derived from the readiness
  // outcomes. Report generation must never fail a preparation (fall back to zero).
  const preparationReport = buildPreparationReportSafely(report, !launchAllowed);
  return {
    schemaVersion: 1,
    status,
    runId: report.runId,
    filesIncluded: included.length,
    filesTransformed: included.filter((file) => file.transformed).length,
    filesExcluded: metrics.filesExcluded,
    filesKeptLocal: metrics.filesKeptLocal,
    entitiesPseudonymized: acceptance?.entitiesPseudonymized ?? 0,
    identifierColumnsTransformed: acceptance?.identifierColumnsTransformed ?? 0,
    analyticalColumnsPreserved: acceptance?.analyticalColumnsPreserved ?? 0,
    malformedTables: malformed,
    unverifiedTransformations: unverified,
    unsupportedOrUnverifiedFiles: acceptance?.unsupportedOrUnverifiedFiles ?? 0,
    restrictedUnresolvedFiles: acceptance?.restrictedUnresolvedFiles ?? 0,
    hasLimitations: acceptance?.hasLimitations ?? false,
    postTransformScanPassed: acceptance?.postTransformScanPassed ?? false,
    rawFallbackUsed: false,
    originalSourceFilesModified: report.sourceModified,
    unresolvedHighRiskFindings: metrics.unresolvedHighRiskFindings,
    launchAllowed,
    agentStarted: false,
    safeErrorCategory: [
      ...(malformed > 0 ? ["malformed-table"] : []),
      ...(unverified > 0 ? ["unverified-transformation"] : []),
      ...((acceptance?.unsupportedOrUnverifiedFiles ?? 0) > 0 ? ["inspection-limitation"] : []),
      ...(report.errors.length > malformed + unverified ? ["preparation-error"] : []),
    ],
    workflowState: deriveWorkflowState({
      preparationStatus: status,
      launchAllowed,
      agentStarted: false,
    }),
    ...(acceptance?.localModelName ? { localModelName: acceptance.localModelName } : {}),
    localModelRequests: acceptance?.localModelRequests ?? 0,
    localModelSucceeded: acceptance?.localModelSucceeded ?? 0,
    localModelFailed: acceptance?.localModelFailed ?? 0,
    localModelElapsedMs: acceptance?.localModelElapsedMs ?? 0,
    localModelMaxConcurrency: acceptance?.localModelMaxConcurrency ?? 0,
    localModelConfiguredParallelism: acceptance?.localModelConfiguredParallelism ?? 0,
    preparationReport,
  };
}

/** Compute the shareable report; never throw — a report error must not fail a prepare. */
function buildPreparationReportSafely(report: PrepareReport, warning: boolean): PreparationReport {
  try {
    const readiness = buildAiReadinessReport(report.files);
    return buildPreparationReport(readiness, report.files.length, { warning });
  } catch {
    return {
      sourceFiles: report.files.length,
      preparedArtifacts: 0,
      documentsPrepared: 0,
      secretsBlocked: 0,
      identifiersTransformed: 0,
      largeFilesExcluded: 0,
      estimatedReductionPercent: 0,
      status: warning ? "ready-with-warning" : "ready",
    };
  }
}

export interface CorePreparedSession {
  schemaVersion: 1;
  preparedBy: "Yuhi";
  runId: string;
  status: PreparedRunStatus;
  launchAllowed: boolean;
  summary: SafePreparedRunSummary;
}

export async function writePreparedRunSession(
  report: PrepareReport,
): Promise<CorePreparedSession> {
  const summary = buildSafePreparedRunSummary(report);
  const session: CorePreparedSession = {
    schemaVersion: 1,
    preparedBy: "Yuhi",
    runId: report.runId,
    status: summary.status,
    launchAllowed: summary.launchAllowed,
    summary,
  };
  const target = path.join(report.outDir, ".yuhi", "session.json");
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return session;
}

export type PreparedRunValidation =
  | { kind: "valid"; workspace: string; session: CorePreparedSession }
  | {
      kind: "recovery-required";
      category:
        | "missing"
        | "quarantined"
        | "outside-managed-storage"
        | "invalid-workspace"
        | "manifest-invalid"
        | "session-invalid"
        | "incomplete"
        | "blocked";
    };

export function quarantineBaseDir(): string {
  return path.join(path.dirname(managedWorkspaceBaseDir()), "quarantine");
}

export async function assertSafeSourceWorkspace(source: string): Promise<string> {
  const resolved = await realpath(path.resolve(source));
  const storage = path.resolve(path.dirname(managedWorkspaceBaseDir()));
  if (resolved === storage || resolved.startsWith(`${storage}${path.sep}`)) {
    throw new Error("Yuhi internal storage cannot be used as a source workspace.");
  }
  let current = resolved;
  while (true) {
    const sessionPath = path.join(current, ".yuhi", "session.json");
    if (existsSync(sessionPath)) {
      try {
        const session = JSON.parse(await readFile(sessionPath, "utf8")) as { preparedBy?: unknown };
        if (session.preparedBy === "Yuhi") {
          throw new Error("A Prepared Workspace cannot be used as a source workspace.");
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("Prepared Workspace")) throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

export function resolvePreparedRunReference(reference: string): string {
  const managed = path.resolve(managedWorkspaceBaseDir());
  if (/^[a-f0-9-]{16,64}$/i.test(reference)) return path.join(managed, reference);
  const resolved = path.resolve(reference);
  if (path.dirname(resolved) !== managed) {
    throw new Error("Prepared run reference is outside Yuhi managed storage.");
  }
  return resolved;
}

export async function readPreparedRunSession(reference: string): Promise<{
  workspace: string;
  session: CorePreparedSession;
}> {
  const workspace = resolvePreparedRunReference(reference);
  const quarantine = path.resolve(quarantineBaseDir());
  if (workspace === quarantine || workspace.startsWith(`${quarantine}${path.sep}`)) {
    throw new Error("quarantined");
  }
  const realWorkspace = await realpath(workspace);
  if (path.dirname(realWorkspace) !== await realpath(managedWorkspaceBaseDir())) {
    throw new Error("outside-managed-storage");
  }
  const manifest = JSON.parse(
    await readFile(path.join(realWorkspace, "manifest.json"), "utf8"),
  ) as { runId?: unknown };
  const session = JSON.parse(
    await readFile(path.join(realWorkspace, ".yuhi", "session.json"), "utf8"),
  ) as CorePreparedSession;
  if (
    session.preparedBy !== "Yuhi" ||
    typeof session.runId !== "string" ||
    manifest.runId !== session.runId ||
    session.summary?.runId !== session.runId
  ) throw new Error("invalid-session");
  return { workspace: realWorkspace, session };
}

export async function validatePreparedRun(reference: string): Promise<PreparedRunValidation> {
  let workspace: string;
  try {
    workspace = resolvePreparedRunReference(reference);
  } catch {
    return { kind: "recovery-required", category: "outside-managed-storage" };
  }
  const quarantine = path.resolve(quarantineBaseDir());
  if (workspace === quarantine || workspace.startsWith(`${quarantine}${path.sep}`)) {
    return { kind: "recovery-required", category: "quarantined" };
  }
  try {
    const stat = await lstat(workspace);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { kind: "recovery-required", category: "invalid-workspace" };
    }
    workspace = await realpath(workspace);
  } catch {
    return { kind: "recovery-required", category: "missing" };
  }
  if (path.dirname(workspace) !== await realpath(managedWorkspaceBaseDir())) {
    return { kind: "recovery-required", category: "outside-managed-storage" };
  }
  let manifest: { runId?: unknown };
  let session: CorePreparedSession;
  try {
    manifest = JSON.parse(await readFile(path.join(workspace, "manifest.json"), "utf8"));
  } catch {
    return { kind: "recovery-required", category: "manifest-invalid" };
  }
  try {
    session = JSON.parse(await readFile(path.join(workspace, ".yuhi", "session.json"), "utf8"));
  } catch {
    return { kind: "recovery-required", category: "session-invalid" };
  }
  if (
    session?.preparedBy !== "Yuhi" ||
    typeof session.runId !== "string" ||
    manifest.runId !== session.runId ||
    session.summary?.runId !== session.runId
  ) return { kind: "recovery-required", category: "session-invalid" };
  if (session.status !== "Success") {
    return {
      kind: "recovery-required",
      category: session.status === "Partial" || session.status === "Failed" ? "blocked" : "incomplete",
    };
  }
  if (
    !session.launchAllowed ||
    !session.summary.launchAllowed ||
    session.summary.unresolvedHighRiskFindings > 0
  ) return { kind: "recovery-required", category: "blocked" };
  return { kind: "valid", workspace, session };
}
