import type { PreparedFileEntry } from "./prepare-workspace.js";
import type { PublicBackgroundStatus } from "./background/status.js";
import type { PublicPreparedContextSummary } from "./public-prepared-summary.js";

export type UserFacingAvailability =
  | "available-verified"
  | "available-with-warning"
  | "compact-representation-available"
  | "companion-added"
  | "known-risk-blocked"
  | "unavailable-after-failure";

export interface YuhiModeSummary {
  schemaVersion: 1;
  launchStatus: "ready" | "ready-with-warnings" | "blocked";
  agentCapabilities: {
    autoModeAvailable: boolean;
    selectedAgent: string;
    sourceWriteRequiresReview: boolean;
  };
  contextAvailability: {
    availableVerified: number;
    availableWithWarning: number;
    compactRepresentations: number;
    companionsAdded: number;
    knownRisksBlocked: number;
    unavailableAfterFailure: number;
  };
  contextEfficiency: {
    compressionMode: "off" | "auto" | "on";
    repositoryTokensBefore: number | null;
    repositoryTokensAfter: number | null;
    representationReductionTokens: number | null;
    representationReductionPercent: number | null;
    initialAgentContextTokens: number | null;
    /** Source files delivered as a compact structural representation (companion; original preserved). */
    compressedFiles: number;
    largeArtifactsRepresented: number;
    reductionByStructuralCompression: number;
    reductionByLargeArtifactRepresentation: number;
    reductionBySafetyTransformation: number;
  };
  background: {
    status: "idle" | "running" | "completed" | "completed-with-limitations";
    pending: number;
    processing: number;
    completed: number;
    companionUnavailable: number;
  };
  protection: {
    originalWorkspaceModified: boolean;
    knownSecretsBlocked: number;
    safeApplyRequired: boolean;
  };
}

export interface BuildYuhiModeSummaryInput {
  files: readonly PreparedFileEntry[];
  prepared: PublicPreparedContextSummary;
  background?: PublicBackgroundStatus;
  launchAllowed: boolean;
  selectedAgent?: string;
  autoModeAvailable?: boolean;
  compressionMode?: "off" | "auto" | "on";
  initialAgentContextTokens?: number | null;
  largeArtifactsRepresented?: number;
  reductionByStructuralCompression?: number;
  reductionByLargeArtifactRepresentation?: number;
  reductionBySafetyTransformation?: number;
}

/**
 * The single user-facing projection used by handoff, CLI, VS Code and reports.
 * Each source relpath contributes exactly once. A failed companion never hides an
 * original that is already available with a warning.
 */
export function buildYuhiModeSummary(input: BuildYuhiModeSummaryInput): YuhiModeSummary {
  const project = input.files.filter(
    (file) => file.relpath !== "manifest.json" && !file.relpath.startsWith(".yuhi/"),
  );
  const backgroundByPath = new Map(
    (input.background?.items ?? []).map((item) => [item.relpath, item] as const),
  );
  // Source files still enqueued for background work are in a TRANSIENT progress state,
  // not one of the six final availability states. They are reported under
  // `background.pending` only, so they are never double-counted as
  // `unavailable-after-failure`.
  const filePendingKeys = new Set<string>();
  const states = new Map<string, UserFacingAvailability>();
  for (const file of project) {
    const key = file.originalRelpath ?? file.relpath;
    const background = backgroundByPath.get(key);
    if (file.outcome === "background-processing-pending") {
      filePendingKeys.add(key);
      continue;
    }
    let state: UserFacingAvailability;
    if (file.omitted && (file.action === "block" || file.outcome === "excluded-by-policy")) {
      state = "known-risk-blocked";
    } else if (!file.omitted && (file.contextRepresentation === "compressed" || file.transformed)) {
      state = "compact-representation-available";
    } else if (!file.omitted && background?.status === "completed" && background.preparedRelpath) {
      state = "companion-added";
    } else if (!file.omitted && file.availabilityStatus === "available-with-warning") {
      // The original remains useful even if extraction/OCR/provider work failed.
      state = "available-with-warning";
    } else if (file.omitted || file.availabilityStatus === "processing-failed") {
      state = "unavailable-after-failure";
    } else {
      state = "available-verified";
    }
    states.set(key, state);
  }

  const count = (state: UserFacingAvailability): number =>
    [...states.values()].filter((value) => value === state).length;
  // A PDF can create extraction + OCR queue records. Collapse them by source relpath
  // before presenting user counts so pipeline stages never become extra "files".
  const backgroundSources = new Map<string, (NonNullable<BuildYuhiModeSummaryInput["background"]>["items"])[number]>();
  const rank = (status: string): number => status === "completed" ? 5 : status === "processing" ? 4 : status === "pending" ? 3 : status === "failed" ? 2 : 1;
  for (const item of input.background?.items ?? []) {
    const current = backgroundSources.get(item.relpath);
    if (!current || rank(item.status) >= rank(current.status)) backgroundSources.set(item.relpath, item);
  }
  const backgroundValues = [...backgroundSources.values()];
  // Pending/processing come from the public background status when present, PLUS any
  // file marked background-processing-pending in the foreground manifest that the
  // public status has not yet superseded (deduped by source relpath — no double count).
  const pendingFromFilesOnly = [...filePendingKeys].filter(
    (key) => !backgroundSources.has(key),
  ).length;
  const pending =
    backgroundValues.filter((item) => item.status === "pending").length + pendingFromFilesOnly;
  const processing = backgroundValues.filter((item) => item.status === "processing").length;
  const completed = backgroundValues.filter((item) => item.status === "completed").length;
  const companionUnavailable = backgroundValues.filter(
    (item) => item.originalSharedWithWarning && !["pending", "processing", "completed"].includes(item.status),
  ).length;
  const failed = backgroundValues.filter(
    (item) => item.status === "failed" && !item.originalSharedWithWarning,
  ).length;
  const backgroundStatus = pending + processing > 0
    ? "running"
    : completed + companionUnavailable + failed === 0
      ? "idle"
      : companionUnavailable + failed > 0
        ? "completed-with-limitations"
        : "completed";
  const warnings = count("available-with-warning") + companionUnavailable + failed;
  const before = input.prepared.originalEstimatedTokens;
  const after = input.prepared.preparedEstimatedTokens;
  const reduction = input.prepared.reducedTokens;
  const breakdown = {
    structural: Math.max(0, input.reductionByStructuralCompression ?? reduction ?? 0),
    large: Math.max(0, input.reductionByLargeArtifactRepresentation ?? 0),
    safety: Math.max(0, input.reductionBySafetyTransformation ?? 0),
  };

  return {
    schemaVersion: 1,
    launchStatus: !input.launchAllowed ? "blocked" : warnings > 0 ? "ready-with-warnings" : "ready",
    agentCapabilities: {
      autoModeAvailable: input.autoModeAvailable ?? true,
      selectedAgent: input.selectedAgent ?? "Claude Code",
      sourceWriteRequiresReview: true,
    },
    contextAvailability: {
      availableVerified: count("available-verified"),
      availableWithWarning: count("available-with-warning"),
      compactRepresentations: count("compact-representation-available"),
      companionsAdded: count("companion-added"),
      knownRisksBlocked: count("known-risk-blocked"),
      unavailableAfterFailure: count("unavailable-after-failure"),
    },
    contextEfficiency: {
      compressionMode: input.compressionMode ?? (input.prepared.compressionEnabled ? "auto" : "off"),
      repositoryTokensBefore: before,
      repositoryTokensAfter: after,
      representationReductionTokens: reduction,
      representationReductionPercent: input.prepared.reductionPercent,
      initialAgentContextTokens: input.initialAgentContextTokens ?? null,
      // Derived from the single `prepared` projection — never recomputed independently.
      compressedFiles: Math.max(0, input.prepared.compressedFiles),
      largeArtifactsRepresented: Math.max(0, input.largeArtifactsRepresented ?? 0),
      reductionByStructuralCompression: breakdown.structural,
      reductionByLargeArtifactRepresentation: breakdown.large,
      reductionBySafetyTransformation: breakdown.safety,
    },
    background: {
      status: backgroundStatus,
      pending,
      processing,
      completed,
      companionUnavailable,
    },
    protection: {
      originalWorkspaceModified: input.prepared.originalWorkspaceModified,
      knownSecretsBlocked: input.prepared.excludedForSafetyFiles,
      safeApplyRequired: true,
    },
  };
}

export function renderYuhiModeHandoff(summary: YuhiModeSummary): string {
  const e = summary.contextEfficiency;
  return [
    "# Yuhi Agent Handoff",
    "",
    `Yuhi Mode is ${summary.launchStatus === "blocked" ? "blocked" : "ready"}.`,
    "",
    "Read `.yuhi/context/document-index.md` first — Yuhi's index of prepared document context (always present).",
    "",
    "## Context available",
    "",
    `- Verified files: ${summary.contextAvailability.availableVerified}`,
    `- Files available with warnings: ${summary.contextAvailability.availableWithWarning}`,
    `- Compact representations: ${summary.contextAvailability.compactRepresentations}`,
    `- Verified document companions: ${summary.contextAvailability.companionsAdded}`,
    `- Known-risk files blocked: ${summary.contextAvailability.knownRisksBlocked}`,
    `- Unavailable after processing failure: ${summary.contextAvailability.unavailableAfterFailure}`,
    `- Processing locally in background: ${summary.background.pending + summary.background.processing}`,
    "",
    "Some documents are available in their original format before local inspection completes.",
    "Treat files marked inspection-pending as unverified, but use them when needed.",
    "Verified companions may appear as background processing completes.",
    "",
    "## Context efficiency",
    "",
    `- Compression mode: ${e.compressionMode}`,
    `- Repository representation: ${e.repositoryTokensBefore ?? "Not measured"} → ${e.repositoryTokensAfter ?? "Not measured"} estimated tokens`,
    `- Repository representation reduction: ${e.representationReductionPercent === null ? "Not measured" : `${e.representationReductionPercent.toFixed(1)}%`}`,
    `- Initial agent context estimate: ${e.initialAgentContextTokens ?? "Not measured"} tokens`,
    `- Large artifacts represented compactly: ${e.largeArtifactsRepresented}`,
    "",
    "## Source protection",
    "",
    `The original workspace has${summary.protection.originalWorkspaceModified ? "" : " not"} been modified.`,
    "Changes require explicit Yuhi review before they are applied.",
    "",
  ].join("\n");
}
