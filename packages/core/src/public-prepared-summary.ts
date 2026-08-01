import type { CompressionReport, PreparedFileEntry } from "./prepare-workspace.js";

export interface PublicPreparedContextSummary {
  availableFiles: number;
  backgroundPendingFiles: number;
  backgroundProcessingFiles: number;
  transformedFiles: number;
  excludedForSafetyFiles: number;
  keptLocalAfterFailureFiles: number;
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
    (file) => file.outcome === "background-processing-pending",
  ).length;
  const available = projectFiles.filter(
    (file) => !file.omitted && file.status === "ok" && file.transmission === "approved",
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
  const original = compression?.originalTokens ?? null;
  const prepared = compression?.preparedTokens ?? null;
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
    backgroundPendingFiles: pending,
    backgroundProcessingFiles: Math.max(0, input.backgroundProcessingFiles ?? 0),
    transformedFiles: projectFiles.filter((file) => !file.omitted && file.transformed).length,
    excludedForSafetyFiles: excludedForSafety,
    keptLocalAfterFailureFiles: keptLocalAfterFailure,
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
