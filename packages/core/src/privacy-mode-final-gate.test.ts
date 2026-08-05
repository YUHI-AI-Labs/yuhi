/**
 * Regression test for the Trusted Local final-artifact security gate.
 *
 * Bug (found via release smoke-testing the packaged CLI, v0.4.8): a tabular file with
 * direct personal identifiers, under Trusted Local, is correctly delivered RAW (Trusted
 * Local never transforms direct identifiers — see docs/design/0.4.8_privacy_mode.md).
 * But `prepareWorkspace`'s final-artifact security gate (which re-scans delivered bytes
 * for surviving identifier values, independent of any earlier in-memory flag) reported
 * this expected, correct outcome as `postTransformScan: "failed"` /
 * `failureCategory: "reidentification-risk"` — Balanced/Strict-flavored framing that
 * wrongly implies a failed verification, for something Trusted Local never attempted.
 *
 * These tests pin the CORRECTED behavior: Trusted Local residue is reported as
 * `postTransformScan: "not-applicable"` with no `failureCategory` and an accurate
 * "intentionally left unmasked" reason, while Balanced (which does attempt the
 * transform) keeps the original, unchanged pass/fail semantics.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareWorkspace } from "./prepare-workspace.js";
import type { PrivacyMode } from "@yuhi/shared";

let dir: string;
let managedDir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuhi-privacy-gate-src-"));
  managedDir = mkdtempSync(path.join(tmpdir(), "yuhi-privacy-gate-managed-"));
  process.env.YUHI_HOME = managedDir;

  const abs = path.join(dir, "data/students.csv");
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    "name,student_id,score\nTanaka Aoi,S-10241,42\nSato Ren,S-10242,88\n",
  );
  writeFileSync(
    path.join(dir, "yuhi.yaml"),
    'version: "1"\ninclude_untracked: true\ndefaults: { action: allow }\nrules: []\n',
  );
});

afterEach(() => {
  delete process.env.YUHI_HOME;
  rmSync(dir, { recursive: true, force: true });
  rmSync(managedDir, { recursive: true, force: true });
});

async function run(privacyMode: PrivacyMode) {
  const report = await prepareWorkspace(dir, {
    managedWorkspaceBase: managedDir,
    privacyMode,
    deferDocumentInspection: true,
  });
  const entry = report.files.find(
    (f) => (f.originalRelpath ?? f.relpath) === "data/students.csv",
  );
  if (!entry) throw new Error("students.csv entry missing from report.files");
  return entry;
}

describe("prepareWorkspace — final-artifact gate, Trusted Local vs Balanced", () => {
  it("Trusted Local: surviving identifiers are reported as not-applicable, not a failed verification", async () => {
    const entry = await run("trusted-local");

    expect(entry.transformed).toBe(false);
    expect(entry.postTransformScan).toBe("not-applicable");
    expect(entry.failureCategory).toBeUndefined();
    expect(entry.error).toMatch(/trusted local/i);
    expect(entry.error).toMatch(/intentionally left unmasked/i);
    expect(entry.error).not.toMatch(/will be pseudonymized/i);
  });

  it("Balanced: a tabular direct-identifier file is actually transformed (masked), not left raw", async () => {
    const entry = await run("balanced");

    // Balanced attempts and verifies the transform for this fixture; it must not hit
    // the residue branch at all — confirms the Trusted Local fix did not loosen
    // Balanced's own verification path.
    expect(entry.transformed).toBe(true);
    expect(entry.failureCategory).toBeUndefined();
    expect(entry.postTransformScan).toBe("passed");
  });
});
