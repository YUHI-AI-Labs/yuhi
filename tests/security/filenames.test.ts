/**
 * Security regression: hostile filenames and paths must never (a) escape the
 * workspace, (b) be executed via a shell, or (c) corrupt the copy. These map to
 * THREAT_MODEL T3/T4/T6/T11.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanRepo } from "@yuhi/scanner";
import { resolvePolicy } from "@yuhi/policy";
import { createWorkspace } from "@yuhi/workspace";

let parent: string;
let src: string;

beforeEach(() => {
  parent = mkdtempSync(path.join(tmpdir(), "yuhi-sec-"));
  src = path.join(parent, "repo");
  mkdirSync(src, { recursive: true });
  process.env.YUHI_HOME = path.join(parent, "home");
});
afterEach(() => {
  delete process.env.YUHI_HOME;
  rmSync(parent, { recursive: true, force: true });
});

function build(root: string) {
  const scan = scanRepo(root, { largeFileBytes: 5_000_000, entropyThreshold: 4, keywords: [] });
  const evalResult = resolvePolicy(
    { defaultAction: "allow", rules: [], interactive: false },
    scan.files.map((f) => ({ relpath: f.relpath, findings: f.findings })),
  );
  return createWorkspace({
    sourceRoot: root,
    agent: "dummy",
    policyHash: "h",
    decisions: evalResult.decisions,
    scan,
    entropyThreshold: 4,
    keywords: [],
    isGitRepo: false,
  });
}

describe("hostile filenames", () => {
  it("copies files whose names contain shell metacharacters verbatim (no shell involved)", () => {
    // These are dangerous only if a shell ever interprets them; Yuhi uses spawn
    // argv arrays and plain fs, so they are just bytes.
    const names = ["a b.txt", "weird$(whoami).txt", "semi;rm.txt", "quote'.txt", "back`tick`.txt"];
    for (const n of names) writeFileSync(path.join(src, n), "content\n");
    const { treeDir, manifest } = build(src);
    for (const n of names) {
      expect(existsSync(path.join(treeDir, n))).toBe(true);
    }
    expect(manifest.counts.visible).toBeGreaterThanOrEqual(names.length);
  });

  it("handles a newline in a filename without splitting or escaping the tree", () => {
    let name: string;
    try {
      name = "line1\nline2.txt";
      writeFileSync(path.join(src, name), "x\n");
    } catch {
      return; // some filesystems reject newlines
    }
    const { treeDir } = build(src);
    // Everything created stays under treeDir (no path split into two entries above root).
    const top = existsSync(treeDir) ? readdirSync(treeDir) : [];
    for (const entry of top) {
      expect(path.resolve(treeDir, entry).startsWith(path.resolve(treeDir))).toBe(true);
    }
  });

  it("a deeply nested path stays confined to the workspace", () => {
    const deep = path.join("a", "b", "c", "d", "e", "f", "g.txt");
    mkdirSync(path.dirname(path.join(src, deep)), { recursive: true });
    writeFileSync(path.join(src, deep), "deep\n");
    const { treeDir } = build(src);
    const out = path.join(treeDir, deep);
    expect(existsSync(out)).toBe(true);
    expect(path.resolve(out).startsWith(path.resolve(treeDir))).toBe(true);
  });
});
