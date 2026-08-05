import { describe, expect, it } from "vitest";
import type { PrepareReport } from "./prepare-workspace.js";
import {
  buildPreparedFileDecisions,
  buildPreparedMetrics,
  classifySensitiveFinding,
  opaqueWorkspaceId,
} from "./prepared-metrics.js";

function report(): PrepareReport {
  return {
    runId: "r", contextId: "sha256:" + "0".repeat(64), outDir: "/tmp/.yuhi/prepared/r", safetyMode: "balanced",
    report: {
      beforeChars: 400, afterChars: 100,
      beforeTokens: 100, afterTokens: 40, tokensSaved: 60, percentReduction: 0.6,
      hasData: true, filesExcluded: 1, filesSummarized: 1, sensitiveMasked: 1,
      sourceModified: 0, approx: true, method: "cjk-weighted-heuristic",
    },
    files: [
      {
        relpath: "a.md", action: "prepare-locally", status: "ok", transmission: "approved",
        beforeChars: 400, afterChars: 100, transformations: ["summarized", "pseudonymized", "masked"],
        maskedValues: 2, transformed: true,
      },
      {
        relpath: ".env", action: "local-only", status: "skipped", transmission: "blocked",
        beforeChars: 20, afterChars: 0, omitted: true,
      },
    ],
    blocked: [], errors: [],
    decisions: [
      {
        relpath: "a.md", action: "prepare-locally", ruleName: "confidential",
        reason: "Student data.", destinations: ["external"],
        findings: [{
          detector: "student-id", severity: "medium", path: "a.md",
          description: "Synthetic student ID", maskedPreview: "[masked]",
        }],
      },
      {
        relpath: ".env", action: "local-only", ruleName: "secrets", reason: "Private.",
        destinations: [], findings: [{
          detector: "api-key", severity: "critical", path: ".env",
          description: "Synthetic key", maskedPreview: "[masked]",
        }],
      },
    ],
    sourceModified: 0,
  };
}

describe("prepared metrics", () => {
  it("uses the shared, explicit file and masking counts", () => {
    expect(buildPreparedMetrics(report())).toMatchObject({
      filesInspected: 2, filesWithSensitiveFindings: 2,
      filesPreparedLocally: 1, preparedFilesModified: 1, filesSummarized: 1,
      filesPseudonymized: 1, filesWithMaskedValues: 1, filesKeptLocal: 1,
      sensitiveFindings: 2, sensitiveValuesMasked: 2,
      estimatedTokensAvoided: 60, estimatedReductionPercent: 60,
    });
  });

  it("counts findings, finding-bearing files, masked values, and masked files separately", () => {
    const r = report();
    r.decisions![0]!.findings.push({
      detector: "email", severity: "low", path: "a.md",
      description: "Synthetic category", maskedPreview: "[masked]",
    });
    const metrics = buildPreparedMetrics(r);
    expect(metrics.sensitiveFindings).toBe(3);
    expect(metrics.filesWithSensitiveFindings).toBe(2);
    expect(metrics.sensitiveValuesMasked).toBe(2);
    expect(metrics.filesWithMaskedValues).toBe(1);
  });

  it("preserves fractional reduction for one-decimal UI rounding", () => {
    const r = report();
    r.report.beforeTokens = 300;
    r.report.afterTokens = 64;
    expect(buildPreparedMetrics(r).estimatedReductionPercent).toBeCloseTo(78.666666, 5);
  });

  it("deduplicates normalized finding paths without changing event count", () => {
    const r = report();
    r.decisions!.push({ ...r.decisions![0]!, relpath: "./a.md" });
    const metrics = buildPreparedMetrics(r);
    expect(metrics.sensitiveFindings).toBe(3);
    expect(metrics.filesWithSensitiveFindings).toBe(2);
  });

  it("counts transformed source files once and excludes generated metadata", () => {
    const r = report();
    r.files.push(
      {
        ...r.files[0]!, relpath: ".yuhi/session.json", transformed: true,
      },
      {
        ...r.files[0]!, relpath: "manifest.json", transformed: true,
      },
    );
    expect(buildPreparedMetrics(r).preparedFilesModified).toBe(1);
  });

  it("does not mark byte-identical, excluded, or kept-local files transformed", () => {
    const r = report();
    r.files[0] = {
      ...r.files[0]!,
      beforeChars: 100,
      afterChars: 100,
      transformed: false,
    };
    r.files.push({
      relpath: "blocked.txt", action: "block", status: "skipped", transmission: "blocked",
      beforeChars: 10, afterChars: 0, omitted: true, transformed: true,
    });
    expect(buildPreparedMetrics(r).preparedFilesModified).toBe(0);
  });

  it("handles zero before-tokens without NaN or Infinity", () => {
    const r = report();
    r.report.beforeTokens = 0;
    r.report.afterTokens = 0;
    expect(buildPreparedMetrics(r).estimatedReductionPercent).toBe(0);
  });

  it("counts sensitive finding categories without retaining values", () => {
    expect(buildPreparedMetrics(report()).findingsByCategory).toEqual({
      "student-id": 1, credential: 1,
    });
  });

  it("builds exact receive decisions and sensitivity explanations", () => {
    expect(buildPreparedFileDecisions(report())).toMatchObject([
      { relativePath: "a.md", sensitivityLevel: "Confidential", agentReceives: "Transformed" },
      { relativePath: ".env", sensitivityLevel: "Restricted", agentReceives: "No" },
    ]);
  });

  it("classifies common detectors", () => {
    expect(classifySensitiveFinding({ detector: "email-address" })).toBe("email");
    expect(classifySensitiveFinding({ detector: "salary-field" })).toBe("salary-or-tax");
    expect(classifySensitiveFinding({ detector: "private-key" })).toBe("private-key");
  });

  it("creates a stable opaque workspace identifier", () => {
    expect(opaqueWorkspaceId("/private/source")).toBe(opaqueWorkspaceId("/private/source"));
    expect(opaqueWorkspaceId("/private/source")).toMatch(/^[a-f0-9]{24}$/);
    expect(opaqueWorkspaceId("/private/source")).not.toContain("/private/source");
  });
});
