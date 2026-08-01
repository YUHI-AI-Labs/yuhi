import type { ReductionReport } from "@yuhi/shared";
import type { CompressionReport, PreparedFileEntry } from "./prepare-workspace.js";

export interface PublicPreparedContextSummary {
  availableFiles: number;
  verifiedFiles: number;
  availableWithWarningFiles: number;
  backgroundPendingFiles: number;
  backgroundProcessingFiles: number;
  transformedFiles: number;
  excludedForSafetyFiles: number;
  keptLocalAfterFailureFiles: number;
  processingFailedFiles: number;
  originalEstimatedTokens: number | null;
  preparedEstimatedTokens: number | null;
  reducedTokens: number | null;
  reductionPercent: number | null;
  fullFiles: number;
  compressedFiles: number;
  compressionExcludedFiles: number;
  compressionEnabled: boolean;
  tokenBudget: number | null;
  tokenBudgetStatus: "not-configured" | "achieved" | "best-effort-over-target";
  originalWorkspaceModified: boolean;
  secretsExposed: number;
}

export interface PublicPreparedContextSummaryInput {
  files: readonly PreparedFileEntry[];
  compression?: CompressionReport;
  /** Whole preparation estimate used when structure compression is off. */
  reduction?: ReductionReport;
  backgroundProcessingFiles?: number;
  originalWorkspaceModified: boolean;
  secretsExposed?: number;
}

/** One public-safe calculation path shared by CLI, VS Code, reports, and handoff. */
export function buildPublicPreparedContextSummary(
  input: PublicPreparedContextSummaryInput,
): PublicPreparedContextSummary {
  const projectFiles = input.files.filter(
    (file) => file.relpath !== "manifest.json" && !file.relpath.startsWith(".yuhi/"),
  );
  const pending = projectFiles.filter(
    (file) => file.backgroundStatus === "pending" || file.outcome === "background-processing-pending",
  ).length;
  const available = projectFiles.filter(
    (file) => !file.omitted && file.status === "ok" && file.transmission === "approved",
  ).length;
  const warningAvailable = projectFiles.filter(
    (file) => file.availabilityStatus === "available-with-warning",
  ).length;
  const verified = projectFiles.filter(
    (file) => file.availabilityStatus === "available-verified",
  ).length;
  const excludedForSafety = projectFiles.filter(
    (file) =>
      file.omitted &&
      file.outcome !== "background-processing-pending" &&
      (file.action === "block" || file.outcome === "excluded-by-policy" || file.outcome === "excluded-by-user"),
  ).length;
  const keptLocalAfterFailure = projectFiles.filter(
    (file) =>
      file.omitted &&
      file.outcome !== "background-processing-pending" &&
      file.action !== "block" &&
      file.outcome !== "excluded-by-policy" &&
      file.outcome !== "excluded-by-user",
  ).length;
  const compression = input.compression;
  const original = compression?.originalTokens ?? (input.reduction?.hasData ? input.reduction.beforeTokens : null);
  const prepared = compression?.preparedTokens ?? (input.reduction?.hasData ? input.reduction.afterTokens : null);
  const reduced = original !== null && prepared !== null ? original - prepared : null;
  const reduction = original !== null && original > 0 && reduced !== null
    ? (reduced / original) * 100
    : original === 0 ? 0 : null;
  const tokenBudgetStatus = !compression || compression.targetBudget === null
    ? "not-configured"
    : compression.preparedTokens <= compression.targetBudget
      ? "achieved"
      : "best-effort-over-target";
  return {
    availableFiles: available,
    verifiedFiles: verified,
    availableWithWarningFiles: warningAvailable,
    backgroundPendingFiles: pending,
    backgroundProcessingFiles: Math.max(0, input.backgroundProcessingFiles ?? 0),
    transformedFiles: projectFiles.filter((file) => !file.omitted && file.transformed).length,
    excludedForSafetyFiles: excludedForSafety,
    keptLocalAfterFailureFiles: keptLocalAfterFailure,
    processingFailedFiles: projectFiles.filter(
      (file) => file.availabilityStatus === "processing-failed",
    ).length,
    originalEstimatedTokens: original,
    preparedEstimatedTokens: prepared,
    reducedTokens: reduced,
    reductionPercent: reduction,
    fullFiles: compression?.fullFiles ?? 0,
    compressedFiles: compression?.compressedFiles ?? 0,
    compressionExcludedFiles: compression?.excludedFiles ?? 0,
    compressionEnabled: compression !== undefined,
    tokenBudget: compression?.targetBudget ?? null,
    tokenBudgetStatus,
    originalWorkspaceModified: input.originalWorkspaceModified,
    secretsExposed: Math.max(0, input.secretsExposed ?? 0),
  };
}
