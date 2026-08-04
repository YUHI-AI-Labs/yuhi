import { describe, expect, it } from "vitest";
import type { PreparedFileEntry } from "./prepare-workspace.js";
import { buildPublicStatus, type PublicBackgroundStatus } from "./background/status.js";
import type { PublicBackgroundItem } from "./background/types.js";
import { buildPublicPreparedContextSummary } from "./public-prepared-summary.js";
import { buildYuhiModeSummary, renderYuhiModeHandoff } from "./yuhi-mode-summary.js";

const file = (overrides: Partial<PreparedFileEntry>): PreparedFileEntry => ({
  relpath: "doc.pdf",
  action: "allow",
  status: "ok",
  transmission: "approved",
  beforeChars: 100,
  afterChars: 100,
  availabilityStatus: "available-with-warning",
  inspectionStatus: "pending",
  backgroundStatus: "pending",
  originalShared: true,
  warningCode: "inspection-pending",
  ...overrides,
});

describe("YuhiModeSummary", () => {
  it("counts a source once and keeps an available original warning when its companion fails", () => {
    const files = [file({})];
    const prepared = buildPublicPreparedContextSummary({ files, originalWorkspaceModified: false });
    // Built through `buildPublicStatus` so the file/job split and the activity flag
    // stay consistent with production rather than being hand-written here.
    const background: PublicBackgroundStatus = buildPublicStatus([
      {
        runId: "run",
        relpath: "doc.pdf",
        kind: "document-extraction",
        status: "kept-local",
        reasonCode: "background-provider-unavailable",
        originalSharedWithWarning: true,
      } as PublicBackgroundItem,
    ]);
    const summary = buildYuhiModeSummary({ files, prepared, background, launchAllowed: true });
    expect(summary.contextAvailability.availableWithWarning).toBe(1);
    expect(summary.contextAvailability.unavailableAfterFailure).toBe(0);
    expect(summary.background.status).toBe("completed-with-limitations");
  });

  it("separates repository representation from initial agent context and renders no raw paths", () => {
    const files = [file({ relpath: "safe.ts", availabilityStatus: "available-verified", inspectionStatus: "verified" })];
    const prepared = buildPublicPreparedContextSummary({
      files,
      originalWorkspaceModified: false,
      compression: { originalTokens: 1000, preparedTokens: 600, reductionPercent: 40, targetBudget: null, fullFiles: 0, compressedFiles: 1, excludedFiles: 0, compressionReductionTokens: 400, exclusionReductionTokens: 0, actualTokens: 600, status: "within-budget", warnings: [], files: [] },
    });
    const summary = buildYuhiModeSummary({ files, prepared, launchAllowed: true, initialAgentContextTokens: 42, autoModeAvailable: true });
    expect(summary.contextEfficiency.repositoryTokensBefore).toBe(1000);
    expect(summary.contextEfficiency.initialAgentContextTokens).toBe(42);
    expect(summary.agentCapabilities.autoModeAvailable).toBe(true);
    expect(summary.protection.safeApplyRequired).toBe(true);
    expect(renderYuhiModeHandoff(summary)).not.toContain("/Users/");
  });

  it("counts only a known blocked risk as known-risk-blocked", () => {
    const files = [
      file({ relpath: ".env", action: "block", status: "blocked", omitted: true, transmission: "blocked", outcome: "blocked-high-risk" }),
      file({ relpath: "broken.bin", status: "error", omitted: true, transmission: "blocked", availabilityStatus: "processing-failed" }),
    ];
    const prepared = buildPublicPreparedContextSummary({ files, originalWorkspaceModified: false });
    const summary = buildYuhiModeSummary({ files, prepared, launchAllowed: true });
    expect(summary.contextAvailability.knownRisksBlocked).toBe(1);
    expect(summary.contextAvailability.unavailableAfterFailure).toBe(1);
  });
});
