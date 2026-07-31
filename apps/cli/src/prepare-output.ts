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
  return [
    // Lead with the shareable, public-safe Repository Report — the proof of value.
    formatPreparationReport(result.preparationReport, "terminal"),
    "",
    `Share it: yuhi report ${result.runId} --format markdown  (also: json, svg)`,
    "",
    "Prepared by Yuhi",
    "",
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
