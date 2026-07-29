import {
  buildSafePreparedRunSummary,
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
    "Prepared by Yuhi",
    "",
    "Status: Success",
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
    "",
    `Run ID: ${result.runId}`,
  ].join("\n");
}
