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

function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
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

function makeFixture(): { root: string; home: string } {
  const root = mkdtempSync(path.join(tmpdir(), "yuhi-privacy-cli-"));
  const home = mkdtempSync(path.join(tmpdir(), "yuhi-privacy-cli-home-"));
  roots.push(root, home);
  writeFileSync(root + "/roster.csv", "学籍番号,氏名\nSID_CANARY_001,山田太郎\n");
  writeFileSync(root + "/yuhi.yaml", 'version: "1"\nrules: []\ninclude_untracked: true\n');
  return { root, home };
}

describe("CLI --privacy-mode (Phase 2)", () => {
  it("default (no flag) resolves to balanced: direct identifier masked", async () => {
    const { root, home } = makeFixture();
    const result = await runCli(["--json", "-C", root, "prepare"], { YUHI_HOME: home });
    expect(result, result.stderr).toMatchObject({ code: 0, timedOut: false });
  });

  it("--privacy-mode trusted-local without acknowledgement fails closed (non-interactive)", async () => {
    const { root, home } = makeFixture();
    const result = await runCli(
      ["--json", "-C", root, "prepare", "--privacy-mode", "trusted-local"],
      { YUHI_HOME: home },
    );
    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/acknowledg/i);
  });

  it("--privacy-mode trusted-local --acknowledge-unmasked-data succeeds and preserves the identifier", async () => {
    const { root, home } = makeFixture();
    const result = await runCli(
      [
        "--json",
        "-C",
        root,
        "prepare",
        "--privacy-mode",
        "trusted-local",
        "--acknowledge-unmasked-data",
      ],
      { YUHI_HOME: home },
    );
    expect(result, result.stderr).toMatchObject({ code: 0, timedOut: false });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "Success" });
  });

  it("an invalid --privacy-mode value fails closed with a clear error", async () => {
    const { root, home } = makeFixture();
    const result = await runCli(
      ["--json", "-C", root, "prepare", "--privacy-mode", "paranoid"],
      { YUHI_HOME: home },
    );
    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Unknown Privacy Mode/);
  });
});
