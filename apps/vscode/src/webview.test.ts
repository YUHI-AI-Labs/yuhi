import { describe, it, expect } from "vitest";
import { renderSavingsHtml, type ReviewData } from "./webview.js";

function data(over: Partial<ReviewData["report"]> = {}): ReviewData {
  return {
    project: "demo",
    agent: "Claude Code",
    runId: "abc",
    outcome: "Complete",
    osSandboxEnabled: false,
    outDir: ".yuhi/prepared/abc",
    report: {
      beforeTokens: 8208,
      afterTokens: 533,
      tokensSaved: 7675,
      percentReduction: 0.94,
      hasData: true,
      filesExcluded: 3,
      filesSummarized: 5,
      sensitiveMasked: 1,
      sourceModified: 0,
      approx: true,
      ...over,
    },
    metrics: {
      filesInspected: 2, filesWithSensitiveFindings: 1,
      filesSentUnchanged: 0, filesPreparedLocally: 1, preparedFilesModified: 1,
      filesSummarized: 1, filesPseudonymized: 1, filesWithMaskedValues: 1,
      filesKeptLocal: 1, filesExcluded: 0, sensitiveFilesExcluded: 1,
      sensitiveFindings: 1, sensitiveValuesMasked: 1, unresolvedHighRiskFindings: 0,
      findingsByCategory: { credential: 1 }, estimatedTokensBefore: 8208,
      estimatedTokensAfter: 533, estimatedTokensAvoided: 7675,
      estimatedReductionPercent: 94, originalSourceFilesModified: 0,
    },
    runtime: {
      initialContextPrepared: true,
      startDirectory: "prepared-workspace", workspaceInstructionPresent: true,
      workspaceBoundary: "advisory", filesystemEnforcement: "none",
      osSandboxEnabled: false, externalPathAccessPossible: true,
    },
    files: [
      {
        path: "meeting-log.md", action: "prepare-locally", status: "ok", omitted: false,
        beforeTokens: 8000, afterTokens: 400, diffable: true, sensitivity: "Confidential",
        findingCategoryCounts: {}, findingCount: 0, rule: "prepare", reason: "Prepared locally.",
        classificationSource: "explicit-rule", included: true,
        claudeReceives: "Transformed", transformed: true,
        transformations: ["summarized", "pseudonymized", "masked"], unresolvedHighRiskCount: 0,
      },
      {
        path: "private/.env", action: "local-only", status: "skipped", omitted: true,
        beforeTokens: 10, afterTokens: 0, diffable: false, sensitivity: "Restricted",
        findingCategoryCounts: { credential: 1 }, findingCount: 1, rule: "private", reason: "Kept local.",
        classificationSource: "explicit-rule", included: false,
        claudeReceives: "No", transformed: false, transformations: [], unresolvedHighRiskCount: 0,
      },
    ],
    preparedTree: [".yuhi/PREPARED_WORKSPACE.md", ".yuhi/session.json", "manifest.json", "meeting-log.md"],
  };
}

describe("renderSavingsHtml (Context Savings)", () => {
  const html = renderSavingsHtml(data(), "vscode-resource:", "NONCE123");

  it("leads with Estimated Claude input avoided and shows all required metrics", () => {
    expect(html).toContain("Estimated tokens avoided");
    expect(html).toContain("Estimated input before");
    expect(html).toContain("Estimated input after");
    expect(html).toContain("Original source files modified:");
    expect(html).toMatch(/summarized|Summarized/);
    expect(html).toMatch(/excluded/i);
    expect(html).toMatch(/masked/i);
  });

  it("carries the honest increase + unavailable branches (no clamping)", () => {
    expect(html).toContain("INCREASED");
    expect(html).toContain("unavailable");
  });

  it("retains the billing disclaimer and never promises savings", () => {
    expect(html).toContain("Actual model input usage may differ");
    expect(html.toLowerCase()).not.toContain("guaranteed");
  });

  it("shows the exact prepared tree and transformation labels", () => {
    expect(html).toContain("What Claude Code receives");
    expect(html).toContain("transformations.join");
    expect(html).toContain("DATA.preparedTree");
    expect(html).toContain(".yuhi/session.json");
  });

  it("renders all required file-decision columns and filters", () => {
    for (const label of [
      "File", "Sensitivity", "Yuhi action", "Rule", "Reason", "Included", "Transformed", "Claude receives",
      "Included", "Transformed", "Masked", "Excluded", "Kept local", "Unresolved high risk",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("classificationSource");
    expect(html).toContain("unresolvedHighRiskCount");
  });

  it("states the advisory runtime boundary without claiming confinement", () => {
    expect(html).toContain("Workspace boundary: advisory");
    expect(html).toContain("External-path access");
    expect(html).toContain("May still be possible");
    expect(html).toContain("OS sandbox");
    expect(html).not.toContain("Claude cannot access");
    expect(html).not.toContain("confined");
  });

  it("is CSP-locked with a nonce and no external sources", () => {
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("nonce-NONCE123");
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(js|css)/); // no external script/style
  });

  it("embeds only metadata (paths/tokens), never <think> or raw secret values", () => {
    expect(html).not.toContain("<think>");
    // The data model carries no file contents — only paths + token counts.
    const json = data();
    expect(JSON.stringify(json.files)).not.toMatch(/API_KEY|sk-/);
  });

  it("escapes embedded JSON so it cannot break out of the script", () => {
    const evil = renderSavingsHtml({ ...data(), project: "</script><script>x" }, "", "N");
    expect(evil).not.toContain("</script><script>x");
  });
});
