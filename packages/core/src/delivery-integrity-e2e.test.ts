import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareWorkspace } from "./prepare-workspace.js";
import { buildSafePreparedRunSummary } from "./prepared-run.js";
import { postTransformScanLabel } from "./delivery-integrity.js";

/**
 * Cross-surface delivery honesty (#12), end to end.
 *
 * A residual identifier in an UNCLASSIFIED column used to block the pipeline and
 * ship the entire raw original — every identifier in the file — because of one
 * cell. Now the partially de-identified output is delivered instead, and every
 * surface reports that truthfully.
 */

let dir: string;
let managedDir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuhi-integrity-"));
  managedDir = mkdtempSync(path.join(tmpdir(), "yuhi-managed-"));
  process.env.YUHI_HOME = managedDir;
});
afterEach(() => {
  delete process.env.YUHI_HOME;
  rmSync(dir, { recursive: true, force: true });
  rmSync(managedDir, { recursive: true, force: true });
});

function put(rel: string, content: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A name value echoed into a free-text column no classifier recognizes. */
const RESIDUE_TABLE =
  "氏名,メモ,成績\n" +
  "STUDENT_CANARY_001,follow up with STUDENT_CANARY_001,85\n" +
  "STUDENT_CANARY_002,no issues,92\n" +
  "STUDENT_CANARY_003,no issues,78\n";

describe("a residual identifier never causes the raw original to be delivered", () => {
  it("delivers the partially de-identified output and reports the scan as failed", async () => {
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    put("records.csv", RESIDUE_TABLE);

    const report = await prepareWorkspace(dir, {});
    const outDir = report.outDir;
    const delivered = readFileSync(path.join(outDir, "records.csv"), "utf8");

    // The delivered artifact is NOT the raw original.
    expect(sha(delivered)).not.toBe(sha(RESIDUE_TABLE));
    // The classified 氏名 column was pseudonymized.
    expect(delivered).not.toContain("STUDENT_CANARY_002");
    expect(delivered).not.toContain("STUDENT_CANARY_003");
    // Measures survive.
    for (const grade of ["85", "92", "78"]) expect(delivered).toContain(grade);

    const acceptance = report.tabularAcceptance!;
    const integrity = acceptance.deliveryIntegrity!;

    // No raw fallback happened, and the surface says so honestly.
    expect(acceptance.rawFallbackUsed).toBe(false);
    expect(integrity.rawFallbackFiles).toBe(0);
    // The residue in the unclassified column is reported, not hidden.
    expect(integrity.postTransformScanFailed).toBeGreaterThan(0);
    expect(acceptance.postTransformScanPassed).toBe(false);
    // A delivered file is never counted as excluded.
    expect(integrity.excludedByRecommendation).toBe(0);
    expect(integrity.deliveredWithWarning).toBeGreaterThan(0);

    // Copy rules: never "Not applicable" for a real failure.
    const label = postTransformScanLabel(integrity);
    expect(label).toMatch(/^Failed/);
    expect(label).not.toMatch(/Not applicable/);
  });

  it("agrees across report, manifest-facing summary and the CLI projection", async () => {
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    put("records.csv", RESIDUE_TABLE);

    const report = await prepareWorkspace(dir, {});
    const summary = buildSafePreparedRunSummary(report);
    const acceptance = report.tabularAcceptance!;

    // raw fallback count agrees
    expect(summary.rawFallbackUsed).toBe(acceptance.rawFallbackUsed);
    expect(summary.deliveryIntegrity?.rawFallbackFiles).toBe(
      acceptance.deliveryIntegrity?.rawFallbackFiles,
    );
    // identifier residue count agrees
    expect(summary.deliveryIntegrity?.rawFallbackWithFindings).toBe(
      acceptance.deliveryIntegrity?.rawFallbackWithFindings,
    );
    // delivered-with-warning count agrees
    expect(summary.deliveryIntegrity?.deliveredWithWarning).toBe(
      acceptance.deliveryIntegrity?.deliveredWithWarning,
    );
    // excluded count agrees, and is not inflated by delivered files
    expect(summary.deliveryIntegrity?.excludedByRecommendation).toBe(
      acceptance.deliveryIntegrity?.excludedByRecommendation,
    );
    expect(summary.deliveryIntegrity?.excludedByRecommendation).toBe(0);
    // scan verdict agrees
    expect(summary.postTransformScanPassed).toBe(acceptance.postTransformScanPassed);
  });
});

describe("a clean run reports clean, with no residue anywhere", () => {
  it("passes the scan and claims no raw fallback truthfully", async () => {
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    put(
      "clean.csv",
      "学籍番号,氏名,フリガナ,成績\n" +
        "SID_CANARY_001,STUDENT_CANARY_001,カナ_CANARY_001,85\n" +
        "SID_CANARY_002,STUDENT_CANARY_002,カナ_CANARY_002,92\n",
    );

    const report = await prepareWorkspace(dir, {});
    const delivered = readFileSync(path.join(report.outDir, "clean.csv"), "utf8");

    // A phonetic-name column is personal data and must be transformed too.
    for (const canary of [
      "STUDENT_CANARY_001",
      "STUDENT_CANARY_002",
      "SID_CANARY_001",
      "カナ_CANARY_001",
    ]) {
      expect(delivered).not.toContain(canary);
    }

    const acceptance = report.tabularAcceptance!;
    expect(acceptance.rawFallbackUsed).toBe(false);
    expect(acceptance.postTransformScanPassed).toBe(true);
    expect(acceptance.deliveryIntegrity?.postTransformScanFailed).toBe(0);
    expect(postTransformScanLabel(acceptance.deliveryIntegrity!)).toBe("Passed");
  });

  it("keeps 氏名 and フリガナ on the SAME entity rather than splitting them", async () => {
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    put(
      "both.csv",
      "学籍番号,氏名,フリガナ,成績\n" +
        "SID_CANARY_001,STUDENT_CANARY_001,カナ_CANARY_001,85\n",
    );
    const report = await prepareWorkspace(dir, {});
    const delivered = readFileSync(path.join(report.outDir, "both.csv"), "utf8");
    const [, row] = delivered.trim().split("\n");
    const cells = row!.split(",");
    // Entity-keyed tokens carry the same ordinal; column-scoped fallbacks would not.
    expect(cells[1]).toMatch(/^Student 0*1$/);
    expect(cells[2]).toMatch(/^Reading 0*1$/);
  });
});
