/**
 * The `prepare-locally` route actually runs: student data is pseudonymized by the
 * local RouteExecutor (pseudonymize → safety-check) and only the transformed copy
 * enters the workspace. The original on disk is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceForDir, runPrepareLocally } from "@yuhi/core";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuhi-prep-"));
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

const CSV =
  "name,student_id,class,score\n" +
  "Tanaka Aoi,S-10241,3-B,42\n" +
  "Sato Ren,S-10242,3-B,88\n";

describe("prepare-locally route (RouteExecutor)", () => {
  it("pseudonymizes student data in the workspace; original stays on disk", async () => {
    put("src/app.ts", "export const x = 1;\n");
    put("data/students.csv", CSV);
    put(
      "yuhi.yaml",
      'version: "1"\nrules:\n' +
        '  - name: prep\n' +
        '    match: { paths: ["data/students.csv"] }\n' +
        "    action: prepare-locally\n" +
        "    processors: [pseudonymize, safety-check]\n",
    );

    const { treeDir } = await createWorkspaceForDir(dir, { interactive: false });
    const aiCopy = readFileSync(path.join(treeDir, "data/students.csv"), "utf8");

    // Direct personal identifiers are gone and pseudonyms are present; the student id
    // is an operational key and is preserved so the scores stay joinable; analytical
    // columns are untouched.
    expect(aiCopy).not.toContain("Tanaka Aoi");
    expect(aiCopy).not.toContain("Sato Ren");
    expect(aiCopy).toMatch(/Subject-[0-9A-F]{6}/);
    expect(aiCopy).toContain("S-10241");
    expect(aiCopy).toContain("S-10242");
    expect(aiCopy).toContain("3-B");
    expect(aiCopy).toContain("42");

    // Original on disk is untouched.
    expect(readFileSync(path.join(dir, "data/students.csv"), "utf8")).toBe(CSV);
  });

  it("blocks the file when a validation processor fails", () => {
    // If the pipeline is only a validator against a value that IS present, it fails.
    const r = runPrepareLocally("name\nAlice\n", ["safety-check"], {});
    // safety-check with no pseudonymize: identifiers extracted = ["Alice"] (name column),
    // still present → not allowed.
    expect(r.allowed).toBe(false);
  });
});
