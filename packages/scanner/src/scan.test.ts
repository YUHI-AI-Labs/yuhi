import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanRepo } from "./scan.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "yuhi-scan-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const opts = { largeFileBytes: 5_000_000, entropyThreshold: 4.0, keywords: [] as string[] };

describe("scanRepo", () => {
  it("inspects files and respects .gitignore", () => {
    write("src/index.ts", "export const x = 1;\n");
    write("build/out.js", "ignored");
    write(".gitignore", "build/\n");
    const res = scanRepo(root, opts);
    const paths = res.files.map((f) => f.relpath);
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain("build/out.js");
  });

  it("finds secrets and records severity in the risk summary", () => {
    // assembled at runtime so no complete token-shaped literal is committed
    write(".env", "OPENAI_API_KEY=" + "sk-proj-" + "abcdefghijklmnopqrstuvwxyz0123\n");
    const res = scanRepo(root, opts);
    expect(res.findings.length).toBeGreaterThan(0);
    expect(res.riskSummary.critical + res.riskSummary.high).toBeGreaterThan(0);
  });

  it("marks binary files and does not scan them for secrets", () => {
    const abs = path.join(root, "logo.bin");
    writeFileSync(abs, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
    const res = scanRepo(root, opts);
    const f = res.files.find((x) => x.relpath === "logo.bin");
    expect(f?.flags.isBinary).toBe(true);
    expect(f?.findings.length).toBe(0);
  });

  it("records symlinks without following them", () => {
    write("real.txt", "hello");
    try {
      symlinkSync(path.join(root, "real.txt"), path.join(root, "link.txt"));
    } catch {
      return; // symlink creation may be restricted (e.g. Windows without privilege)
    }
    const res = scanRepo(root, opts);
    const link = res.files.find((x) => x.relpath === "link.txt");
    expect(link?.flags.isSymlink).toBe(true);
    expect(res.warnings.some((w) => w.includes("Symlink skipped"))).toBe(true);
  });

  it("flags large files without reading them for detection", () => {
    write("big.txt", "x".repeat(100));
    const res = scanRepo(root, { ...opts, largeFileBytes: 10 });
    const big = res.files.find((x) => x.relpath === "big.txt");
    expect(big?.flags.isLarge).toBe(true);
  });
});
