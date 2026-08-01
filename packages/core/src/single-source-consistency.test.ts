import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareWorkspace } from "./prepare-workspace.js";
import { renderYuhiModeHandoff, type YuhiModeSummary } from "./yuhi-mode-summary.js";

let dir: string;
let managedDir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuhi-single-src-"));
  managedDir = mkdtempSync(path.join(tmpdir(), "yuhi-managed-"));
  process.env.YUHI_HOME = managedDir;
});
afterEach(() => {
  delete process.env.YUHI_HOME;
  rmSync(dir, { recursive: true, force: true });
  rmSync(managedDir, { recursive: true, force: true });
});

function put(rel: string, content: string): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/**
 * ONE real prepared run over a small synthetic workspace (txt, PDF, CSV, large HTML, and
 * a synthetic credential). The YuhiModeSummary must be THE single source: its availability
 * and background counts must be IDENTICAL across the summary object, the rendered Handoff
 * text, and the manifest / yuhi-mode-summary.json — and each source file appears in exactly
 * one user-facing state (no double counting).
 */
describe("YuhiModeSummary is the single source of truth across surfaces", () => {
  it("has identical availability + background counts in the summary, handoff, and JSON", async () => {
    put(
      "yuhi.yaml",
      'version: "1"\n' +
        "defaults:\n  action: allow\n" +
        "rules:\n" +
        "  - name: block-env\n" +
        '    match: { paths: ["**/.env", "**/.env.*"] }\n' +
        "    action: block\n" +
        '    reason: "Environment files must not be exposed."\n',
    );
    put("readme.txt", "This is a plain, safe text document with useful project context.\n".repeat(20));
    put("doc.pdf", "%PDF-1.4\nnot-a-real-pdf-body-but-a-document-source\n".repeat(10));
    put(
      "data.csv",
      "id,name,amount\n" + Array.from({ length: 40 }, (_, i) => `${i},row-${i},${i * 10}`).join("\n") + "\n",
    );
    // A large HTML artifact so structure compression produces a compact representation.
    put(
      "report.html",
      "<html><body>" +
        Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i} with some filler content to grow the file.</p>`).join("") +
        "</body></html>",
    );
    // A synthetic credential that must stay a known-risk block.
    put(".env", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n");

    const report = await prepareWorkspace(dir, { compress: true });
    const summary = report.yuhiModeSummary;
    expect(summary).toBeDefined();
    if (!summary) return;

    const summaryJson = JSON.parse(
      readFileSync(path.join(report.outDir, ".yuhi", "yuhi-mode-summary.json"), "utf8"),
    ) as YuhiModeSummary;
    const manifest = JSON.parse(readFileSync(path.join(report.outDir, "manifest.json"), "utf8")) as {
      yuhiModeSummary: YuhiModeSummary;
      files: Array<{ relpath: string; originalRelpath?: string; outcome?: string }>;
    };
    const handoff = readFileSync(path.join(report.outDir, ".yuhi", "context", "AGENT_HANDOFF.md"), "utf8");

    // 1. IDENTICAL availability + background across all three JSON-backed surfaces.
    expect(summaryJson.contextAvailability).toEqual(summary.contextAvailability);
    expect(summaryJson.background).toEqual(summary.background);
    expect(manifest.yuhiModeSummary.contextAvailability).toEqual(summary.contextAvailability);
    expect(manifest.yuhiModeSummary.background).toEqual(summary.background);

    // 2. The rendered Handoff prints those SAME numbers (never a recomputed set).
    const a = summary.contextAvailability;
    expect(handoff).toContain(`Verified files: ${a.availableVerified}`);
    expect(handoff).toContain(`Files available with warnings: ${a.availableWithWarning}`);
    expect(handoff).toContain(`Compact representations: ${a.compactRepresentations}`);
    expect(handoff).toContain(`Verified document companions: ${a.companionsAdded}`);
    expect(handoff).toContain(`Known-risk files blocked: ${a.knownRisksBlocked}`);
    expect(handoff).toContain(`Unavailable after processing failure: ${a.unavailableAfterFailure}`);
    expect(handoff).toContain(
      `Processing locally in background: ${summary.background.pending + summary.background.processing}`,
    );
    // Handoff is produced by the same renderer, so it must equal a fresh render of the JSON.
    expect(handoff).toBe(renderYuhiModeHandoff(summaryJson));

    // 3. Exactly ONE user-facing state per source file (no double counting). The six
    //    availability states must sum to the number of distinct, finalized project files.
    const projectKeys = new Set(
      manifest.files
        .filter((f) => f.relpath !== "manifest.json" && !f.relpath.startsWith(".yuhi/"))
        .filter((f) => f.outcome !== "background-processing-pending")
        .map((f) => f.originalRelpath ?? f.relpath),
    );
    const stateSum =
      a.availableVerified +
      a.availableWithWarning +
      a.compactRepresentations +
      a.companionsAdded +
      a.knownRisksBlocked +
      a.unavailableAfterFailure;
    expect(stateSum).toBe(projectKeys.size);

    // The synthetic credential is a known-risk block and is counted in exactly one state.
    expect(a.knownRisksBlocked).toBeGreaterThanOrEqual(1);
    // At least one ordinary document is usable (verified or available-with-warning).
    expect(a.availableVerified + a.availableWithWarning).toBeGreaterThanOrEqual(1);
  });
});
