import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bundled CLI lifecycle", () => {
  it("prints the result and exits after deterministic preparation", async () => {
    // Built once for the whole run by vitest.global-setup.ts.
    const root = mkdtempSync(path.join(tmpdir(), "yuhi-cli-exit-"));
    roots.push(root);
    const home = mkdtempSync(path.join(tmpdir(), "yuhi-cli-home-"));
    roots.push(home);
    writeFileSync(path.join(root, "app.ts"), "export const x = 1;\n");
    writeFileSync(path.join(root, "yuhi.yaml"), 'version: "1"\nrules: []\n');
    const cli = path.join(process.cwd(), "apps/cli/dist/index.js");
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }>((resolve) => {
      const child = spawn(process.execPath, [cli, "--json", "-C", root, "prepare"], {
        env: { ...process.env, YUHI_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, stdout, stderr, timedOut: true });
      }, 5_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut: false });
      });
    });
    expect(result, result.stderr).toMatchObject({ code: 0, timedOut: false });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "Success",
      filesIncluded: 2,
      localModelRequests: 0,
    });
  });
});
