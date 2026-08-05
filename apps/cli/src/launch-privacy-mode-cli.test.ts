/**
 * v0.4.8 Phase 3B — `yuhi launch claude --dynamic-context --privacy-mode` end to end,
 * exercising the REAL `index.ts` action wiring (not the pure `resolveLaunchPrivacyMode`
 * unit, which `launch-dynamic.test.ts` already covers). Only the safety-critical
 * REFUSAL path is asserted here: it is deterministic (returns before ever touching an
 * agent binary), unlike the acceptance path, which would depend on `claude` being
 * installed in the test environment.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const cli = path.join(process.cwd(), "apps/cli/dist/index.js");

beforeAll(() => {
  execFileSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["--filter", "@yuhi-ai-labs/yuhi", "build"],
    { cwd: process.cwd(), stdio: "ignore" },
  );
}, 60_000);

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

/** Prepares a real run under Trusted Local, so `manifest.json` records that mode. */
async function prepareTrustedLocalRun(): Promise<{ root: string; home: string }> {
  const root = mkdtempSync(path.join(tmpdir(), "yuhi-launch-privacy-cli-"));
  const home = mkdtempSync(path.join(tmpdir(), "yuhi-launch-privacy-cli-home-"));
  roots.push(root, home);
  writeFileSync(path.join(root, "roster.csv"), "学籍番号,氏名\nSID_CANARY_001,山田太郎\n");
  writeFileSync(path.join(root, "yuhi.yaml"), 'version: "1"\nrules: []\ninclude_untracked: true\n');
  const env = { YUHI_HOME: home };
  const result = await runCli(
    ["--json", "-C", root, "prepare", "--privacy-mode", "trusted-local", "--acknowledge-unmasked-data"],
    env,
    root,
  );
  if (result.code !== 0) throw new Error(`fixture prepare failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { runId?: string };
  if (!parsed.runId) throw new Error(`fixture prepare produced no runId: ${result.stdout}`);
  return { root, home };
}

describe("yuhi launch claude --dynamic-context --privacy-mode (Phase 3B)", () => {
  it("refuses an explicit Balanced launch against a Trusted-Local-prepared run, before touching any agent", async () => {
    const { root, home } = await prepareTrustedLocalRun();
    const result = await runCli(
      ["launch", "claude", "--dynamic-context", "--privacy-mode", "balanced", "--dry-run"],
      { YUHI_HOME: home },
      root,
    );
    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Privacy Mode mismatch/);
    expect(result.stderr).toMatch(/Trusted Local/);
  });

  it("refuses an explicit Strict launch against a Trusted-Local-prepared run", async () => {
    const { root, home } = await prepareTrustedLocalRun();
    const result = await runCli(
      ["launch", "claude", "--dynamic-context", "--privacy-mode", "strict", "--dry-run"],
      { YUHI_HOME: home },
      root,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Privacy Mode mismatch/);
  });

  it("an invalid --privacy-mode value fails closed with a clear error", async () => {
    const { root, home } = await prepareTrustedLocalRun();
    const result = await runCli(
      ["launch", "claude", "--dynamic-context", "--privacy-mode", "paranoid", "--dry-run"],
      { YUHI_HOME: home },
      root,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Unknown Privacy Mode/);
  });
});
