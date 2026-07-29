import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrepareReport } from "@yuhi/core";
import {
  CLAUDE_INTEGRATION,
  LAUNCH_COMMANDS,
  PREPARED_WORKSPACE_NOTICE,
  assertPreparedPath,
  buildSummary,
  canOpen,
  claudeMarketplaceUrl,
  classifyOutcome,
  formatSummaryDetail,
  formatPreparedStatusText,
  formatPreparedWorkspaceNotice,
  preparedStatusTooltipLines,
  openPreparedWorkspace,
  normalizePreparedSession,
  resolveClaudeIntegration,
  runPrepareAndOpen,
  runPrepareAndStartClaude,
  startClaudeCliInTerminal,
  validatePreparedPath,
  writeSessionMetadata,
} from "./launch.js";

const cleanups: string[] = [];

async function fixture(): Promise<{ root: string; outDir: string; report: PrepareReport }> {
  const root = await mkdtemp(path.join(tmpdir(), "yuhi-launch-"));
  cleanups.push(root);
  const outDir = path.join(root, ".yuhi", "prepared", "run-1");
  await mkdir(outDir, { recursive: true });
  return {
    root,
    outDir,
    report: {
      runId: "run-1",
      outDir,
      report: {
        beforeChars: 400,
        afterChars: 100,
        beforeTokens: 100,
        afterTokens: 25,
        tokensSaved: 75,
        percentReduction: 0.75,
        hasData: true,
        filesExcluded: 1,
        filesSummarized: 1,
        sensitiveMasked: 1,
        sourceModified: 0,
        approx: true,
      },
      files: [
        {
          relpath: "src/app.ts", action: "allow", status: "ok", transmission: "approved",
          beforeChars: 200, afterChars: 200,
        },
        {
          relpath: "notes.md", action: "prepare-locally", status: "ok", transmission: "approved",
          beforeChars: 200, afterChars: 40, transformations: ["summarized", "pseudonymized", "masked"],
          maskedValues: 2, transformed: true,
        },
        {
          relpath: "private/.env", action: "local-only", status: "skipped", transmission: "blocked",
          beforeChars: 20, afterChars: 0, omitted: true,
        },
      ],
      blocked: [],
      errors: [],
      decisions: [
        {
          relpath: "src/app.ts", action: "allow", ruleName: "public docs", reason: "Allowed.",
          destinations: ["external"], findings: [],
        },
        {
          relpath: "notes.md", action: "prepare-locally", ruleName: "internal",
          reason: "Employee identifier detected.", destinations: ["external"],
          findings: [{
            detector: "employee-id", severity: "medium", path: "notes.md",
            description: "Synthetic employee identifier", maskedPreview: "[masked]",
          }],
        },
        {
          relpath: "private/.env", action: "local-only", ruleName: "private",
          reason: "Matched path rule: **/.env", destinations: [],
          findings: [{
            detector: "api-key", severity: "critical", path: "private/.env",
            description: "Synthetic key", maskedPreview: "[masked]",
          }],
        },
      ],
      sourceModified: 0,
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function host() {
  return {
    openFolder: vi.fn(async () => {}),
    isExtensionInstalled: vi.fn(() => true),
    createTerminal: vi.fn(() => ({ sendText: vi.fn(), show: vi.fn() })),
    openExternal: vi.fn(async () => true),
    showInfo: vi.fn(async () => undefined),
    showWarning: vi.fn(async () => undefined),
    showError: vi.fn(async () => undefined),
  };
}

describe("launch metadata and policy", () => {
  it("exports the two contributed command IDs", () => {
    expect(Object.values(LAUNCH_COMMANDS)).toEqual(["yuhi.prepareAndOpen", "yuhi.prepareAndStartClaude"]);
  });

  it("supports only the official Claude extension ID", () => {
    expect(CLAUDE_INTEGRATION.extensionIds).toEqual(["anthropic.claude-code"]);
  });

  it("detects the official extension", () => {
    expect(resolveClaudeIntegration({ isExtensionInstalled: (id) => id === "anthropic.claude-code" }))
      .toEqual({ installed: true, extensionId: "anthropic.claude-code" });
  });

  it("does not treat a third-party Claude extension as official", () => {
    expect(resolveClaudeIntegration({ isExtensionInstalled: (id) => id === "saoudrizwan.claude-dev" }))
      .toEqual({ installed: false });
  });

  it("uses the official Marketplace listing", () => {
    expect(claudeMarketplaceUrl()).toContain("itemName=anthropic.claude-code");
  });

  it("classifies complete, warning, partial, and failed outcomes", async () => {
    const { report } = await fixture();
    expect(classifyOutcome(report)).toBe("Complete");
    expect(classifyOutcome({ ...report, blocked: [report.files[2]!] })).toBe("Complete with warnings");
    expect(classifyOutcome({ ...report, errors: [report.files[2]!] })).toBe("Partial");
    expect(classifyOutcome({ ...report, files: [report.files[2]!], errors: [report.files[2]!] })).toBe("Failed");
  });

  it("only opens complete outcomes", () => {
    expect(canOpen("Complete")).toBe(true);
    expect(canOpen("Complete with warnings")).toBe(true);
    expect(canOpen("Partial")).toBe(false);
    expect(canOpen("Failed")).toBe(false);
  });

  it("builds honest summary terminology", async () => {
    const { root, report } = await fixture();
    const detail = formatSummaryDetail(buildSummary(report, root));
    expect(detail).toContain("Prepared by Yuhi");
    expect(detail).toContain("Estimated context reduction: 75.0%");
    expect(detail).toContain("Sensitive findings detected:");
    expect(detail).toContain("OS sandbox: not enabled");
    expect(detail).toContain("Initial context prepared by Yuhi");
    expect(detail).toContain("Workspace boundary: advisory");
    expect(detail).toContain("The agent may access files outside");
    expect(detail).not.toContain("confined");
  });

  it("status text values exactly match masked/excluded metrics", async () => {
    const { report } = await fixture();
    const metrics = buildSummary(report).unresolvedHighRiskFindings;
    expect(metrics).toBe(0);
    const sessionMetrics = (await import("@yuhi/core")).buildPreparedMetrics(report);
    expect(formatPreparedStatusText(sessionMetrics))
      .toBe("$(shield) Prepared by Yuhi · 2 masked · 0 excluded");
  });

  it("status text shows one-decimal reduction when no masking or exclusion exists", async () => {
    const { report } = await fixture();
    report.files = report.files.slice(0, 1);
    report.decisions = report.decisions?.slice(0, 1);
    expect(formatPreparedStatusText((await import("@yuhi/core")).buildPreparedMetrics(report)))
      .toBe("$(shield) Prepared by Yuhi · −75.0% context");
  });

  it("status tooltip carries the advisory boundary wording", async () => {
    const { report } = await fixture();
    const lines = preparedStatusTooltipLines(
      report.runId,
      (await import("@yuhi/core")).buildPreparedMetrics(report),
    ).join("\n");
    expect(lines).toContain("Workspace boundary: advisory");
    expect(lines).toContain("Filesystem enforcement: not enabled");
    expect(lines).toContain("may access files outside");
  });

  it("notice contains the required limitation and no source path", async () => {
    const { root } = await fixture();
    expect(PREPARED_WORKSPACE_NOTICE).toMatch(/does \*\*not\*\* provide\s+OS-level/);
    expect(PREPARED_WORKSPACE_NOTICE).toContain("Workspace boundary: advisory");
    expect(PREPARED_WORKSPACE_NOTICE).toContain("may access parent directories");
    expect(PREPARED_WORKSPACE_NOTICE).not.toContain(root);
  });

  it("rendered notice separates preparation metrics from the advisory runtime boundary", async () => {
    const { report } = await fixture();
    const rendered = formatPreparedWorkspaceNotice(
      (await import("@yuhi/core")).buildPreparedMetrics(report),
    );
    expect(rendered).toContain("## Context preparation");
    expect(rendered).toContain("Sensitive values masked: 2");
    expect(rendered).toContain("Estimated context reduction: 75.0%");
    expect(rendered).toContain("Original files modified: 0");
    expect(rendered).toContain("## Runtime boundary");
    expect(rendered).toContain("Filesystem enforcement: not enabled");
    expect(rendered).toContain("External-path access may still be possible");
  });

  it("validates exactly one run directory below the prepared base", async () => {
    const { root, outDir } = await fixture();
    expect(validatePreparedPath(root, outDir)).toBe(true);
    expect(validatePreparedPath(root, root)).toBe(false);
    expect(validatePreparedPath(root, path.join(outDir, "nested"))).toBe(false);
  });

  it("rejects a symlinked prepared run", async () => {
    const { root } = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "yuhi-outside-"));
    cleanups.push(outside);
    const linked = path.join(root, ".yuhi", "prepared", "linked");
    await symlink(outside, linked);
    await expect(assertPreparedPath(root, linked)).rejects.toThrow(/not a real directory/);
  });

  it("session metadata has no source path or raw values", async () => {
    const { root, outDir, report } = await fixture();
    const session = await writeSessionMetadata(root, report, "Complete", "2026-01-01T00:00:00.000Z");
    const raw = await readFile(path.join(outDir, ".yuhi", "session.json"), "utf8");
    expect(session.sourceWorkspaceId).toMatch(/^[a-f0-9]{24}$/);
    expect(session.schemaVersion).toBe(2);
    expect(raw).not.toContain(root);
    expect(raw).not.toContain("maskedPreview");
    expect(raw).not.toContain("Synthetic key");
    expect(session.runtime).toEqual({
      initialContextPrepared: true,
      startDirectory: "prepared-workspace",
      workspaceInstructionPresent: true,
      workspaceBoundary: "advisory",
      filesystemEnforcement: "none",
      osSandboxEnabled: false,
      externalPathAccessPossible: true,
    });
  });

  it("upgrades schema v1 session metadata in memory", () => {
    const session = normalizePreparedSession({
      schemaVersion: 1,
      runId: "old",
      sourceWorkspaceId: "opaque",
      preparationResult: "complete",
      metrics: {
        filesContainingSensitiveFindings: 3,
        filesMasked: 2,
        filesModifiedInPreparedWorkspace: 1,
        sourceFilesModified: 0,
      },
      runtime: { osSandboxEnabled: false },
    });
    expect(session.schemaVersion).toBe(2);
    expect(session.metrics.filesWithSensitiveFindings).toBe(3);
    expect(session.metrics.filesWithMaskedValues).toBe(2);
    expect(session.metrics.preparedFilesModified).toBe(1);
    expect(session.runtime.workspaceBoundary).toBe("advisory");
    expect(session.runtime.initialContextPrepared).toBe(true);
  });

  it("acceptance: an external fixture stays outside while boundary metadata remains honest", async () => {
    const { root, outDir, report } = await fixture();
    const external = await mkdtemp(path.join(tmpdir(), "yuhi-harmless-external-"));
    cleanups.push(external);
    const session = await writeSessionMetadata(root, report, "Complete");
    const raw = await readFile(path.join(outDir, ".yuhi", "session.json"), "utf8");
    expect(outDir.startsWith(external)).toBe(false);
    expect(raw).not.toContain(external);
    expect(session.runtime.externalPathAccessPossible).toBe(true);
    expect(PREPARED_WORKSPACE_NOTICE).toContain("agent may access parent directories");
  });
});

describe("launch orchestration", () => {
  it("prepares once and opens the exact prepared path in a new window", async () => {
    const { root, outDir, report } = await fixture();
    const h = host();
    const prepare = vi.fn(async () => report);
    const result = await runPrepareAndOpen({
      host: h, getWorkspaceRoot: () => root, prepare, confirmOpen: async () => true,
    });
    expect(result.status).toBe("opened");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.openFolder).toHaveBeenCalledWith(outDir, true);
    expect(h.openFolder).not.toHaveBeenCalledWith(root, expect.anything());
  });

  it("does not open after a partial result", async () => {
    const { root, report } = await fixture();
    report.errors = [report.files[0]!];
    const h = host();
    const result = await runPrepareAndOpen({
      host: h, getWorkspaceRoot: () => root, prepare: async () => report, confirmOpen: async () => true,
    });
    expect(result.status).toBe("blocked");
    expect(h.openFolder).not.toHaveBeenCalled();
  });

  it("does not offer or accept an override after a failed result", async () => {
    const { root, report } = await fixture();
    report.files = [{ ...report.files[2]!, status: "error" }];
    report.errors = [report.files[0]!];
    const h = host();
    const override = vi.fn(async () => true);
    const result = await runPrepareAndOpen({
      host: h,
      getWorkspaceRoot: () => root,
      prepare: async () => report,
      confirmOpen: async () => true,
      confirmHighRiskOverride: override,
    });
    expect(result).toEqual({ status: "blocked", outcome: "Failed" });
    expect(override).not.toHaveBeenCalled();
    expect(h.openFolder).not.toHaveBeenCalled();
  });

  it("blocks an unresolved high-risk finding by default", async () => {
    const { root, report } = await fixture();
    report.decisions![0]!.findings.push({
      detector: "api-key", severity: "high", path: "src/app.ts",
      description: "Synthetic key", maskedPreview: "[masked]",
    });
    const h = host();
    const result = await runPrepareAndOpen({
      host: h, getWorkspaceRoot: () => root, prepare: async () => report, confirmOpen: async () => true,
    });
    expect(result.status).toBe("blocked");
    expect(h.openFolder).not.toHaveBeenCalled();
  });

  it("allows only an explicit high-risk override and audits it", async () => {
    const { root, outDir, report } = await fixture();
    report.decisions![0]!.findings.push({
      detector: "api-key", severity: "high", path: "src/app.ts",
      description: "Synthetic key", maskedPreview: "[masked]",
    });
    const h = host();
    await runPrepareAndOpen({
      host: h, getWorkspaceRoot: () => root, prepare: async () => report,
      confirmHighRiskOverride: async () => true, confirmOpen: async () => true,
    });
    const audit = await readFile(path.join(outDir, ".yuhi", "launch-audit.jsonl"), "utf8");
    expect(audit).toContain("unresolved-finding-override");
  });

  it("requires launch confirmation and respects cancellation", async () => {
    const { root, report } = await fixture();
    const h = host();
    const result = await runPrepareAndStartClaude({
      host: h, getWorkspaceRoot: () => root, prepare: async () => report,
      pickMode: async () => "extension", resolveCliFile: () => null,
      confirmLaunch: async () => "cancel", reviewDetails: async () => {},
    });
    expect(result.status).toBe("cancelled");
    expect(h.openFolder).not.toHaveBeenCalled();
  });

  it("supports review then approval without preparing twice", async () => {
    const { root, report } = await fixture();
    const h = host();
    const prepare = vi.fn(async () => report);
    const review = vi.fn(async () => {});
    let calls = 0;
    await runPrepareAndStartClaude({
      host: h, getWorkspaceRoot: () => root, prepare,
      pickMode: async () => "extension", resolveCliFile: () => null,
      confirmLaunch: async () => (++calls === 1 ? "review" : "open"), reviewDetails: review,
    });
    expect(review).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("starts CLI with prepared cwd and shell-quoted arguments", async () => {
    const h = host();
    startClaudeCliInTerminal(h, "/tmp/a b", "/bin/claude", ["--name", "a'b"]);
    expect(h.createTerminal).toHaveBeenCalledWith("Yuhi · Claude Code", "/tmp/a b");
    const terminal = h.createTerminal.mock.results[0]!.value;
    expect(terminal.sendText).toHaveBeenCalledWith("'/bin/claude' '--name' 'a'\\''b'", true);
  });

  it("never silently falls back when the CLI is missing", async () => {
    const { root, report } = await fixture();
    const h = host();
    const result = await runPrepareAndStartClaude({
      host: h, getWorkspaceRoot: () => root, prepare: async () => report,
      pickMode: async () => "cli", resolveCliFile: () => null,
      confirmLaunch: async () => "open", reviewDetails: async () => {},
    });
    expect(result.status).toBe("cli-missing");
    expect(h.openFolder).not.toHaveBeenCalled();
  });

  it("opens the official listing when Claude Code is missing", async () => {
    const { root, report } = await fixture();
    const h = host();
    h.isExtensionInstalled.mockReturnValue(false);
    h.showWarning.mockResolvedValue("Install Claude Code" as never);
    await runPrepareAndStartClaude({
      host: h, getWorkspaceRoot: () => root, prepare: async () => report,
      pickMode: async () => "extension", resolveCliFile: () => null,
      confirmLaunch: async () => "open", reviewDetails: async () => {},
    });
    expect(h.openExternal).toHaveBeenCalledWith(claudeMarketplaceUrl());
  });

  it("open primitive never targets the original workspace", async () => {
    const { root, outDir } = await fixture();
    const h = host();
    await openPreparedWorkspace(h, root, outDir);
    expect(h.openFolder).toHaveBeenCalledWith(outDir, true);
    expect(h.openFolder).not.toHaveBeenCalledWith(root, true);
  });
});
