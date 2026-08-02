import { describe, expect, it } from "vitest";
import { buildPublicPreparedContextSummary } from "./public-prepared-summary.js";
import type { PreparedFileEntry } from "./prepare-workspace.js";

const file = (overrides: Partial<PreparedFileEntry>): PreparedFileEntry => ({
  relpath: "src/app.ts",
  action: "allow",
  status: "ok",
  transmission: "approved",
  beforeChars: 10,
  afterChars: 10,
  omitted: false,
  ...overrides,
});

describe("PublicPreparedContextSummary", () => {
  it("keeps background pending distinct from excluded and failed", () => {
    const summary = buildPublicPreparedContextSummary({
      files: [
        file({ relpath: "src/app.ts", availabilityStatus: "available-verified" }),
        file({ relpath: "docs/warning.pdf", outcome: "background-processing-pending", availabilityStatus: "available-with-warning", backgroundStatus: "pending" }),
        file({ relpath: "docs/report.pdf", outcome: "background-processing-pending", availabilityStatus: "background-processing", backgroundStatus: "pending", omitted: true, status: "skipped", transmission: "blocked" }),
        file({ relpath: "private.key", action: "block", outcome: "excluded-by-policy", omitted: true, status: "skipped", transmission: "blocked" }),
        file({ relpath: "broken.bin", action: "local-only", outcome: "local-only-unverified", omitted: true, status: "skipped", transmission: "blocked" }),
      ],
      originalWorkspaceModified: false,
    });
    expect(summary.availableFiles).toBe(2);
    expect(summary.verifiedFiles).toBe(1);
    expect(summary.availableWithWarningFiles).toBe(1);
    expect(summary.backgroundPendingFiles).toBe(2);
    expect(summary.excludedForSafetyFiles).toBe(1);
    expect(summary.keptLocalAfterFailureFiles).toBe(1);
    expect(summary.secretsExposed).toBe(0);
  });

  it("reports compression and an achieved token budget from one calculation", () => {
    const summary = buildPublicPreparedContextSummary({
      files: [file({ transformed: true })],
      compression: {
        originalTokens: 10_000,
        preparedTokens: 5_000,
        reductionPercent: 50,
        fullFiles: 1,
        compressedFiles: 2,
        excludedFiles: 0,
        compressionReductionTokens: 5_000,
        exclusionReductionTokens: 0,
        targetBudget: 5_000,
        actualTokens: 5_000,
        status: "within-budget",
        warnings: [],
        files: [],
      },
      originalWorkspaceModified: false,
    });
    expect(summary.originalEstimatedTokens).toBe(10_000);
    expect(summary.preparedEstimatedTokens).toBe(5_000);
    expect(summary.reducedTokens).toBe(5_000);
    expect(summary.reductionPercent).toBe(50);
    expect(summary.tokenBudget).toBe(5_000);
    expect(summary.tokenBudgetStatus).toBe("achieved");
  });

  it("reports compression off as not measured and best-effort over target honestly", () => {
    const off = buildPublicPreparedContextSummary({ files: [], originalWorkspaceModified: false });
    expect(off.compressionEnabled).toBe(false);
    expect(off.originalEstimatedTokens).toBeNull();
    expect(off.reductionPercent).toBeNull();
    expect(off.tokenBudgetStatus).toBe("not-configured");

    const over = buildPublicPreparedContextSummary({
      files: [],
      compression: {
        originalTokens: 190_787, preparedTokens: 112_012, reductionPercent: 41.3,
        fullFiles: 100, compressedFiles: 28, excludedFiles: 0,
        compressionReductionTokens: 78_775, exclusionReductionTokens: 0,
        targetBudget: 100_000, actualTokens: 112_012, status: "best-effort",
        budgetReason: "Essential files exceed budget", warnings: [], files: [],
      },
      originalWorkspaceModified: false,
    });
    expect(over.tokenBudgetStatus).toBe("best-effort-over-target");
    expect(over.preparedEstimatedTokens! - over.tokenBudget!).toBe(12_012);
  });
});
