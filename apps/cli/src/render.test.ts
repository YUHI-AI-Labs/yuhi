import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrepareReport } from "@yuhi/core";
import { renderPrepareReport } from "./render.js";

afterEach(() => vi.restoreAllMocks());

describe("renderPrepareReport boundary and metric terminology", () => {
  it("uses the same honest Prepared Workspace boundary terms as VS Code", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => lines.push(args.join(" ")));
    const report: PrepareReport = {
      runId: "synthetic",
      outDir: "/synthetic/.yuhi/prepared/synthetic",
      report: {
        beforeChars: 1200, afterChars: 256,
        beforeTokens: 300, afterTokens: 64, tokensSaved: 236,
        percentReduction: 236 / 300, hasData: true, filesExcluded: 0,
        filesSummarized: 1, sensitiveMasked: 1, sourceModified: 0, approx: true,
      },
      files: [{
        relpath: "notes.md", action: "prepare-locally", status: "ok",
        transmission: "approved", beforeChars: 1200, afterChars: 256,
        transformations: ["summarized", "pseudonymized", "masked"], maskedValues: 2,
      }],
      blocked: [], errors: [],
      safetyMode: "balanced",
      decisions: [{
        relpath: "notes.md", action: "prepare-locally", ruleName: "synthetic",
        reason: "Synthetic fixture.", destinations: ["external"],
        findings: [{
          detector: "email", severity: "medium", path: "notes.md",
          description: "Synthetic category", maskedPreview: "[masked]",
        }],
      }],
      sourceModified: 0,
    };
    renderPrepareReport(report);
    const output = lines.join("\n");
    expect(output).toContain("Prepared by Yuhi");
    expect(output).toContain("Estimated context reduction: 78.7%");
    expect(output).toContain("Sensitive findings detected");
    expect(output).toContain("Sensitive values masked");
    expect(output).toContain("Initial context");
    expect(output).toContain("Workspace boundary");
    expect(output).toContain("advisory");
    expect(output).toContain("Filesystem enforcement");
    expect(output).toContain("OS sandbox");
    expect(output).toContain("may access files outside");
    expect(output).not.toContain("confined");
  });
});
