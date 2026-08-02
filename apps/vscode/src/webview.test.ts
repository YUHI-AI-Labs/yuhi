import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { renderSavingsHtml, type ReviewData } from "./webview.js";
import type { CompressionReport } from "@yuhi/core";
import {
  repositoryReadyClipboardText,
  repositoryReadyExportText,
  REPOSITORY_READY_EXPORT_FORMATS,
} from "./repository-ready.js";

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
      workspaceBoundary: "advisory", filesystemEnforcement: "claude-code-sandbox",
      osSandboxEnabled: true, externalPathAccessPossible: true,
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
    expect(html).toContain("Yuhi prepared everything it safely could. You can continue now.");
    expect(html).toContain("Open with Claude Code");
    expect(html).toContain("Show details");
    expect(html).toContain("Your workspace is ready.");
    expect(html).toContain("Nothing has been sent yet.");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Prepared locally for files");
    expect(html).not.toContain("LIMITED");
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
    expect(rendered).toContain("Some files need attention.");
    expect(rendered).toContain("Retry protection");
    expect(rendered).toContain("Technical reason");
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
    // Kept-local detail states what happened and what follows — never a bare
    // "Unknown verification failure", which reads to a user as "Yuhi is broken".
    expect(rendered).toContain("Not verified yet");
    expect(rendered).toContain("This PDF hasn't been verified yet."); // PDF reason
    expect(rendered).toContain("Yuhi could not verify this file's contents yet.");
    expect(rendered).not.toContain("Unknown verification failure");
    expect(rendered).toContain("Some files need attention.");
    // Never leaks a private source filename that the caller did not put in the data.
    expect(rendered).not.toContain("private-report.pdf");
    expect(rendered).not.toContain("student-records.xlsx");
  });

  it("renders unverified included files as launchable warnings", () => {
    const fixture = data();
    fixture.metrics = {
      ...fixture.metrics,
      filesSentUnchanged: 2,
      filesKeptLocal: 0,
      filesExcluded: 0,
      unresolvedHighRiskFindings: 0,
    };
    fixture.acceptance = {
      ...fixture.acceptance,
      unsupportedOrUnverifiedFiles: 2,
      hasLimitations: true,
      launchAllowed: true,
    };
    fixture.files = [
      {
        ...fixture.files[0]!,
        path: "report.pdf",
        action: "allow",
        status: "ok",
        omitted: false,
        included: true,
        claudeReceives: "Unchanged",
        transformed: false,
        transformations: [],
        sensitivity: "Unknown",
        outcome: "included-unverified",
        fileType: "PDF",
        inspectionStatus: "Not available",
        limitationShown: true,
      },
      {
        ...fixture.files[0]!,
        path: "model.bin",
        action: "allow",
        status: "ok",
        omitted: false,
        included: true,
        claudeReceives: "Unchanged",
        transformed: false,
        transformations: [],
        sensitivity: "Unknown",
        outcome: "included-unverified",
        fileType: "BINARY",
        inspectionStatus: "Not available",
        limitationShown: true,
      },
    ];
    fixture.projectFiles = ["report.pdf", "model.bin"];
    fixture.preparedTree = [...fixture.projectFiles, ...fixture.metadataFiles];

    const rendered = renderSavingsHtml(fixture, "vscode-resource:", "NONCE123");
    // A pending PDF (background) + a binary (included unchanged) are NOT warnings:
    // nothing needs review, so the headline stays plain READY.
    expect(rendered).toContain("READY");
    expect(rendered).not.toContain("WITH WARNINGS");
    expect(rendered).toContain("Included unchanged");
    expect(rendered).toContain("Original file");
    expect(rendered).toContain("Open with Claude Code");
    expect(rendered).not.toContain("Claude Code cannot start yet");
  });

  it("answers 'safe to start now' and treats pending PDFs as progress, not warnings", () => {
    const fixture = data();
    fixture.backgroundDocumentsPending = 2;
    // No files kept local => nothing needs review => plain READY.
    fixture.metrics = { ...fixture.metrics, filesKeptLocal: 0, filesExcluded: 0 };
    fixture.acceptance = { ...fixture.acceptance, hasLimitations: false, launchAllowed: true };
    fixture.files = [
      {
        ...fixture.files[0]!,
        path: "report.pdf",
        action: "allow",
        omitted: false,
        included: true,
        claudeReceives: "Unchanged",
        transformed: false,
        transformations: [],
        sensitivity: "Unknown",
        outcome: "included-unverified",
        fileType: "PDF",
        // documentStatus intentionally absent => still queued for background inspection.
      },
    ];
    fixture.projectFiles = ["report.pdf"];
    fixture.preparedTree = [...fixture.projectFiles, ...fixture.metadataFiles];
    const rendered = renderSavingsHtml(fixture, "vscode-resource:", "NONCE123");
    // Server-side truths: the count is injected, and a deferred PDF is progress,
    // so the headline stays plain READY (never "READY WITH WARNINGS").
    expect(rendered).toContain("const backgroundPending=2");
    expect(rendered).not.toContain("WITH WARNINGS");
    expect(rendered).toContain(">Open with Claude Code</button>");
    // Reassurance + progress copy exist in the panel.
    expect(rendered).toContain("Safe to start now.");
    expect(rendered).toContain("Document inspection keeps running in the background");
    expect(rendered).toContain("in the background");
  });

  it("shows a real unverified file as 'included unchanged' with a human type and honest reason", () => {
    const fixture = data();
    fixture.metrics = { ...fixture.metrics, filesKeptLocal: 0, filesExcluded: 0 };
    fixture.acceptance = { ...fixture.acceptance, launchAllowed: true };
    fixture.files = [
      {
        ...fixture.files[0]!,
        path: "health.csv",
        action: "allow",
        omitted: false,
        included: true,
        claudeReceives: "Unchanged",
        transformed: false,
        transformations: [],
        sensitivity: "Unknown",
        outcome: "included-unverified",
        fileType: "XLSX",
        failureCategory: "structural",
      },
    ];
    fixture.projectFiles = ["health.csv"];
    fixture.preparedTree = [...fixture.projectFiles, ...fixture.metadataFiles];
    const rendered = renderSavingsHtml(fixture, "vscode-resource:", "NONCE123");
    // Non-sensitive unverified file => "included unchanged", not a headline warning.
    expect(rendered).toContain("READY");
    expect(rendered).not.toContain("WITH WARNINGS");
    expect(rendered).toContain("const backgroundPending=0");
    expect(rendered).toContain("Included unchanged");
    // Human label + differentiated reason (never "XLSX"/"Unknown" or a blanket
    // "Not verified / Not applied").
    expect(rendered).toContain("Excel workbook");
    expect(rendered).toContain("Structure could not be parsed");
    expect(rendered).toContain("Included with warning");
  });

  it("shows metadata-only local document inspection counts", () => {
    const fixture = data();
    fixture.acceptance = {
      ...fixture.acceptance,
      pdfInspected: 5,
      ocrProcessed: 2,
      unverifiedDocuments: 1,
      documentSummariesCreated: 3,
      documentSummariesRejected: 1,
      documentContextBeforeTokens: 180_000,
      documentContextAfterTokens: 65_000,
      agentHandoffCreated: true,
      localModelProvider: "ollama",
      localModelName: "qwen3:1.7b",
      localModelRequests: 7,
      localModelSucceeded: 7,
      localModelFailed: 0,
      localModelInputChars: 24_000,
      localModelOutputChars: 3_200,
      localModelElapsedMs: 14_000,
      hasLimitations: true,
    };
    const rendered = renderSavingsHtml(fixture, "vscode-resource:", "NONCE123");
    expect(rendered).toContain("Document inspection");
    expect(rendered).toContain("PDF text extraction completed");
    expect(rendered).toContain("PDFs scanned with OCR");
    expect(rendered).toContain("PDFs not fully inspected");
    expect(rendered).toContain("Extracted text is used only for the security scan and is not stored or uploaded");
    expect(rendered).toContain("What Yuhi did");
    expect(rendered).toContain("Context preparation");
    expect(rendered).toContain("Context summaries created");
    expect(rendered).toContain("Estimated original document context");
    expect(rendered).toContain("Agent handoff");
    expect(rendered).toContain("Yuhi processing activity");
    expect(rendered).toContain("Local processing requests");
    expect(rendered).not.toContain("qwen3:1.7b");
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

  it("states an advisory runtime boundary once and never claims OS-level enforcement", () => {
    const notice =
      "Yuhi prepared the initial context. This is an advisory workspace boundary, not an OS-level sandbox.";
    expect(html.split(notice)).toHaveLength(2);
    expect(html).toContain("Workspace boundary");
    expect(html).toContain("Advisory");
    expect(html).toContain("External-path access");
    expect(html).toContain("May still be possible");
    // No guarantee wording may survive anywhere in the rendered UI.
    expect(html).not.toContain("policy is enforced");
    expect(html).not.toContain("re-allows only");
    expect(html).not.toContain("Launch fails if the sandbox");
    expect(html).not.toContain("Claude cannot access");
    expect(html).not.toContain("confined");
  });

  it("collapses metadata, runtime, and advanced details by default", () => {
    expect(html).toContain('<details class="metadata">');
    expect(html).toContain("<summary>Technical details</summary>");
    expect(html).toContain("<summary>Full file decisions</summary>");
    expect(html).not.toContain("<details open");
  });

  it("presents kept-local files as 'kept on this computer' without blocking launch", () => {
    const fixture = data();
    fixture.acceptance = {
      ...fixture.acceptance,
      hasLimitations: true,
      unsupportedOrUnverifiedFiles: 3,
    };
    fixture.metrics.filesKeptLocal = 3;
    const rendered = renderSavingsHtml(fixture, "vscode-resource:", "NONCE123");
    // Recommend, don't trap: excluded files keep the headline plain READY.
    expect(rendered).toContain("READY");
    expect(rendered).not.toContain("WITH WARNINGS");
    expect(rendered).toContain("Ready for Claude Code");
    expect(rendered).toContain("Kept on this computer");
    expect(rendered).toContain(">Open with Claude Code</button>"); // launch still allowed
    expect(rendered).not.toContain("LIMITED");
    expect(rendered).not.toContain("Preparation was limited");
  });

  it("shows credential protection as a ready workflow without exposing values", () => {
    const fixture = data();
    fixture.files = [{
      ...fixture.files[0]!,
      path: ".env",
      rule: "yuhi:environment-sanitized-copy",
      transformed: true,
      transformations: ["masked"],
      claudeReceives: "Transformed",
    }];
    fixture.projectFiles = [".env"];
    fixture.metrics.sensitiveValuesMasked = 2;
    const rendered = renderSavingsHtml(fixture, "vscode-resource:", "NONCE123");
    expect(rendered).toContain("Ready for Claude Code");
    expect(rendered).toContain("Sensitive values handled");
    expect(rendered).toContain("Runtime configuration preserved");
    expect(rendered).toContain("Credential configuration prepared locally");
    expect(rendered).toContain("Safe copies verified");
    expect(rendered).toContain("Credential values");
    expect(rendered).toContain("Not included in Prepared Workspace");
    expect(rendered).toContain("runtime environment");
    expect(rendered).toContain("Prepared copy");
    expect(rendered).toContain("Created");
    expect(rendered).not.toMatch(/sk-[A-Za-z0-9_-]+/);
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

  it("omits the Repository Ready card when no preparation report is supplied", () => {
    expect(html).not.toContain('id="repositoryReady"');
    expect(html).not.toContain("Copy public report");
  });

  it("surfaces a public-safe Repository Ready card + copy/export when a report is present", () => {
    const rendered = renderSavingsHtml(
      {
        ...data(),
        preparationReport: {
          sourceFiles: 128,
          preparedArtifacts: 131,
          documentsPrepared: 4,
          secretsBlocked: 7,
          identifiersTransformed: 2165,
          largeFilesExcluded: 0,
          estimatedReductionPercent: 94,
          status: "ready",
          safetyMode: "balanced",
        },
      },
      "vscode-resource:",
      "NONCE123",
    );
    // The card, its metrics, and the honest reduction caveat are shown.
    expect(rendered).toContain('id="repositoryReady"');
    expect(rendered).toContain("Repository Ready");
    expect(rendered).toContain("Prepared artifacts");
    expect(rendered).toContain("2,165");
    expect(rendered).toContain("Estimated repository reduction");
    expect(rendered).toContain("agent-accessible content, not model token savings");
    // Copy/export exist and are click-wired to post their id back to the host.
    // Assert the behavioural contract (button id present + referenced by a click
    // handler that posts a message), NOT the exact wiring syntax — so refactors
    // like `const sendCopy = () => send("copyPublicReport")` don't break the test.
    expect(rendered).toContain('id="copyPublicReport"');
    expect(rendered).toContain('id="exportPublicReport"');
    for (const id of ["copyPublicReport", "exportPublicReport"]) {
      expect(rendered).toMatch(new RegExp(`["'\`]${id}["'\`]`)); // id referenced in the script
    }
    expect(rendered).toMatch(/addEventListener\(["']click["']/); // buttons are click-wired
    expect(rendered).toContain("postMessage"); // clicks post back to the extension host
    // The card fragment itself carries only aggregate numbers — the card's
    // public-safety is asserted directly in repository-ready.test.ts.
    // Bound the fragment to the Repository Ready card's actual next sibling. The
    // read-only "What the AI Can See" section (id="whatAiCanSee") now sits between
    // this card and "What Yuhi did" and legitimately shows paths inside the webview;
    // this slice must isolate the CARD, whose public-safety we assert here.
    const card = rendered.slice(
      rendered.indexOf('id="repositoryReady"'),
      rendered.indexOf('id="whatAiCanSee"'),
    );
    expect(card).not.toContain("meeting-log.md");
    expect(card).not.toContain(".yuhi/prepared/abc");
  });
});

// v0.3 Phase 2b-2a — "What the AI Can See": a READ-ONLY, at-a-glance review.
describe("What the AI Can See (read-only review)", () => {
  const file = (over: Partial<ReviewData["files"][number]>): ReviewData["files"][number] => ({
    path: "src/file.ts",
    action: "allow",
    status: "ok",
    omitted: false,
    beforeTokens: 100,
    afterTokens: 100,
    diffable: false,
    sensitivity: "Unknown",
    findingCategoryCounts: {},
    findingCount: 0,
    rule: "preparation result",
    reason: "Included unchanged.",
    classificationSource: "fallback",
    included: true,
    claudeReceives: "Unchanged",
    transformed: false,
    transformations: [],
    unresolvedHighRiskCount: 0,
    ...over,
  });

  // A deliberate mix: available (transformed + unchanged + a delivered identifier
  // leak) and unavailable (excluded-by-user, excluded-by-policy, verification-failed).
  const mixed = (): ReviewData => {
    const fixture = data();
    fixture.files = [
      file({
        path: "src/summary.md", diffable: true, transformed: true,
        transformations: ["summarized"], claudeReceives: "Transformed",
        outcome: "included-transformed", reason: "Summarized locally.",
      }),
      file({
        path: "src/app.ts", claudeReceives: "Unchanged",
        outcome: "included-unverified", reason: "Included unchanged.",
      }),
      file({
        path: "data/grades.csv", transformed: true, transformations: ["pseudonymized"],
        claudeReceives: "Transformed", outcome: "included-transformed",
        failureCategory: "reidentification-risk", limitationShown: true,
        reason: "Delivered with a de-identification warning.",
      }),
      file({
        path: "notes/personal.txt", included: false, omitted: true, action: "local-only",
        status: "skipped", claudeReceives: "No", outcome: "excluded-by-user",
        reason: "Excluded by user.",
      }),
      file({
        path: "config/prod.env", included: false, omitted: true, action: "local-only",
        status: "skipped", claudeReceives: "No", outcome: "excluded-by-policy",
        reason: "Excluded by policy.",
      }),
      file({
        path: "db/dump.sql", included: false, omitted: true, action: "local-only",
        status: "error", claudeReceives: "No", outcome: "local-only-unverified",
        failureCategory: "unresolved-secret", sensitivity: "Restricted",
        reason: "Kept local — verification failed.",
      }),
    ];
    fixture.projectFiles = ["src/summary.md", "src/app.ts", "data/grades.csv"];
    return fixture;
  };

  const availableSlice = (html: string): string =>
    html.slice(html.indexOf('id="aiSeeAvailable"'), html.indexOf('id="aiSeeUnavailable"'));
  const unavailableSlice = (html: string): string =>
    html.slice(html.indexOf('id="aiSeeUnavailable"'), html.indexOf("</details>", html.indexOf('id="aiSeeUnavailable"')));

  it("renders the section collapsed with the applied Safety Mode and Context Detail", () => {
    const html = renderSavingsHtml(mixed(), "vscode-resource:", "NONCE123");
    expect(html).toContain('id="whatAiCanSee"');
    // Collapsed by default: the section's <details> has no open attribute.
    expect(html).toMatch(/<details[^>]*id="whatAiCanSee"(?![^>]*\bopen\b)/);
    expect(html).toContain('id="aiSeeDisclosureSafetyMode"');
    expect(html).toContain('id="aiSeeContextDetail"');
    // Honest: labelled as applied defaults, not live selectors.
    expect(html).toContain("applied default");
  });

  it("shows a one-glance available/kept split with correct bucket counts", () => {
    const html = renderSavingsHtml(mixed(), "vscode-resource:", "NONCE123");
    // 3 available (transformed + unchanged + delivered-with-warning) · 3 kept.
    expect(html).toContain("3 available to the AI · 3 kept on your machine");
    const avail = availableSlice(html);
    const unavail = unavailableSlice(html);
    // Group headings carry the same counts.
    expect(avail).toContain("Available to the AI");
    expect(avail).toMatch(/Available to the AI\s*<span class="count">3<\/span>/);
    expect(unavail).toMatch(/Unavailable to the AI\s*<span class="count">3<\/span>/);
  });

  it("splits files into Available vs Unavailable and shows each Claude-receives value", () => {
    const html = renderSavingsHtml(mixed(), "vscode-resource:", "NONCE123");
    const avail = availableSlice(html);
    const unavail = unavailableSlice(html);
    // Available holds the delivered files; Unavailable holds the withheld ones.
    for (const p of ["src/summary.md", "src/app.ts", "data/grades.csv"]) {
      expect(avail).toContain(p);
      expect(unavail).not.toContain(p);
    }
    for (const p of ["notes/personal.txt", "config/prod.env", "db/dump.sql"]) {
      expect(unavail).toContain(p);
      expect(avail).not.toContain(p);
    }
    // Each file's "Claude receives" value is shown.
    expect(avail).toContain("Transformed");
    expect(avail).toContain("Unchanged");
    expect(unavail).toContain("Nothing");
  });

  it("offers a client-side filter with the read-only buckets and a diff affordance", () => {
    const html = renderSavingsHtml(mixed(), "vscode-resource:", "NONCE123");
    expect(html).toContain('id="aiSeeFilter"');
    for (const value of ["all", "available", "transformed", "unchanged", "excluded", "kept"]) {
      expect(html).toContain(`value="${value}"`);
    }
    // A diffable file exposes a diff affordance reusing the existing {type:"diff"} protocol.
    const avail = availableSlice(html);
    expect(avail).toContain('class="diff"');
    expect(avail).toContain('data-p="src/summary.md"');
    expect(html).toContain('type:"diff"');
  });

  it("distinguishes a delivered warning from a withheld failure", () => {
    const html = renderSavingsHtml(mixed(), "vscode-resource:", "NONCE123");
    // Distinct, machine-checkable markers (not literal wording).
    expect(html).toContain('data-kind="warning"');
    expect(html).toContain('data-kind="failure"');
    // The delivered-with-caveat warning lives in Available; the withheld failure in Unavailable.
    expect(availableSlice(html)).toContain('data-kind="warning"');
    expect(unavailableSlice(html)).toContain('data-kind="failure"');
    // A leak-free, launchable run (all files available, none withheld) must not
    // paint neutral files as failures/warnings.
    const calmFixture = data();
    calmFixture.files = [
      file({ path: "src/a.ts", claudeReceives: "Unchanged" }),
      file({ path: "src/b.ts", claudeReceives: "Transformed", transformed: true,
        transformations: ["summarized"], outcome: "included-transformed" }),
    ];
    const calm = renderSavingsHtml(calmFixture, "vscode-resource:", "NONCE123");
    expect(calm).toContain('data-kind="neutral"');
    expect(calm).not.toContain('data-kind="warning"');
    expect(calm).not.toContain('data-kind="failure"');
  });

  it("renders without throwing for a Partial run, zero files, and a very long path", () => {
    const partial = data();
    partial.outcome = "Partial";
    partial.launchDecisionEnabled = false;
    partial.acceptance = { ...partial.acceptance, launchAllowed: false };
    expect(() => renderSavingsHtml(partial, "vscode-resource:", "NONCE123")).not.toThrow();

    const empty = data();
    empty.files = [];
    empty.projectFiles = [];
    const emptyHtml = renderSavingsHtml(empty, "vscode-resource:", "NONCE123");
    expect(emptyHtml).toContain('id="whatAiCanSee"');
    expect(emptyHtml).toContain("0 available to the AI · 0 kept on your machine");
    expect(emptyHtml).toContain("No files to show.");

    const longPath = "src/" + "very-long-directory-segment/".repeat(30) + "deeply-nested-secret.env";
    const longFixture = data();
    longFixture.files = [file({ path: longPath, claudeReceives: "Unchanged" })];
    const longHtml = renderSavingsHtml(longFixture, "vscode-resource:", "NONCE123");
    // The long path is shown (truncation/ellipsis is CSS-driven) and does not break rendering.
    expect(longHtml).toContain(longPath);
    expect(longHtml).toContain("text-overflow:ellipsis");
  });

  it("keeps Copy/Export public-safe even when file paths contain real secret paths", () => {
    const secretPath = "/Users/victim/Documents/project/config/secret.env";
    const otherPath = "/Users/victim/private/.ssh/id_rsa";
    const fixture = data();
    fixture.preparationReport = {
      sourceFiles: 12, preparedArtifacts: 12, documentsPrepared: 0,
      secretsBlocked: 2, identifiersTransformed: 0, largeFilesExcluded: 0,
      estimatedReductionPercent: 40, status: "ready", safetyMode: "balanced",
    };
    fixture.files = [
      file({ path: secretPath, included: false, omitted: true, action: "local-only",
        status: "error", claudeReceives: "No", outcome: "local-only-unverified",
        failureCategory: "unresolved-secret" }),
      file({ path: otherPath, claudeReceives: "Unchanged" }),
    ];
    const rendered = renderSavingsHtml(fixture, "vscode-resource:", "NONCE123");
    // The webview surface may show the paths (it is the user's own local window)…
    expect(rendered).toContain(secretPath);
    // …but the PUBLIC copy/export bytes the host emits must contain NONE of them.
    const forbidden = [secretPath, otherPath, "secret.env", "id_rsa", "/Users/"];
    const copy = repositoryReadyClipboardText(fixture.preparationReport!);
    for (const bad of forbidden) expect(copy).not.toContain(bad);
    for (const { format } of REPOSITORY_READY_EXPORT_FORMATS) {
      const out = repositoryReadyExportText(fixture.preparationReport!, format);
      for (const bad of forbidden) expect(out).not.toContain(bad);
    }
  });
});

describe("Safety Mode selector (v0.3.2)", () => {
  const render = (over: Partial<ReviewData> = {}) =>
    renderSavingsHtml({ ...data(), ...over }, "vscode-resource:", "NONCE123");

  it("renders a selector with the three modes and selects the prepared run's mode", () => {
    const html = render({ preparedSafetyMode: "strict", selectedSafetyMode: "strict" });
    expect(html).toContain('id="safetyModeSelect"');
    expect(html).toContain('value="balanced"');
    expect(html).toContain('value="strict"');
    expect(html).toContain('value="maximum-privacy"');
    // The prepared mode is the selected <option>.
    expect(html).toContain('value="strict" selected');
    expect(html).not.toContain('value="balanced" selected');
    // Non-overclaiming descriptions accompany the options.
    expect(html).toContain("Recommended for most repositories.");
    expect(html).toContain("More conservative handling for business repositories.");
    expect(html).toContain("Shares the minimum context allowed by current Yuhi policies.");
  });

  it("shows a clean readiness + enabled launch when selected matches prepared", () => {
    const html = render({ preparedSafetyMode: "balanced", selectedSafetyMode: "balanced" });
    expect(html).not.toContain('id="safetyModeDirty"');
    expect(html).not.toContain("Re-prepare required");
    // Launch action is the live, clickable button (not disabled).
    expect(html).toContain('class="button primary launchAction"');
    expect(html).not.toContain('class="button primary" disabled');
  });

  it("shows the Re-prepare required banner and disables launch when modes differ", () => {
    const html = render({ preparedSafetyMode: "balanced", selectedSafetyMode: "strict" });
    expect(html).toContain('id="safetyModeDirty"');
    expect(html).toContain("Re-prepare required");
    expect(html).toContain("Prepared with: Balanced");
    expect(html).toContain("Selected: Strict");
    // The launch action is disabled and never wired to fire a launch.
    expect(html).toContain('class="button primary" disabled');
    expect(html).not.toContain('class="button primary launchAction"');
    // A Re-prepare action is offered.
    expect(html).toContain('id="reprepare"');
  });

  it("wires the selector to postMessage(setSafetyMode) and Re-prepare to reprepare", () => {
    const html = render({ preparedSafetyMode: "balanced", selectedSafetyMode: "strict" });
    // Structural wiring: the select posts setSafetyMode with its value.
    expect(html).toContain('getElementById("safetyModeSelect")');
    expect(html).toContain('type:"setSafetyMode"');
    // The Re-prepare button posts the reprepare message.
    expect(html).toContain('getElementById("reprepare")');
    expect(html).toContain('send("reprepare")');
  });

  it("does not route selector/dirty UI into the public report copy/export bytes", () => {
    const fixture: ReviewData = {
      ...data(),
      preparedSafetyMode: "balanced",
      selectedSafetyMode: "maximum-privacy",
      preparationReport: {
        sourceFiles: 3, preparedArtifacts: 3, documentsPrepared: 0,
        secretsBlocked: 0, identifiersTransformed: 0, largeFilesExcluded: 0,
        estimatedReductionPercent: 10, status: "ready", safetyMode: "balanced",
      },
    };
    // Sanity: the dirty banner exists in the local webview surface…
    const html = renderSavingsHtml(fixture, "vscode-resource:", "NONCE123");
    expect(html).toContain("Re-prepare required");
    // …but the PUBLIC copy/export bytes never carry the dirty/selector strings.
    const copy = repositoryReadyClipboardText(fixture.preparationReport!);
    for (const bad of ["Re-prepare required", "Selected:", "setSafetyMode", "reprepare"]) {
      expect(copy).not.toContain(bad);
    }
  });
});

// v0.3.3 — Context Compression section + settings.
describe("Context Compression section (v0.3.3)", () => {
  const compression = (over: Partial<CompressionReport> = {}): CompressionReport => ({
    originalTokens: 1_240_000,
    preparedTokens: 178_000,
    reductionPercent: 85.6,
    fullFiles: 64,
    compressedFiles: 126,
    excludedFiles: 842,
    compressionReductionTokens: 900_000,
    exclusionReductionTokens: 162_000,
    targetBudget: null,
    actualTokens: 178_000,
    status: "no-budget",
    warnings: [],
    files: [
      {
        relpath: "src/big.ts", representation: "compressed", reason: "structural-compression",
        originalTokens: 5_000, preparedTokens: 800,
      },
      {
        relpath: "src/tiny.ts", representation: "full", reason: "too-small",
        originalTokens: 100, preparedTokens: 100,
      },
      {
        relpath: "src/huge.ts", representation: "excluded", reason: "token-budget",
        originalTokens: 9_000, preparedTokens: 0,
      },
    ],
    ...over,
  });
  const render = (over: Partial<ReviewData> = {}) =>
    renderSavingsHtml({ ...data(), ...over }, "vscode-resource:", "NONCE123");

  it("renders the section with compact numbers when compression is present", () => {
    const html = render({ compression: compression() });
    expect(html).toContain('id="contextCompression"');
    expect(html).toContain(">Context Compression</h2>");
    // Compact k/M formatting like the existing metrics.
    expect(html).toContain("1.24M"); // Original
    expect(html).toContain("178K"); // Prepared
    expect(html).toContain("85.6%"); // Reduced
    expect(html).toContain("Full files");
    expect(html).toContain(">64<"); // fullFiles
    expect(html).toContain(">126<"); // compressedFiles
    expect(html).toContain(">842<"); // excludedFiles
  });

  it("is absent when no compression summary is present", () => {
    const html = render();
    // The visible section (its container + heading) is absent. (The client-side
    // diff-wiring comment mentions the feature name unconditionally, so assert the
    // section markup rather than the bare phrase.)
    expect(html).not.toContain('id="contextCompression"');
    expect(html).not.toContain(">Context Compression</h2>");
  });

  it("shows a Target/Actual/Reason line only for best-effort status", () => {
    const noBudget = render({ compression: compression() });
    expect(noBudget).not.toContain('id="compressionBudget"');

    const best = render({
      compression: compression({
        status: "best-effort",
        targetBudget: 150_000,
        actualTokens: 178_000,
        budgetReason: "Could not fit the budget without excluding entry points.",
      }),
    });
    expect(best).toContain('id="compressionBudget"');
    expect(best).toContain("Target 150K");
    expect(best).toContain("Actual 178K");
    expect(best).toContain("Could not fit the budget without excluding entry points.");
  });

  it("marks a compressed file as diffable via the existing {type:diff,path} protocol", () => {
    const html = render({ compression: compression() });
    // The compressed file is listed with a diff button carrying its relpath…
    expect(html).toContain('class="diff" data-p="src/big.ts"');
    expect(html).toContain("Compressed");
    // …and the section wires clicks to post the existing diff message (compare
    // original ↔ delivered compressed copy). No new message type is introduced.
    expect(html).toContain('getElementById("contextCompression")');
    expect(html).toContain('type:"diff"');
    // full / excluded files are NOT offered as compressed diffs.
    expect(html).not.toContain('data-p="src/tiny.ts"');
    expect(html).not.toContain('data-p="src/huge.ts"');
  });

  it("does not route compression per-file data into the public copy/export bytes", () => {
    const fixture: ReviewData = {
      ...data(),
      compression: compression(),
      preparationReport: {
        sourceFiles: 3, preparedArtifacts: 3, documentsPrepared: 0,
        secretsBlocked: 0, identifiersTransformed: 0, largeFilesExcluded: 0,
        estimatedReductionPercent: 10, status: "ready", safetyMode: "balanced",
      },
    };
    // The compressed relpath appears in the local webview surface…
    const html = renderSavingsHtml(fixture, "vscode-resource:", "NONCE123");
    expect(html).toContain("src/big.ts");
    // …but never in the PUBLIC copy/export bytes (aggregate-only report).
    const copy = repositoryReadyClipboardText(fixture.preparationReport!);
    for (const bad of ["src/big.ts", "src/huge.ts", "Context Compression", "structural-compression"]) {
      expect(copy).not.toContain(bad);
    }
    for (const format of REPOSITORY_READY_EXPORT_FORMATS) {
      const out = repositoryReadyExportText(fixture.preparationReport!, format.format);
      expect(out).not.toContain("src/big.ts");
      expect(out).not.toContain("structural-compression");
    }
  });
});

describe("Context Compression settings (v0.3.3)", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(process.cwd(), "apps/vscode/package.json"), "utf8"),
  ) as {
    contributes: {
      configuration: {
        properties: Record<string, { type: string; default: unknown; scope: string; description: string }>;
      };
    };
  };
  const props = manifest.contributes.configuration.properties;

  it("declares yuhi.compress (boolean, default true, resource-scoped)", () => {
    const compress = props["yuhi.compress"];
    expect(compress).toBeDefined();
    expect(compress?.type).toBe("boolean");
    expect(compress?.default).toBe(true);
    expect(compress?.scope).toBe("resource");
  });

  it("declares yuhi.tokenBudget (number, default 0 = No target, resource-scoped)", () => {
    const budget = props["yuhi.tokenBudget"];
    expect(budget).toBeDefined();
    expect(budget?.type).toBe("number");
    // Corrected default: Compression is ON (Auto) but the Token Budget has NO target
    // by default (0/blank). A budget only applies when the user sets a positive value.
    expect(budget?.default).toBe(0);
    expect(budget?.scope).toBe("resource");
    expect((budget as { minimum?: number })?.minimum).toBe(0);
    expect((budget as { maximum?: number })?.maximum).toBe(1_000_000_000);
  });

  it("fresh-workspace defaults are Balanced / Compression On (Auto) / No target", () => {
    // The unset-workspace default must be Balanced + compression On + No target.
    // Maximum Privacy and a token budget apply ONLY when the user chooses them.
    expect(props["yuhi.safetyMode"]?.default).toBe("balanced");
    expect(props["yuhi.compressionMode"]?.default).toBe("auto");
    expect(props["yuhi.tokenBudget"]?.default).toBe(0);
  });
});
