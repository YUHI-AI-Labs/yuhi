import { describe, it, expect } from "vitest";
import { renderActivityPanel, type ActivityPanelData } from "./activity-panel.js";

const CSP = "vscode-resource:";
const NONCE = "NONCE123";
const html = (d: ActivityPanelData) => renderActivityPanel(d, CSP, NONCE);

describe("Yuhi activity panel (webview)", () => {
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
    expect(out).toContain("1 file excluded by recommendation");
    expect(out).toContain("1 document processing in the background");
    // Impact metrics are celebrated.
    expect(out).toContain("Yuhi protected your data");
    expect(out).toContain("2,165");
    expect(out).toContain("sensitive values masked");
    expect(out).toContain("82%");
    expect(out).toContain("context reduced");
    expect(out).toContain("files transformed");
    expect(out).toContain(">3<"); // the transformed-file count value
    expect(out).toContain("Open Claude Code");
    expect(out).toContain("Review file decisions");
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

  it("button ids match the ActivityPanelMessage contract", () => {
    // The webview posts { type: id } for these ids; the provider handles exactly these.
    const ready = html({ phase: "ready", filesDiscovered: 1, documentsInspected: 0, summariesRejected: 0, contextIndex: true, agentHandoff: true });
    expect(ready).toContain('id="startClaude"');
    expect(ready).toContain('id="details"');
    expect(html({ phase: "not-prepared" })).toContain('id="prepare"');
  });
});
