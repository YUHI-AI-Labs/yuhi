/**
 * Runtime-only route: a file marked `inject` supplies values to the agent's
 * process env, but is NOT copied into the context the agent reads.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computePlan, collectInjectedEnv, createWorkspaceForDir } from "@yuhi/core";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuhi-inject-"));
  process.env.YUHI_HOME = path.join(dir, "home");
});
afterEach(() => {
  delete process.env.YUHI_HOME;
  rmSync(dir, { recursive: true, force: true });
});

function put(rel: string, content: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe("Runtime only (inject)", () => {
  it("injects .env values into the process, but never into the workspace", async () => {
    put("src/index.ts", "export const x = 1;\n");
    put(".env", 'DATABASE_URL="postgres://u:p@db/app"\nAPI_KEY=sk-runtime-123\n');
    put(
      "yuhi.yaml",
      'version: "1"\nrules:\n  - name: env-runtime\n    match: { paths: ["**/.env"] }\n    action: inject\n',
    );

    const plan = await computePlan(dir, { interactive: false });

    // The value is available for injection…
    const injected = collectInjectedEnv(plan);
    expect(injected.keys.sort()).toEqual(["API_KEY", "DATABASE_URL"]);
    expect(injected.vars.API_KEY).toBe("sk-runtime-123");
    expect(injected.sources).toContain(".env");

    // …but the .env file is NOT written into the generated context.
    const { treeDir } = await createWorkspaceForDir(dir, { interactive: false });
    expect(existsSync(path.join(treeDir, ".env"))).toBe(false);
    expect(existsSync(path.join(treeDir, "src/index.ts"))).toBe(true);
  });
});
