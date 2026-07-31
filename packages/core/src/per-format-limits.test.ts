import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  oversizePassThroughReason,
  PDF_INSPECTION_LIMIT_BYTES,
  MAX_INMEMORY_TRANSFORM_BYTES,
  prepareWorkspace,
} from "./prepare-workspace.js";

const MB = 1024 * 1024;

describe("per-format inspection limits", () => {
  it("PDF: inspected up to 64 MB, passed through unverified beyond it", () => {
    expect(PDF_INSPECTION_LIMIT_BYTES).toBe(64 * MB);
    expect(oversizePassThroughReason("pdf", 63 * MB)).toBeUndefined();
    const reason = oversizePassThroughReason("pdf", 65 * MB);
    expect(reason).toContain("64 MB PDF inspection limit");
    expect(reason).toContain("Review before sharing");
  });

  it("text/xlsx: NOT gated at 2 MB — only at the in-memory ceiling", () => {
    for (const t of ["csv", "tsv", "txt", "xlsx"]) {
      expect(oversizePassThroughReason(t, 3 * MB)).toBeUndefined();   // 3 MB → inspected
      expect(oversizePassThroughReason(t, 50 * MB)).toBeUndefined();  // 50 MB → inspected
    }
    expect(MAX_INMEMORY_TRANSFORM_BYTES).toBe(128 * MB);
    expect(oversizePassThroughReason("csv", 200 * MB)).toContain("too large");
  });

  it("a 3 MB CSV is de-identified end-to-end (previously skipped at 2 MB)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yuhi-pf-"));
    await writeFile(path.join(dir, "yuhi.yaml"),
      (await readFile(path.join(__dirname, "../../../yuhi.yaml"), "utf8")).replace("include_untracked: false", "include_untracked: true"));
    const header = "氏名,学籍番号,学生証番号,評定\n";
    const row = "山田太郎,123456,A000000,A\n";
    await writeFile(path.join(dir, "big.csv"), header + row.repeat(Math.ceil((3 * MB) / row.length)));
    const report = await prepareWorkspace(dir);
    const entry = report.files.find((f) => f.relpath === "big.csv");
    expect(entry?.outcome).toBe("included-transformed");
    const out = await readFile(path.join(report.outDir, "big.csv"), "utf8");
    expect(out).not.toContain("山田太郎");
    expect(out).not.toContain("A000000");
    expect(out).toContain("Student 001"); // de-identified
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await rm(report.outDir, { recursive: true, force: true }).catch(() => {});
  }, 60_000);
});
