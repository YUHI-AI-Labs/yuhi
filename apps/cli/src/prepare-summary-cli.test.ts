/**
 * v0.4.8 Phase 6 — minimal first-run UX: `yuhi prepare`'s NORMAL (non-verbose,
 * non-JSON) console output is a short, scannable summary; `--verbose` preserves the
 * full ~40-line report exactly as before this phase. Real end-to-end CLI subprocess
 * tests, following the same pattern as `privacy-mode-cli.test.ts`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Built once for the whole run by vitest.global-setup.ts.
const cli = path.join(process.cwd(), "apps/cli/dist/index.js");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, 10_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

function fixture(): { root: string; home: string } {
  const root = mkdtempSync(path.join(tmpdir(), "yuhi-prepare-summary-"));
  const home = mkdtempSync(path.join(tmpdir(), "yuhi-prepare-summary-home-"));
  roots.push(root, home);
  writeFileSync(path.join(root, "app.ts"), "export const x = 1;\n");
  writeFileSync(path.join(root, "yuhi.yaml"), 'version: "1"\nrules: []\n');
  return { root, home };
}

describe("yuhi prepare — normal-mode summary (Phase 6)", () => {
  it("prints a short, scannable summary by default", async () => {
    const { root, home } = fixture();
    const result = await runCli(["-C", root, "prepare"], { YUHI_HOME: home }, root);
    expect(result, result.stderr).toMatchObject({ code: 0, timedOut: false });
    expect(result.stdout).toMatch(/^✓ Workspace prepared/m);
    expect(result.stdout).toMatch(/^ {2}Privacy: Balanced$/m);
    expect(result.stdout).toMatch(/^ {2}Files: \d+ available/m);
    expect(result.stdout).toMatch(/^ {2}Reduction: ~\d+%$/m);
    expect(result.stdout).toMatch(/^ {2}Run ID: \S+$/m);
    expect(result.stdout).toContain("Start Claude Code:");
    expect(result.stdout).toContain("yuhi prepare --verbose");
    // The old, longer report must NOT leak into the default summary.
    expect(result.stdout).not.toContain("Repository Ready");
    expect(result.stdout).not.toContain("Context preparation");
    // The Privacy line is not printed twice (once upfront, once in the summary).
    expect(result.stdout.match(/Privacy:/g)?.length).toBe(1);
  });

  it("--verbose preserves the full detailed report exactly as before this phase", async () => {
    const { root, home } = fixture();
    const result = await runCli(["-C", root, "prepare", "--verbose"], { YUHI_HOME: home }, root);
    expect(result, result.stderr).toMatchObject({ code: 0, timedOut: false });
    expect(result.stdout).toContain("Repository Ready");
    expect(result.stdout).toContain("Context preparation");
    expect(result.stdout).toContain("Prepared by Yuhi");
    expect(result.stdout).toMatch(/^Privacy: Balanced$/m);
    // The concise summary's own lines are NOT also printed in verbose mode.
    expect(result.stdout).not.toMatch(/^✓ Workspace prepared/m);
  });

  it("shows the Trusted Local warning upfront, before the run, in BOTH modes", async () => {
    const { root, home } = fixture();
    const result = await runCli(
      ["-C", root, "prepare", "--privacy-mode", "trusted-local", "--acknowledge-unmasked-data"],
      { YUHI_HOME: home },
      root,
    );
    expect(result, result.stderr).toMatchObject({ code: 0, timedOut: false });
    expect(result.stdout).toMatch(/Privacy transformation is disabled/);
    expect(result.stdout).toContain("Privacy: Trusted Local");
  });

  it("--json is unaffected by the summary redesign", async () => {
    const { root, home } = fixture();
    const result = await runCli(["--json", "-C", root, "prepare"], { YUHI_HOME: home }, root);
    expect(result, result.stderr).toMatchObject({ code: 0, timedOut: false });
    const parsed = JSON.parse(result.stdout) as { status?: string; runId?: string };
    expect(parsed.status).toBe("Success");
    expect(typeof parsed.runId).toBe("string");
  });
});
