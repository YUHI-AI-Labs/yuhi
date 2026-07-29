import { describe, it, expect } from "vitest";
import { renderSavingsHtml, type ReviewData } from "./webview.js";

function data(over: Partial<ReviewData["report"]> = {}): ReviewData {
  return {
    launchDecisionEnabled: true,
    openClaudeHereEnabled: false,
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
      workspaceBoundary: "enforced", filesystemEnforcement: "claude-code-sandbox",
      osSandboxEnabled: true, externalPathAccessPossible: false,
    },
    acceptance: {
      entitiesPseudonymized: 100,
      identifierColumnsTransformed: 3,
      analyticalColumnsPreserved: 26,
      postTransformScanPassed: true,
      malformedTables: 0,
      unverifiedTransformations: 0,
      rawFallbackUsed: false,
      launchAllowed: true,
      claudeCodeStarted: false,
    },
    files: [
      {
        path: "meeting-log.md", action: "prepare-locally", status: "ok", omitted: false,
        beforeTokens: 8000, afterTokens: 400, diffable: true, sensitivity: "Confidential",
        findingCategoryCounts: {}, findingCount: 0, rule: "prepare", reason: "Prepared locally.",
        classificationSource: "explicit-rule", included: true,
        claudeReceives: "Transformed", transformed: true,
        transformations: ["summarized", "pseudonymized", "masked"], unresolvedHighRiskCount: 0,
        outcome: "included-transformed", fileType: "TEXT", inspectionStatus: "Verified",
        limitationShown: false,
      },
      {
        path: "private/.env", action: "local-only", status: "skipped", omitted: true,
        beforeTokens: 10, afterTokens: 0, diffable: false, sensitivity: "Restricted",
        findingCategoryCounts: { credential: 1 }, findingCount: 1, rule: "private", reason: "Kept local.",
        classificationSource: "explicit-rule", included: false,
        claudeReceives: "No", transformed: false, transformations: [], unresolvedHighRiskCount: 0,
        outcome: "local-only-unverified", fileType: "TEXT", inspectionStatus: "Verified",
        limitationShown: false,
      },
    ],
    projectFiles: ["meeting-log.md"],
    metadataFiles: [".yuhi/PREPARED_WORKSPACE.md", ".yuhi/session.json", "manifest.json"],
    preparedTree: [".yuhi/PREPARED_WORKSPACE.md", ".yuhi/session.json", "manifest.json", "meeting-log.md"],
  };
}

describe("renderSavingsHtml (product workflow)", () => {
  const html = renderSavingsHtml(data(), "vscode-resource:", "NONCE123");

  it("leads with a clear result and primary next action", () => {
    expect(html).toContain("Ready for Claude Code");
    expect(html).toContain("Your original workspace was not modified.");
    expect(html).toContain("Open with Claude Code");
    expect(html).toContain("View files");
    expect(html).toContain("Claude Code will start in the Prepared Workspace.");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Prepared locally for files");
  });

  it("does not render a dead launch action in standalone review mode", () => {
    const standalone = renderSavingsHtml(
      { ...data(), launchDecisionEnabled: false },
      "vscode-resource:",
      "NONCE123",
    );
    expect(standalone).toContain(">Close</button>");
    expect(standalone).not.toContain(">Open with Claude Code</button>");
  });

  it("offers a functional Claude action when reviewing inside a Prepared Workspace", () => {
    const prepared = renderSavingsHtml(
      { ...data(), launchDecisionEnabled: false, openClaudeHereEnabled: true },
      "vscode-resource:",
      "NONCE123",
    );
    expect(prepared).toContain(">Open Claude Code</button>");
    expect(prepared).toContain('send("openClaudeHere")');
  });

  it("separates project files from generated Yuhi metadata", () => {
    expect(html).toContain("Claude Code will receive");
    expect(html).toContain("Project files");
    expect(html).toContain("Yuhi metadata · ");
    expect(html).toContain("DATA.projectFiles.length");
    expect(html).toContain("DATA.metadataFiles.length");
    expect(html).toContain("not part of your project source");
  });

  it("shows one honest reduction metric with zero and negative explanations", () => {
    expect(html).toContain("Estimated context reduction");
    expect(html).toContain("estimated tokens");
    expect(html).toContain("No reduction was applied because all included files were kept unchanged.");
    expect(html).toContain("Prepared content is larger than the original estimate.");
    expect(html).not.toContain("Estimated tokens avoided");
  });

  it("retains the usage disclaimer and never promises billing savings", () => {
    expect(html).toContain("Actual agent usage may differ");
    expect(html).toContain("not a billing or cost-savings measurement");
    expect(html.toLowerCase()).not.toContain("guaranteed");
  });

  it("shows the actual prepared project and metadata lists", () => {
    expect(html).toContain("actual Prepared Workspace, not your original workspace");
    expect(html).toContain("DATA.projectFiles");
    expect(html).toContain("DATA.metadataFiles");
    expect(html).toContain(".yuhi/session.json");
  });

  it("shows Restricted tabular decisions using counts and safe action labels only", () => {
    const fixture = data();
    fixture.files = [{
      path: "synthetic-grades.csv", action: "prepare-locally", status: "ok", omitted: false,
      beforeTokens: 100, afterTokens: 90, diffable: true, sensitivity: "Restricted",
      findingCategoryCounts: { "direct-identifier-column": 3, "education-performance": 1 },
      findingCount: 4, rule: "detector:tabular-auto-pseudonymize",
      reason: "Sensitive tabular data transformed and rescanned locally.",
      classificationSource: "scanner-finding", included: true,
      claudeReceives: "Transformed", transformed: true,
      transformations: ["pseudonymized", "masked"], unresolvedHighRiskCount: 0,
    }];
    const rendered = renderSavingsHtml(fixture, "vscode-resource:", "NONCE123");
    expect(rendered).toContain("Restricted tabular data transformed locally");
    expect(rendered).toContain("Entities pseudonymized");
    expect(rendered).toContain("Identifier columns transformed");
    expect(rendered).toContain("Analytical columns preserved");
    expect(rendered).toContain("Raw fallback used");
    expect(rendered).toContain("Original source modified");
    expect(rendered).toContain("Verified transformed copy");
    expect(rendered).toContain("Post-transformation scan");
    expect(rendered).not.toContain("Synthetic Person");
    expect(rendered).not.toContain("S-1001");
  });

  it("blocks launch and offers explicit recovery for Partial preparation", () => {
    const fixture = data();
    fixture.outcome = "Partial";
    fixture.launchDecisionEnabled = false;
    fixture.acceptance = {
      ...fixture.acceptance,
      malformedTables: 2,
      unverifiedTransformations: 1,
      postTransformScanPassed: false,
      launchAllowed: false,
    };
    const rendered = renderSavingsHtml(fixture, "vscode-resource:", "NONCE123");
    expect(rendered).toContain("Preparation incomplete");
    expect(rendered).toContain("Malformed tables");
    expect(rendered).toContain("Unverified transformations");
    expect(rendered).toContain("Raw fallback used");
    expect(rendered).toContain("Claude Code started");
    expect(rendered).toContain("Some files could not be safely prepared. Claude Code was not started.");
    expect(rendered).toContain("Exclude blocked files and prepare again");
    expect(rendered).toContain("Review blocked files");
    expect(rendered).toContain("Choose another source folder");
    expect(rendered).not.toContain(">Open with Claude Code</button>");
  });

  it("renders unsupported PDF and unresolved XLSX limitations without private filenames", () => {
    const fixture = data();
    fixture.outcome = "Partial";
    fixture.launchDecisionEnabled = false;
    fixture.acceptance = {
      ...fixture.acceptance,
      unsupportedOrUnverifiedFiles: 2,
      restrictedUnresolvedFiles: 1,
      unverifiedTransformations: 1,
      hasLimitations: true,
      launchAllowed: false,
    };
    fixture.files = [
      {
        ...fixture.files[0]!,
        path: "Unsupported file 1",
        action: "local-only",
        status: "skipped",
        omitted: true,
        included: false,
        claudeReceives: "No",
        transformed: false,
        transformations: [],
        sensitivity: "Unknown",
        outcome: "local-only-unsupported",
        fileType: "PDF",
        inspectionStatus: "Not available",
        limitationShown: true,
      },
      {
        ...fixture.files[0]!,
        path: "Blocked file 1",
        action: "local-only",
        status: "error",
        omitted: true,
        included: false,
        claudeReceives: "No",
        transformed: false,
        transformations: [],
        sensitivity: "Restricted",
        outcome: "local-only-unverified",
        fileType: "XLSX",
        inspectionStatus: "Not available",
        limitationShown: true,
      },
    ];
    const rendered = renderSavingsHtml(fixture, "vscode-resource:", "NONCE123");
    expect(rendered).toContain("File kept local");
    expect(rendered).toContain("Restricted workbook kept local");
    expect(rendered).toContain("No verified local PDF inspection is available");
    expect(rendered).toContain("Unresolved high-risk data");
    expect(rendered).toContain("Some files could not be safely inspected or transformed.");
    expect(rendered).not.toContain("private-report.pdf");
    expect(rendered).not.toContain("student-records.xlsx");
  });

  it("uses simple default columns and user-facing actions", () => {
    for (const label of [
      "File", "Yuhi action", "Claude receives", "Why", "Included unchanged",
      "Masked", "Summarized", "Pseudonymized", "Kept local", "Excluded",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("<span>Sensitivity</span>");
    expect(html).not.toContain("<span>Rule</span>");
  });

  it("states the enforced runtime boundary once in primary UI", () => {
    const notice = "Yuhi prepared the initial context. Claude Code sandbox policy is enforced.";
    expect(html.split(notice)).toHaveLength(2);
    expect(html).toContain("Workspace boundary");
    expect(html).toContain("Enforced");
    expect(html).toContain("External-path access");
    expect(html).toContain("Blocked by policy");
    expect(html).not.toContain("Claude cannot access");
    expect(html).not.toContain("confined");
  });

  it("collapses metadata, runtime, and advanced details by default", () => {
    expect(html).toContain('<details class="metadata">');
    expect(html).toContain("<summary>Advanced details</summary>");
    expect(html).toContain("<summary>Full file decisions</summary>");
    expect(html).not.toContain("<details open");
  });

  it("supports narrow windows and long path tooltips without page overflow", () => {
    expect(html).toContain("overflow-x:hidden");
    expect(html).toContain("@media(max-width:800px)");
    expect(html).toContain("@media(max-width:520px)");
    expect(html).toContain('title="\'+esc(f.path)+\'"');
    expect(html).toContain("text-overflow:ellipsis");
  });

  it("is CSP-locked with a nonce and no external sources", () => {
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("nonce-NONCE123");
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(js|css)/);
  });

  it("embeds only metadata, never file contents or raw secret values", () => {
    expect(html).not.toContain("<think>");
    expect(JSON.stringify(data().files)).not.toMatch(/API_KEY|sk-/);
  });

  it("escapes embedded JSON so it cannot break out of the script", () => {
    const evil = renderSavingsHtml({ ...data(), project: "</script><script>x" }, "", "N");
    expect(evil).not.toContain("</script><script>x");
  });
});
