import { describe, expect, it } from "vitest";
import type { CompressionReport } from "./prepare-workspace.js";
import {
  COMPRESSION_REASON_LABELS,
  compressionReasonLabel,
  formatCompressionReport,
} from "./compression-report.js";

function fixture(overrides: Partial<CompressionReport> = {}): CompressionReport {
  return {
    originalTokens: 1_240_000,
    preparedTokens: 178_000,
    reductionPercent: 85.6,
    fullFiles: 64,
    compressedFiles: 126,
    excludedFiles: 842,
    compressionReductionTokens: 220_000,
    exclusionReductionTokens: 842_000,
    targetBudget: null,
    actualTokens: 178_000,
    status: "no-budget",
    warnings: [],
    files: [
      {
        relpath: "src/index.ts",
        representation: "full",
        reason: "entry-point",
        originalTokens: 1_000,
        preparedTokens: 1_000,
      },
      {
        relpath: "src/big-module.ts",
        representation: "compressed",
        reason: "structural-compression",
        originalTokens: 8_000,
        preparedTokens: 900,
      },
    ],
    ...overrides,
  };
}

describe("formatCompressionReport terminal", () => {
  it("shows the headline numbers with thousands separators and reduction %", () => {
    const out = formatCompressionReport(fixture(), "terminal");
    expect(out).toContain("Context Compression");
    expect(out).toContain("Original tokens");
    expect(out).toContain("1,240,000");
    expect(out).toContain("Prepared tokens");
    expect(out).toContain("178,000");
    expect(out).toContain("Context reduction");
    expect(out).toContain("85.6%");
  });

  it("shows the file counts and the compression/exclusion breakdown", () => {
    const out = formatCompressionReport(fixture(), "terminal");
    expect(out).toContain("Files compressed");
    expect(out).toContain("126");
    expect(out).toContain("Files excluded");
    expect(out).toContain("842");
    expect(out).toContain("Files kept full");
    expect(out).toContain("64");
    expect(out).toContain("Reduction from compression");
    expect(out).toContain("220,000");
    expect(out).toContain("Reduction from exclusion");
    expect(out).toContain("842,000");
  });

  it("omits the budget block when there is no budget", () => {
    const out = formatCompressionReport(fixture(), "terminal");
    expect(out).not.toContain("Target budget");
    expect(out).not.toContain("Difference");
  });

  it("renders the Target/Actual/Difference/Status/Reason block for a best-effort run", () => {
    const out = formatCompressionReport(
      fixture({
        targetBudget: 100_000,
        actualTokens: 118_420,
        status: "best-effort",
        budgetReason: "Must-keep files alone exceed the target.",
      }),
      "terminal",
    );
    expect(out).toContain("Target budget");
    expect(out).toContain("100,000");
    expect(out).toContain("Actual tokens");
    expect(out).toContain("118,420");
    expect(out).toContain("Difference");
    expect(out).toContain("+18,420");
    expect(out).toContain("Status");
    expect(out).toContain("Best effort");
    expect(out).toContain("Reason");
    expect(out).toContain("Must-keep files alone exceed the target.");
  });

  it("shows a within-budget block whenever a budget is set", () => {
    const out = formatCompressionReport(
      fixture({ targetBudget: 200_000, actualTokens: 178_000, status: "within-budget" }),
      "terminal",
    );
    expect(out).toContain("Target budget");
    expect(out).toContain("Within budget");
    // Under budget → negative signed difference.
    expect(out).toContain("-22,000");
  });

  it("surfaces warnings when present", () => {
    const out = formatCompressionReport(
      fixture({ warnings: ["Some files could not be parsed."] }),
      "terminal",
    );
    expect(out).toContain("Some files could not be parsed.");
  });

  it("does not leak any path or secret beyond the relpaths already in the input", () => {
    const c = fixture({ targetBudget: 100_000, status: "best-effort", actualTokens: 120_000 });
    const out = formatCompressionReport(c, "terminal");
    // The only path-like strings permitted are the input's own relpaths (and the
    // terminal summary does not even print those).
    expect(out).not.toContain("/Users/");
    expect(out).not.toContain("secret");
    expect(out).not.toContain("password");
  });
});

describe("formatCompressionReport json", () => {
  it("round-trips the report exactly", () => {
    const c = fixture({ targetBudget: 100_000, status: "best-effort" });
    const json = formatCompressionReport(c, "json");
    expect(JSON.parse(json)).toEqual(c);
  });
});

describe("compression reason labels", () => {
  it("maps every known internal reason to a readable label", () => {
    for (const [reason, label] of Object.entries(COMPRESSION_REASON_LABELS)) {
      expect(compressionReasonLabel(reason)).toBe(label);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("renders an unknown reason verbatim instead of crashing", () => {
    expect(compressionReasonLabel("some-future-reason")).toBe("some-future-reason");
  });
});
