import { describe, expect, it } from "vitest";
import { renderAgentChangeReviewHtml } from "./agent-review.js";

describe("agent change review UI", () => {
  it("renders a workflow UI without source content", () => {
    const html = renderAgentChangeReviewHtml({
      schemaVersion: 2,
      runId: "synthetic-run",
      changes: [{
        kind: "modified",
        relpath: "src/app.ts",
        eligibility: "safe-to-apply",
        eligibilityReason: "manifest-included-unchanged",
      }],
      security: { safe: true, findingCounts: {}, highRiskFindingCount: 0, uninspectableFileCount: 0 },
      applyAllowed: true,
      blockers: [],
    }, "Claude Code");
    expect(html).toContain("Safe Agent Execution");
    expect(html).toContain("Nothing is applied automatically");
    expect(html).toContain("Apply to Original Workspace");
    expect(html).toContain("Stop Yuhi and Return");
    expect(html).toContain("Choose Another Workspace");
    expect(html).not.toContain("source contents");
  });

  it("shows blocked state without raw findings", () => {
    const secret = `sk-${"x".repeat(24)}`;
    const html = renderAgentChangeReviewHtml({
      schemaVersion: 2,
      runId: "synthetic-run",
      changes: [{
        kind: "created",
        relpath: "generated.txt",
        eligibility: "cannot-apply",
        eligibilityReason: "sensitive-output",
      }],
      security: {
        safe: false,
        findingCounts: { "api-key": 1 },
        highRiskFindingCount: 1,
        uninspectableFileCount: 0,
      },
      applyAllowed: false,
      blockers: ["sensitive-output"],
    });
    expect(html).toContain("Cannot apply changes");
    expect(html).toContain("Secret or sensitive data detected");
    expect(html).not.toContain(secret);
  });

  it("explains why pseudonymized files cannot be applied", () => {
    const html = renderAgentChangeReviewHtml({
      schemaVersion: 2,
      runId: "synthetic-run",
      changes: [{
        kind: "modified",
        relpath: "records.csv",
        eligibility: "cannot-apply",
        eligibilityReason: "pseudonymized-by-yuhi-no-reversible-mapping",
      }],
      security: {
        safe: true,
        findingCounts: {},
        highRiskFindingCount: 0,
        uninspectableFileCount: 0,
      },
      applyAllowed: false,
      blockers: ["ineligible-provenance"],
    });
    expect(html).toContain("This file was pseudonymized by Yuhi");
    expect(html).toContain("original mapping is not available");
  });
});
