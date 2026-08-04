import { describe, it, expect } from "vitest";
import type { YuhiModeSummary } from "@yuhi/core";
import { renderActivityPanel, type ActivityPanelData } from "./activity-panel.js";

const CSP = "vscode-resource:";
const NONCE = "NONCE123";
const html = (d: ActivityPanelData) => renderActivityPanel(d, CSP, NONCE);

/** A YuhiModeSummary factory so the dashboard tests exercise the single-source object. */
function summary(overrides: {
  availability?: Partial<YuhiModeSummary["contextAvailability"]>;
  efficiency?: Partial<YuhiModeSummary["contextEfficiency"]>;
  background?: Partial<YuhiModeSummary["background"]>;
} = {}): YuhiModeSummary {
  return {
    schemaVersion: 1,
    launchStatus: "ready",
    agentCapabilities: { autoModeAvailable: true, selectedAgent: "Claude Code", sourceWriteRequiresReview: true },
    contextAvailability: {
      availableVerified: 0,
      availableWithWarning: 0,
      compactRepresentations: 0,
      companionsAdded: 0,
      knownRisksBlocked: 0,
      unavailableAfterFailure: 0,
      ...overrides.availability,
    },
    contextEfficiency: {
      compressionMode: "on",
      repositoryTokensBefore: null,
      repositoryTokensAfter: null,
      representationReductionTokens: null,
      representationReductionPercent: null,
      initialAgentContextTokens: null,
      compressedFiles: 0,
      largeArtifactsRepresented: 0,
      reductionByStructuralCompression: 0,
      reductionByLargeArtifactRepresentation: 0,
      reductionBySafetyTransformation: 0,
      ...overrides.efficiency,
    },
    background: {
      status: "idle",
      pending: 0,
      processing: 0,
      completed: 0,
      companionUnavailable: 0,
      contextUnavailable: 0,
      ...overrides.background,
    },
    protection: { originalWorkspaceModified: false, knownSecretsBlocked: 0, safeApplyRequired: true },
  };
}

describe("Yuhi activity panel (webview)", () => {
  it("surfaces a non-automatic Safe Patch Review action in Yuhi Mode", () => {
    const out = html({
      phase: "yuhi-mode",
      filesAvailable: 3,
      filesExcluded: 0,
      agentChangesDetected: true,
    });
    expect(out).toContain("AI changes detected");
    expect(out).toContain("Review changes");
    expect(out).toContain("Nothing is applied automatically");
    expect(out).toContain("reviewChanges");
  });
  it("is CSP-locked to a nonce with no external/inline script or style", () => {
    const out = html({ phase: "not-prepared" });
    expect(out).toContain("Content-Security-Policy");
    expect(out).toContain("script-src 'nonce-NONCE123'");
    expect(out).toContain("style-src 'nonce-NONCE123'");
    expect(out).toContain('<script nonce="NONCE123">');
    expect(out).toContain('<style nonce="NONCE123">');
    // No external URLs and no unsafe-inline.
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toContain("unsafe-inline");
  });

  it("uses only VS Code theme variables (no hard-coded light-theme hex as the primary color)", () => {
    const out = html({ phase: "ready", filesDiscovered: 3, documentsInspected: 1, summariesRejected: 0, contextIndex: true, agentHandoff: true });
    expect(out).toContain("var(--vscode-foreground)");
    expect(out).toContain("var(--vscode-button-background)");
    expect(out).toContain("var(--vscode-focusBorder)"); // visible focus state
  });

  it("renders a blue YUHI MODE panel with counts inside the Prepared Workspace", () => {
    const out = html({
      phase: "yuhi-mode", filesAvailable: 11, filesExcluded: 1, documentsPending: 1,
      claudeExtensionAvailable: true, maskedValues: 2165, reductionPercent: 82, filesTransformed: 3,
    });
    expect(out).toContain("YUHI MODE");
    expect(out).toContain("This window is the Prepared Workspace");
    expect(out).toContain("11 files available");
    expect(out).toContain("1 file kept on this computer");
    expect(out).toContain("1 document processing in the background");
    // Impact metrics are celebrated.
    expect(out).toContain("Yuhi protected your data");
    expect(out).toContain("2,165");
    expect(out).toContain("sensitive values masked");
    expect(out).toContain("82.0%");
    expect(out).toContain("Estimated context reduction");
    expect(out).toContain("files transformed");
    expect(out).toContain(">3<"); // the transformed-file count value
    expect(out).toContain("Open Claude Code");
    expect(out).toContain("Review files");
    // Blue accent via the charts-blue theme variable.
    expect(out).toContain("var(--vscode-charts-blue");
  });

  it("YUHI MODE offers Install when the Claude extension is absent", () => {
    const out = html({ phase: "yuhi-mode", filesAvailable: 3, filesExcluded: 0, claudeExtensionAvailable: false });
    expect(out).toContain("Install Claude Code");
  });

  it("empty state shows NO static numbers and offers Prepare", () => {
    const out = html({ phase: "not-prepared" });
    expect(out).not.toMatch(/\b24\b|\b\d+ files discovered\b|\b\d+ documents inspected\b/);
    expect(out).toContain("Prepare with Yuhi");
    expect(out).toContain('id="prepare"');
    expect(out).toMatch(/id="cfgCompressionMode"[^>]*>[\s\S]*?<option value="auto" selected>Auto \(Recommended\)<\/option>/);
    // Corrected default: Token Budget is blank (No target), not a hidden 200000 cap.
    expect(out).toMatch(/id="cfgBudget"[^>]*value=""/);
    expect(out).not.toMatch(/id="cfgBudget"[^>]*value="200000"/);
  });

  it("separates verified, warning-available, pending, and failed counts in Yuhi Mode", () => {
    const out = html({
      phase: "yuhi-mode",
      filesAvailable: 12,
      filesExcluded: 2,
      verifiedFiles: 8,
      warningFiles: 4,
      documentsPending: 3,
      processingFailedFiles: 1,
    });
    expect(out).toContain("8 verified");
    expect(out).toContain("4 available with warning");
    expect(out).toContain("3 documents processing in the background");
    expect(out).toContain("1 background processing failed");
  });

  it("disables Token Budget while compression is off and preserves its value", () => {
    const out = html({
      phase: "not-prepared",
      settings: { safetyMode: "balanced", compressionMode: "off", tokenBudget: 100_000, permissionMode: "standard", sandboxPreset: "guarded" },
    });
    expect(out).toMatch(/id="cfgBudget"[^>]*value="100000"[^>]*disabled/);
    expect(out).toContain("Enable Context Compression to set a token budget.");
  });

  it("enables Token Budget with compression and validates/saves input", () => {
    const out = html({
      phase: "not-prepared",
      settings: { safetyMode: "balanced", compressionMode: "auto", tokenBudget: 100_000, permissionMode: "auto", sandboxPreset: "guarded" },
    });
    expect(out).toMatch(/id="cfgBudget"[^>]*value="100000"/);
    expect(out).not.toMatch(/id="cfgBudget"[^>]*disabled/);
    expect(out).toContain('type: "setTokenBudget"');
    expect(out).toContain("positive whole number");
    expect(out).toContain("1,000,000,000 or less");
  });

  it("shows the same budget and best-effort result on Ready", () => {
    const out = html({
      phase: "ready", filesDiscovered: 2, documentsInspected: 0, summariesRejected: 0,
      contextIndex: true, agentHandoff: true,
      reductionPercent: 41.3, estimatedTokensBefore: 190_787, estimatedTokensAfter: 112_012,
      compression: { tokenBudget: 100_000, preparedTokens: 112_012, status: "best-effort" },
    });
    expect(out).toContain("Token Budget");
    expect(out).toContain("100,000");
    expect(out).toContain("Prepared Tokens");
    expect(out).toContain("112,012");
    expect(out).toContain("Best effort — 12,012 over target");
  });

  it("checks come only from real completed state (todo when files are absent)", () => {
    const out = html({ phase: "ready", filesDiscovered: 12, documentsInspected: 2, summariesRejected: 0, contextIndex: false, agentHandoff: false });
    // Context index / handoff NOT physically present → not a green check.
    expect(out).toMatch(/st todo[^>]*>[^<]*<span class="ck todo"/); // a todo marker exists
    // The "done" checks are the discovered/inspected counts, not context/handoff.
    expect(out).toContain("12 files discovered");
    expect(out).toContain("2 documents inspected");
    expect(out).not.toContain("Context generated →"); // gen footer only when index exists
  });

  it("a rejected summary is a WARNING, never Ready", () => {
    const out = html({ phase: "ready", filesDiscovered: 12, documentsInspected: 2, summariesRejected: 1, contextIndex: true, agentHandoff: true });
    expect(out).toContain("Ready with warnings");
    expect(out).toContain("1 summary rejected by verification");
    expect(out).toContain('class="ck warn"');
    // The badge must not read a bare "Ready".
    expect(out).not.toMatch(/badge ok">Ready</);
  });

  it("clean ready shows Ready and the .yuhi/context footer", () => {
    const out = html({ phase: "ready", filesDiscovered: 24, documentsInspected: 3, summariesRejected: 0, contextIndex: true, agentHandoff: true });
    expect(out).toMatch(/badge ok">Ready</);
    expect(out).toContain(".yuhi/context/");
    expect(out).toContain("24 files discovered");
  });

  it("Start Claude Code is DISABLED during the initial blocking preparation", () => {
    const out = html({ phase: "preparing", blocking: true, filesDiscovered: 12 });
    expect(out).toMatch(/id="startClaude"[^>]*disabled/);
  });

  it("background enrichment shows the lifecycle and does NOT block Start", () => {
    const out = html({ phase: "preparing", blocking: false, filesDiscovered: 12, lifecycle: "summarizing", current: 1, total: 3, currentDoc: "report.pdf" });
    expect(out).toContain("Summarizing locally");
    expect(out).toContain("1 of 3 files");
    expect(out).toContain("report.pdf");
    expect(out).not.toMatch(/id="startClaude"[^>]*disabled/); // launch not blocked by background
  });

  it("renders a prominent, live progress bar during the blocking phase", () => {
    const out = html({
      phase: "preparing", blocking: true, percent: 45, stepIndex: 2, stepTotal: 5,
      phaseLabel: "Preparing safe copies", current: 9, total: 20, elapsedSeconds: 7,
    });
    expect(out).toContain("Preparing your workspace…");
    expect(out).toContain("Step 3 of 5 · Preparing safe copies");
    expect(out).toContain("45%");
    expect(out).toContain("width:45%");
    expect(out).toContain("9 of 20 files");
    expect(out).toContain("7s");
    expect(out).toContain("Nothing has been sent to Claude Code yet.");
  });

  it("escapes untrusted document labels", () => {
    const out = html({ phase: "preparing", blocking: false, lifecycle: "inspecting", currentDoc: "<img src=x onerror=alert(1)>.pdf" });
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img");
  });

  it("renders the agent picker (Claude Code / Codex + Context ID) in place of the single button when present", () => {
    const out = html({
      phase: "yuhi-mode",
      filesAvailable: 5,
      filesExcluded: 0,
      claudeExtensionAvailable: true,
      picker: {
        contextId: "sha256:a7f19288b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8",
        agents: [
          { id: "claude", displayName: "Claude Code", available: true, isDefault: true },
          { id: "codex", displayName: "Codex", available: false, installHint: "Codex CLI was not found. Install Codex and try again." },
        ],
      },
    });
    expect(out).toContain("Launch with");
    expect(out).toContain('data-agent="claude"');
    expect(out).toContain('data-agent="codex"');
    expect(out).toContain("Context ID");
    expect(out).toContain("Prepared once. Reusable across agents.");
    // Not-installed agent is softened with a calm hint.
    expect(out).toContain("Codex CLI was not found");
    // The script wires the agent buttons.
    expect(out).toContain('type: "launchAgent"');
  });

  it("agent picker replaces the single Start button in the ready phase", () => {
    const out = html({
      phase: "ready",
      filesDiscovered: 3,
      documentsInspected: 0,
      summariesRejected: 0,
      contextIndex: true,
      agentHandoff: true,
      picker: {
        contextId: "sha256:" + "0".repeat(64),
        agents: [
          { id: "claude", displayName: "Claude Code", available: true, isDefault: true },
          { id: "codex", displayName: "Codex", available: true },
        ],
      },
    });
    expect(out).toContain("Launch with");
    // The single Start button is not rendered when the picker is present.
    expect(out).not.toContain('id="startClaude"');
  });

  it("Repository Optimization dashboard shows the five-number value story from the summary", () => {
    const out = html({
      phase: "yuhi-mode",
      filesAvailable: 0,
      filesExcluded: 0,
      yuhiModeSummary: summary({
        availability: { availableVerified: 4000, availableWithWarning: 148, compactRepresentations: 163, knownRisksBlocked: 12 },
        efficiency: { representationReductionPercent: 97, repositoryTokensBefore: 1_000_000, repositoryTokensAfter: 30_000 },
        background: { status: "running", pending: 900, processing: 95, completed: 5 },
      }),
    });
    expect(out).toContain("Repository Optimization");
    expect(out).not.toContain("Repository Savings");
    // Five numbers: available immediately (4000+148), background (900+95), blocked (12),
    // compact (163), and the reduction hero.
    expect(out).toContain("4,148");
    expect(out).toContain("available immediately");
    expect(out).toContain("995");
    expect(out).toContain("processing in background");
    expect(out).toContain("blocked (known risk)");
    expect(out).toContain("compact representations");
    expect(out).toContain("Estimated context reduction");
    expect(out).toContain("✓ 97%");
    // Compression explainer copy is present, honest, and non-billing.
    expect(out).toContain("Only structure is compressed");
    expect(out).toContain("Originals are preserved");
    expect(out).toContain("read the full original on demand");
    expect(out).not.toMatch(/cost savings|billing|API token savings/i);
  });

  it("Repository Optimization renders Not-measured (never a fake 0) when reduction is null", () => {
    const out = html({
      phase: "ready",
      filesDiscovered: 3,
      documentsInspected: 0,
      summariesRejected: 0,
      contextIndex: true,
      agentHandoff: true,
      yuhiModeSummary: summary({ availability: { availableVerified: 3 } }),
    });
    // Null reduction → "Not measured" in the dashboard, and "calculating…" in the ready header.
    expect(out).toContain("Not measured");
    expect(out).toContain("Repository reduction: calculating…");
    expect(out).not.toMatch(/Estimated context reduction<\/span><b>0%/);
  });

  it("shows a real tiny reduction honestly (0.36%, never rounded up or hidden)", () => {
    const out = html({
      phase: "yuhi-mode",
      filesAvailable: 0,
      filesExcluded: 0,
      yuhiModeSummary: summary({ efficiency: { representationReductionPercent: 0.36 } }),
    });
    expect(out).toContain("0.36%");
    expect(out).not.toContain("0.4%");
    expect(out).not.toContain("0.0%");
  });

  it("background queue reflects running vs completed state", () => {
    const running = html({
      phase: "yuhi-mode",
      filesAvailable: 0,
      filesExcluded: 0,
      yuhiModeSummary: summary({ background: { status: "running", pending: 7, processing: 3, completed: 0 } }),
    });
    // Running → 10 documents processing surfaced in the header and dashboard.
    expect(running).toContain("10");
    expect(running).toContain("documents processing");
    const done = html({
      phase: "yuhi-mode",
      filesAvailable: 0,
      filesExcluded: 0,
      yuhiModeSummary: summary({
        availability: { availableVerified: 5 },
        background: { status: "completed", pending: 0, processing: 0, completed: 8 },
      }),
    });
    // Completed → no "processing" line; 0 background shows as no pending metric emphasis.
    expect(done).toContain("processing in background");
    expect(done).not.toContain("documents processing");
  });

  it("shows the Repository Optimization FRAME before Prepare (placeholders, not fake numbers)", () => {
    const notPrepared = html({ phase: "not-prepared" });
    expect(notPrepared).toContain("Repository Optimization");
    expect(notPrepared).toContain("Estimated context reduction");
    expect(notPrepared).toContain("Estimated");
    expect(notPrepared).toContain("Waiting…");
    expect(notPrepared).toContain("available immediately");
    // The reduction hero shows the placeholder, never a fabricated percentage.
    expect(notPrepared).toContain("<b>Estimated</b>");
    const preparing = html({ phase: "preparing", blocking: true, filesDiscovered: 5 });
    expect(preparing).toContain("Repository Optimization");
    expect(preparing).toContain("Waiting…");
  });

  it("value-forward Repository Optimization header lists concrete outcomes + a ready-to-start line", () => {
    const out = html({
      phase: "yuhi-mode",
      filesAvailable: 0,
      filesExcluded: 0,
      yuhiModeSummary: summary({
        availability: { availableVerified: 4000, availableWithWarning: 148, compactRepresentations: 163 },
        efficiency: { representationReductionPercent: 97 },
        background: { status: "idle", pending: 0, processing: 0, completed: 0 },
      }),
    });
    expect(out).toContain("Repository Optimization");
    expect(out).toContain("4,148 files immediately available");
    expect(out).toContain("163 compact representations");
    expect(out).toContain("97% repository reduction");
    // The "ready to start" close, and no "documents processing" line when background is idle.
    expect(out).toContain("Ready.");
    expect(out).toContain("can start now.");
    expect(out).not.toContain("documents processing");
  });

  it("button ids match the ActivityPanelMessage contract", () => {
    // The webview posts { type: id } for these ids; the provider handles exactly these.
    const ready = html({ phase: "ready", filesDiscovered: 1, documentsInspected: 0, summariesRejected: 0, contextIndex: true, agentHandoff: true });
    expect(ready).toContain('id="startClaude"');
    expect(ready).toContain('id="details"');
    expect(html({ phase: "not-prepared" })).toContain('id="prepare"');
  });
});
