import { createHash } from "node:crypto";
import path from "node:path";
import type { Action, FileDecision, ScanFinding, Severity } from "@yuhi/shared";
import type { PrepareReport, PreparedFileEntry } from "./prepare-workspace.js";

export type SensitivityLevel = "Public" | "Internal" | "Confidential" | "Restricted" | "Unknown";

export interface PreparedFileDecision {
  relativePath: string;
  action: Action;
  sensitivityLevel: SensitivityLevel;
  findingCount: number;
  findingCategoryCounts: Record<string, number>;
  matchedRule: string;
  reason: string;
  classificationSource: "explicit-rule" | "scanner-finding" | "path-or-file-type" | "organization-policy" | "fallback";
  transformed: boolean;
  included: boolean;
  omitted: boolean;
  transformationKinds: ("summarized" | "pseudonymized" | "masked")[];
  agentReceives: "Unchanged" | "Transformed" | "No";
  unresolvedHighRiskCount: number;
}

export interface PreparedMetrics {
  filesInspected: number;
  filesWithSensitiveFindings: number;
  filesSentUnchanged: number;
  filesPreparedLocally: number;
  preparedFilesModified: number;
  filesSummarized: number;
  filesPseudonymized: number;
  filesWithMaskedValues: number;
  filesKeptLocal: number;
  filesExcluded: number;
  sensitiveFilesExcluded: number;
  sensitiveFindings: number;
  sensitiveValuesMasked: number;
  unresolvedHighRiskFindings: number;
  findingsByCategory: Record<string, number>;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  estimatedTokensAvoided: number;
  estimatedReductionPercent: number;
  originalSourceFilesModified: number;
}

const KEPT_LOCAL = new Set<Action>(["local-only", "inject", "ask", "metadata-only"]);
const PREPARED = new Set<Action>(["redact", "prepare-locally", "summarize-local"]);

export function classifySensitiveFinding(finding: Pick<ScanFinding, "detector">): string {
  const id = finding.detector.toLowerCase();
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

function sensitivityFor(decision: FileDecision | undefined, entry: PreparedFileEntry): SensitivityLevel {
  if (!decision) return "Unknown";
  if (entry.omitted && (decision.action === "block" || decision.action === "local-only")) return "Restricted";
  if (decision.findings.some((f) => f.severity === "critical" || f.severity === "high")) {
    return entry.omitted ? "Restricted" : "Confidential";
  }
  if (decision.findings.length > 0 || PREPARED.has(decision.action)) return "Confidential";
  if (/internal/i.test(decision.ruleName) || /internal/i.test(decision.reason)) return "Internal";
  if (decision.action === "allow") return "Public";
  return "Unknown";
}

function normalizedRelativePath(relpath: string): string {
  return path.posix.normalize(relpath.replaceAll("\\", "/")).replace(/^\.\/+/, "");
}

function classificationSource(decision: FileDecision | undefined): PreparedFileDecision["classificationSource"] {
  if (!decision) return "fallback";
  if (decision.ruleName === "default") return decision.findings.length > 0 ? "scanner-finding" : "fallback";
  if (decision.ruleName.startsWith("detector:")) return "scanner-finding";
  if (/organization|org-policy/i.test(decision.ruleName)) return "organization-policy";
  if (/path|file-type|binary|symlink|large/i.test(decision.ruleName)) return "path-or-file-type";
  return "explicit-rule";
}

export function buildFileDecision(
  entry: PreparedFileEntry,
  decision?: FileDecision,
): PreparedFileDecision {
  const included = entry.status === "ok" && !entry.omitted;
  const transformed = included && entry.transformed === true;
  const findingCategoryCounts: Record<string, number> = {};
  for (const finding of decision?.findings ?? []) {
    const category = classifySensitiveFinding(finding);
    findingCategoryCounts[category] = (findingCategoryCounts[category] ?? 0) + 1;
  }
  const unresolvedHighRiskCount =
    included && entry.action === "allow"
      ? (decision?.findings ?? []).filter((finding) => highRisk(finding.severity)).length
      : 0;
  return {
    relativePath: normalizedRelativePath(entry.relpath),
    action: entry.action,
    sensitivityLevel: sensitivityFor(decision, entry),
    findingCount: decision?.findings.length ?? 0,
    findingCategoryCounts,
    matchedRule: decision?.ruleName ?? "preparation result",
    reason: decision?.reason ?? (entry.omitted ? "Omitted from the Prepared Workspace." : "Included by policy."),
    classificationSource: classificationSource(decision),
    transformed,
    included,
    omitted: !included,
    transformationKinds: entry.transformations ?? [],
    agentReceives: !included ? "No" : transformed ? "Transformed" : "Unchanged",
    unresolvedHighRiskCount,
  };
}

export function buildPreparedMetrics(report: PrepareReport): PreparedMetrics {
  const decisions = new Map((report.decisions ?? []).map((d) => [normalizedRelativePath(d.relpath), d]));
  const sourceFiles = report.files.filter(
    (file) => file.relpath !== "manifest.json" && !normalizedRelativePath(file.relpath).startsWith(".yuhi/"),
  );
  const fileDecisions = sourceFiles.map((f) => buildFileDecision(f, decisions.get(normalizedRelativePath(f.relpath))));
  const findings = (report.decisions ?? []).flatMap((d) => d.findings);
  const filesWithSensitiveFindings = new Set(
    (report.decisions ?? [])
      .filter((decision) => decision.findings.length > 0)
      .map((decision) => normalizedRelativePath(decision.relpath)),
  ).size;
  const findingsByCategory: Record<string, number> = {};
  for (const finding of findings) {
    const category = classifySensitiveFinding(finding);
    findingsByCategory[category] = (findingsByCategory[category] ?? 0) + 1;
  }
  const unresolvedHighRiskFindings = (report.decisions ?? []).reduce((total, decision) => {
    const output = sourceFiles.find(
      (f) => normalizedRelativePath(f.relpath) === normalizedRelativePath(decision.relpath),
    );
    if (!output || output.omitted || output.action !== "allow") return total;
    return total + decision.findings.filter((f) => highRisk(f.severity)).length;
  }, 0);
  const before = report.report.beforeTokens;
  const after = report.report.afterTokens;
  return {
    filesInspected: sourceFiles.length,
    filesWithSensitiveFindings,
    filesSentUnchanged: fileDecisions.filter((f) => f.agentReceives === "Unchanged").length,
    filesPreparedLocally: fileDecisions.filter((f) => f.transformationKinds.length > 0).length,
    preparedFilesModified: fileDecisions.filter((f) => f.transformed).length,
    filesSummarized: sourceFiles.filter((f) => f.transformations?.includes("summarized")).length,
    filesPseudonymized: sourceFiles.filter((f) => f.transformations?.includes("pseudonymized")).length,
    filesWithMaskedValues: sourceFiles.filter((f) => (f.maskedValues ?? 0) > 0).length,
    filesKeptLocal: sourceFiles.filter((f) => f.omitted && KEPT_LOCAL.has(f.action)).length,
    filesExcluded: sourceFiles.filter((f) => f.omitted && !KEPT_LOCAL.has(f.action)).length,
    sensitiveFilesExcluded: fileDecisions.filter(
      (f) =>
        !f.included &&
        !KEPT_LOCAL.has(f.action) &&
        (f.sensitivityLevel === "Confidential" || f.sensitivityLevel === "Restricted"),
    ).length,
    sensitiveFindings: findings.length,
    sensitiveValuesMasked: sourceFiles.reduce((n, f) => n + (f.maskedValues ?? 0), 0),
    unresolvedHighRiskFindings,
    findingsByCategory,
    estimatedTokensBefore: before,
    estimatedTokensAfter: after,
    estimatedTokensAvoided: before - after,
    estimatedReductionPercent: before > 0 ? ((before - after) / before) * 100 : 0,
    originalSourceFilesModified: report.sourceModified,
  };
}

export interface PreparedRuntimeBoundary {
  initialContextPrepared: true;
  startDirectory: "prepared-workspace";
  workspaceInstructionPresent: true;
  workspaceBoundary: "advisory";
  filesystemEnforcement: "none";
  osSandboxEnabled: false;
  externalPathAccessPossible: true;
}

export function buildPreparedRuntimeBoundary(): PreparedRuntimeBoundary {
  return {
    initialContextPrepared: true,
    startDirectory: "prepared-workspace",
    workspaceInstructionPresent: true,
    workspaceBoundary: "advisory",
    filesystemEnforcement: "none",
    osSandboxEnabled: false,
    externalPathAccessPossible: true,
  };
}

export function buildPreparedFileDecisions(report: PrepareReport): PreparedFileDecision[] {
  const decisions = new Map((report.decisions ?? []).map((d) => [normalizedRelativePath(d.relpath), d]));
  return report.files.map((f) => buildFileDecision(f, decisions.get(normalizedRelativePath(f.relpath))));
}

export function opaqueWorkspaceId(sourceRoot: string): string {
  return createHash("sha256").update(sourceRoot).digest("hex").slice(0, 24);
}

function highRisk(severity: Severity): boolean {
  return severity === "critical" || severity === "high";
}
