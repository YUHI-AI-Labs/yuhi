import {
  buildSafePreparedRunSummary,
  formatPreparationReport,
  type SafePreparedRunSummary,
} from "@yuhi/core";

export type CliPrepareResult = SafePreparedRunSummary;

export const buildCliPrepareResult = buildSafePreparedRunSummary;

export function cliPrepareExitCode(result: CliPrepareResult): number {
  if (result.status === "Success") return 0;
  if (result.status === "Partial") return 2;
  return 4;
}

export function formatCliPrepareResult(result: CliPrepareResult): string {
  if (result.status !== "Success") {
    return [
      "Preparation incomplete",
      "",
      `Status: ${result.status}`,
      `Workflow: ${result.workflowState}`,
      `Malformed tables: ${result.malformedTables}`,
      `Unverified transformations: ${result.unverifiedTransformations}`,
      `Unsupported or unverified files: ${result.unsupportedOrUnverifiedFiles}`,
      `Restricted unresolved files: ${result.restrictedUnresolvedFiles}`,
      `Files kept local: ${result.filesKeptLocal}`,
      "Raw fallback used: No",
      "Launch allowed: No",
      "Agent launch blocked: Yes",
      "",
      `Run \`yuhi review ${result.runId}\` for safe metadata.`,
      `Run \`yuhi prepare-again ${result.runId} --source <folder> --exclude-blocked\` to create a new run.`,
      "Run `yuhi prepare <another-source>` to choose another source.",
    ].join("\n");
  }
  const context = result.publicSummary;
  const mode = result.yuhiModeSummary;
  // Availability + background counts are NOT re-derived here — they come only from the
  // single YuhiModeSummary (`modeLines`). This block reports compression / token-budget /
  // protection facts, which are efficiency & protection outcomes rather than the
  // per-file availability states the summary owns. When the summary is absent (a legacy
  // run) the availability rows fall back to `context` so nothing is lost.
  const contextLines = context
    ? [
        "Context preparation",
        `Context Compression: ${context.compressionEnabled ? "On" : "Off"}`,
        ...(mode
          ? []
          : [
              `Verified files: ${context.verifiedFiles}`,
              `Available with warning: ${context.availableWithWarningFiles}`,
              `Background pending: ${context.backgroundPendingFiles}`,
              `Excluded known risks: ${context.excludedForSafetyFiles}`,
              `Processing failures: ${context.processingFailedFiles}`,
            ]),
        `Original estimated tokens: ${context.originalEstimatedTokens ?? "Not measured"}`,
        `Prepared estimated tokens: ${context.preparedEstimatedTokens ?? "Not measured"}`,
        `Tokens reduced: ${context.reducedTokens ?? "Not measured"}`,
        `Estimated context reduction: ${context.reductionPercent === null ? "Not measured" : `${context.reductionPercent.toFixed(1)}%`}`,
        `Full files: ${context.fullFiles}`,
        `Compressed files: ${mode ? mode.contextEfficiency.compressedFiles : context.compressedFiles}`,
        `Excluded files: ${context.compressionExcludedFiles}`,
        `Token Budget: ${context.tokenBudget ?? "No target"}`,
        `Token Budget status: ${context.tokenBudgetStatus}`,
        `Secrets exposed: ${context.secretsExposed}`,
        "",
      ]
    : [];
  const modeLines = mode
    ? [
        `Yuhi Mode: ${mode.launchStatus}`,
        `Agent: ${mode.agentCapabilities.selectedAgent}`,
        `Auto mode available: ${mode.agentCapabilities.autoModeAvailable ? "Yes" : "No"}`,
        `Available verified: ${mode.contextAvailability.availableVerified}`,
        `Available with warnings: ${mode.contextAvailability.availableWithWarning}`,
        `Compact representations: ${mode.contextAvailability.compactRepresentations}`,
        `Companions added: ${mode.contextAvailability.companionsAdded}`,
        `Known risks blocked: ${mode.contextAvailability.knownRisksBlocked}`,
        `Unavailable after failure: ${mode.contextAvailability.unavailableAfterFailure}`,
        `Repository representation: ${mode.contextEfficiency.repositoryTokensBefore ?? "Not measured"} → ${mode.contextEfficiency.repositoryTokensAfter ?? "Not measured"} estimated tokens`,
        `Estimated context reduction: ${mode.contextEfficiency.representationReductionPercent === null ? "Not measured" : `${mode.contextEfficiency.representationReductionPercent.toFixed(1)}%`}`,
        `Compressed files: ${mode.contextEfficiency.compressedFiles}`,
        `Large artifacts represented: ${mode.contextEfficiency.largeArtifactsRepresented}`,
        `Initial agent context: ${mode.contextEfficiency.initialAgentContextTokens ?? "Not measured"} estimated tokens`,
        `Background status: ${mode.background.status}`,
        `Background pending: ${mode.background.pending}`,
        `Background processing: ${mode.background.processing}`,
        `Background completed: ${mode.background.completed}`,
        `Background companion unavailable: ${mode.background.companionUnavailable}`,
        `Original workspace modified: ${mode.protection.originalWorkspaceModified ? "Yes" : "No"}`,
        `Safe Apply required: ${mode.protection.safeApplyRequired ? "Yes" : "No"}`,
        "",
      ]
    : [];
  return [
    // Lead with the shareable, public-safe Repository Report — the proof of value.
    formatPreparationReport(result.preparationReport, "terminal"),
    "",
    `Share it: yuhi report ${result.runId} --format markdown  (also: json, svg)`,
    "",
    "Prepared by Yuhi",
    "",
    ...modeLines,
    ...contextLines,
    "Status: Success",
    `Workflow: ${result.workflowState}`,
    `Files included: ${result.filesIncluded}`,
    `Files transformed: ${result.filesTransformed}`,
    ...(result.hasLimitations
      ? [
          "Some files could not be safely inspected or transformed.",
          `Unsupported or unverified files: ${result.unsupportedOrUnverifiedFiles}`,
          `Restricted unresolved files: ${result.restrictedUnresolvedFiles}`,
        ]
      : []),
    `Entities pseudonymized: ${result.entitiesPseudonymized}`,
    `Identifier columns transformed: ${result.identifierColumnsTransformed}`,
    `Analytical columns preserved: ${result.analyticalColumnsPreserved}`,
    `Post-transformation scan: ${result.postTransformScanPassed ? "Passed" : "Not applicable"}`,
    "Raw fallback used: No",
    `Launch allowed: ${result.launchAllowed ? "Yes" : "No"}`,
    `Original source modified: ${result.originalSourceFilesModified === 0 ? "No" : "Yes"}`,
    `Yuhi local processing requests: ${result.localModelRequests}`,
    `Yuhi local processing succeeded: ${result.localModelSucceeded}`,
    `Yuhi local processing failed: ${result.localModelFailed}`,
    `Configured parallelism: ${result.localModelConfiguredParallelism}`,
    `Peak parallel requests: ${result.localModelMaxConcurrency}`,
    `Yuhi local processing time: ${(result.localModelElapsedMs / 1000).toFixed(1)} seconds`,
    "",
    `Run ID: ${result.runId}`,
  ].join("\n");
}
