/**
 * Integration: the full init → scan → preview → workspace pipeline via @yuhi/core,
 * on a throwaway repo, asserting the original tree is never modified.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runInit, computePlan, buildPreview, createWorkspaceForDir, contextSavings } from "@yuhi/core";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuhi-it-"));
  process.env.YUHI_HOME = path.join(dir, "..", "home-" + path.basename(dir));
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

function hashTree(root: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const st = lstatSync(abs);
      const rel = path.relative(root, abs);
      if (st.isDirectory()) {
        h.update("D:" + rel);
        walk(abs);
      } else {
        h.update("F:" + rel + ":" + readFileSync(abs).toString("hex"));
      }
    }
  };
  walk(root);
  return h.digest("hex");
}

describe("end-to-end pipeline", () => {
  it("init → scan → preview → workspace, source unmodified", async () => {
    put("src/index.ts", "export const x = 1;\n");
    put("README.md", "# hi\n");
    put(".env", "OPENAI_API_KEY=" + "sk-proj-" + "abcdefghijklmnopqrstuvwxyz0123\n");

    // init
    const init = runInit(dir);
    expect(init.created).toContain("yuhi.yaml");
    expect(existsSync(path.join(dir, "yuhi.yaml"))).toBe(true);

    const before = hashTree(dir);

    // scan + preview
    const plan = await computePlan(dir, { interactive: false });
    expect(plan.scan.filesInspected).toBeGreaterThan(0);
    const preview = buildPreview(plan);
    expect(preview.summary.visible).toBeGreaterThan(0);
    // .env should become a locally sanitized copy under the default policy.
    expect(preview.byAction["prepare-locally"].some((d) => d.relpath === ".env")).toBe(true);

    // workspace
    const { manifest, treeDir } = await createWorkspaceForDir(dir, { interactive: false });
    expect(existsSync(path.join(treeDir, "src/index.ts"))).toBe(true);
    expect(existsSync(path.join(treeDir, ".env"))).toBe(true);
    const preparedEnv = readFileSync(path.join(treeDir, ".env"), "utf8");
    expect(preparedEnv).toContain("OPENAI_API_KEY=${OPENAI_API_KEY}");
    expect(preparedEnv).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(manifest.counts.visible).toBeGreaterThan(0);

    // Original tree is byte-for-byte unchanged (yuhi.yaml + .yuhi were added by init,
    // which is why we hashed AFTER init).
    expect(hashTree(dir)).toBe(before);

    // Context savings: the agent receives less than a raw launch would.
    const savings = contextSavings(plan);
    expect(savings.before.files).toBeGreaterThanOrEqual(savings.after.files);
    expect(savings.before.bytes).toBeGreaterThanOrEqual(savings.after.bytes);
    expect(savings.secretsRemoved).toBeGreaterThanOrEqual(1); // the .env
    expect(savings.tokenReductionPct).toBeGreaterThanOrEqual(0);
  });

  it("reads policy from a .aicontext file (alternate standard name)", async () => {
    put("src/index.ts", "export const x = 1;\n");
    put(".env", "OPENAI_API_KEY=" + "sk-proj-" + "abcdefghijklmnopqrstuvwxyz0123\n");
    // No yuhi.yaml — a .aicontext instead.
    writeFileSync(
      path.join(dir, ".aicontext"),
      'version: "1"\nrules:\n  - name: block-env\n    match: { paths: ["**/.env"] }\n    action: block\n',
    );
    const plan = await computePlan(dir, { interactive: false });
    const preview = buildPreview(plan);
    expect(preview.byAction.block.some((d) => d.relpath === ".env")).toBe(true);
  });
});
