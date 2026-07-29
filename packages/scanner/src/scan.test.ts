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

  it("excludes generated dependency and cache directories by default", () => {
    write("src/index.ts", "export const x = 1;\n");
    for (const dir of [
      ".git", ".yuhi", "node_modules", ".venv", "venv", ".tox", ".mypy_cache",
      ".pytest_cache", "__pycache__", ".next", ".turbo", "dist", "build",
      "coverage", "target", "out", ".pnpm-store",
    ]) {
      write(`${dir}/generated.txt`, "generated");
    }
    const paths = scanRepo(root, opts).files.map((file) => file.relpath);
    expect(paths).toContain("src/index.ts");
    expect(paths.filter((file) => file.endsWith("generated.txt"))).toEqual([]);
  });

  it("allows a safe explicit rule to include a normally generated directory", () => {
    write(".venv/explicit.txt", "explicit");
    const result = scanRepo(root, {
      ...opts,
      explicitIncludeDirs: new Set([".venv"]),
    });
    expect(result.files.map((file) => file.relpath)).toContain(".venv/explicit.txt");
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

  it("fails closed for XLSX when no local spreadsheet parser is available", () => {
    const abs = path.join(root, "synthetic-records.xlsx");
    writeFileSync(abs, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]));
    const result = scanRepo(root, opts);
    const file = result.files.find((item) => item.relpath === "synthetic-records.xlsx");
    expect(file?.findings[0]?.detector).toBe("tabular-unparsed-spreadsheet");
    expect(file?.findings[0]?.severity).toBe("high");
    expect(file?.inspection).toMatchObject({
      fileType: "xlsx",
      parserAvailable: false,
      inspectionAttempted: false,
      inspectionSucceeded: false,
      contentVerified: false,
    });
  });

  it("does not call an unparsed PDF verified or public-by-absence", () => {
    writeFileSync(path.join(root, "synthetic.pdf"), Buffer.from("%PDF-1.7\nsynthetic\n"));
    const file = scanRepo(root, opts).files.find((item) => item.relpath === "synthetic.pdf");
    expect(file?.findings).toEqual([]);
    expect(file?.inspection).toMatchObject({
      fileType: "pdf",
      parserAvailable: false,
      inspectionAttempted: false,
      inspectionSucceeded: false,
      contentVerified: false,
    });
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
