import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
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
  it("inspects files and respects .gitignore", async () => {
    write("src/index.ts", "export const x = 1;\n");
    write("build/out.js", "ignored");
    write(".gitignore", "build/\n");
    const res = await scanRepo(root, opts);
    const paths = res.files.map((f) => f.relpath);
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain("build/out.js");
  });

  it("excludes generated dependency and cache directories by default", async () => {
    write("src/index.ts", "export const x = 1;\n");
    for (const dir of [
      ".git", ".yuhi", "node_modules", ".venv", "venv", ".tox", ".mypy_cache",
      ".pytest_cache", "__pycache__", ".next", ".turbo", "dist", "build",
      "coverage", "target", "out", ".pnpm-store",
    ]) {
      write(`${dir}/generated.txt`, "generated");
    }
    const paths = (await scanRepo(root, opts)).files.map((file) => file.relpath);
    expect(paths).toContain("src/index.ts");
    expect(paths.filter((file) => file.endsWith("generated.txt"))).toEqual([]);
  });

  it("allows a safe explicit rule to include a normally generated directory", async () => {
    write(".venv/explicit.txt", "explicit");
    const result = await scanRepo(root, {
      ...opts,
      explicitIncludeDirs: new Set([".venv"]),
    });
    expect(result.files.map((file) => file.relpath)).toContain(".venv/explicit.txt");
  });

  it("finds secrets and records severity in the risk summary", async () => {
    // assembled at runtime so no complete token-shaped literal is committed
    write(".env", "OPENAI_API_KEY=" + "sk-proj-" + "abcdefghijklmnopqrstuvwxyz0123\n");
    const res = await scanRepo(root, opts);
    expect(res.findings.length).toBeGreaterThan(0);
    expect(res.riskSummary.critical + res.riskSummary.high).toBeGreaterThan(0);
  });

  it("marks binary files and does not scan them for secrets", async () => {
    const abs = path.join(root, "logo.bin");
    writeFileSync(abs, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
    const res = await scanRepo(root, opts);
    const f = res.files.find((x) => x.relpath === "logo.bin");
    expect(f?.flags.isBinary).toBe(true);
    expect(f?.findings.length).toBe(0);
  });

  it("fails closed for malformed XLSX", async () => {
    const abs = path.join(root, "synthetic-records.xlsx");
    writeFileSync(abs, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]));
    const result = await scanRepo(root, opts);
    const file = result.files.find((item) => item.relpath === "synthetic-records.xlsx");
    expect(file?.findings[0]?.detector).toBe("tabular-unparsed-spreadsheet");
    expect(file?.findings[0]?.severity).toBe("high");
    expect(file?.inspection).toMatchObject({
      fileType: "xlsx",
      parserAvailable: true,
      inspectionAttempted: true,
      inspectionSucceeded: false,
      contentVerified: false,
    });
  });

  it("does not call an unavailable PDF verified or public-by-absence", async () => {
    writeFileSync(path.join(root, "synthetic.pdf"), Buffer.from("%PDF-1.7\nsynthetic\n"));
    const file = (await scanRepo(root, {
      ...opts,
      documentInspector: {
        canInspect: (input) => input.relpath.endsWith(".pdf"),
        inspect: async () => ({
          status: "unavailable",
          extractedTextAvailable: false,
          extractionMethod: "none",
          warnings: ["synthetic-unavailable"],
        }),
      },
    })).files.find((item) => item.relpath === "synthetic.pdf");
    expect(file?.findings).toEqual([]);
    expect(file?.inspection).toMatchObject({
      fileType: "pdf",
      parserAvailable: false,
      inspectionAttempted: true,
      inspectionSucceeded: false,
      contentVerified: false,
    });
    expect(file?.documentInspection?.warnings).toEqual(["synthetic-unavailable"]);
  });

  it("scans extracted PDF text without persisting the text", async () => {
    writeFileSync(path.join(root, "secret.pdf"), Buffer.from("%PDF-1.7\nsynthetic\n"));
    const secret = "sk-proj-" + "abcdefghijklmnopqrstuvwxyz0123";
    const result = await scanRepo(root, {
      ...opts,
      documentInspector: {
        canInspect: (input) => input.relpath.endsWith(".pdf"),
        inspect: async (_file, consume) => {
          consume(`OPENAI_API_KEY=${secret}`);
          return {
            status: "inspected",
            extractedTextAvailable: true,
            extractionMethod: "pdf-text",
            pageCount: 1,
            warnings: [],
          };
        },
      },
    });
    const file = result.files.find((item) => item.relpath === "secret.pdf");
    expect(file?.findings.some((finding) => finding.detector === "api-key")).toBe(true);
    expect(file?.inspection.contentVerified).toBe(true);
    expect(file?.documentInspection).toMatchObject({
      status: "inspected",
      extractionMethod: "pdf-text",
      pageCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("acceptance: extracts and scans a real synthetic text-layer PDF locally", async () => {
    try {
      execFileSync("ps2pdf", ["-h"], { stdio: "ignore" });
      execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    } catch {
      return;
    }
    const secret = "sk-proj-" + "syntheticabcdefghijklmnopqrstu";
    const postscript = path.join(root, "source.ps");
    const pdf = path.join(root, "normal.pdf");
    writeFileSync(
      postscript,
      [
        "%!PS-Adobe-3.0",
        "/Courier findfont 12 scalefont setfont",
        `72 720 moveto (OPENAI_API_KEY=${secret}) show`,
        "showpage",
      ].join("\n"),
    );
    execFileSync("ps2pdf", [postscript, pdf], { stdio: "ignore" });
    unlinkSync(postscript);

    const result = await scanRepo(root, opts);
    const inspected = result.files.find((item) => item.relpath === "normal.pdf");
    expect(inspected?.documentInspection).toMatchObject({
      status: "inspected",
      extractedTextAvailable: true,
      extractionMethod: "pdf-text",
    });
    expect(inspected?.findings.some((finding) => finding.detector === "api-key")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("records symlinks without following them", async () => {
    write("real.txt", "hello");
    try {
      symlinkSync(path.join(root, "real.txt"), path.join(root, "link.txt"));
    } catch {
      return; // symlink creation may be restricted (e.g. Windows without privilege)
    }
    const res = await scanRepo(root, opts);
    const link = res.files.find((x) => x.relpath === "link.txt");
    expect(link?.flags.isSymlink).toBe(true);
    expect(res.warnings.some((w) => w.includes("Symlink skipped"))).toBe(true);
  });

  it("flags large files without reading them for detection", async () => {
    write("big.txt", "x".repeat(100));
    const res = await scanRepo(root, { ...opts, largeFileBytes: 10 });
    const big = res.files.find((x) => x.relpath === "big.txt");
    expect(big?.flags.isLarge).toBe(true);
  });
});
