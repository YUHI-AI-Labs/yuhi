import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LocalModelProvider } from "@yuhi/shared";
import { prepareWorkspace } from "./prepare-workspace.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuhi-prepws-"));
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

/** Fake LOCAL provider — no network. Returns a summary that mentions one identifier
 *  so the pseudonymize step has something to mask before the safety-check passes. */
function fakeProvider(): LocalModelProvider {
  return {
    id: "fake",
    endpoint: "",
    defaultModel: "m",
    async health() {
      return { ok: true, detail: "", endpoint: "" };
    },
    async listModels() {
      return ["m"];
    },
    async generate() {
      return "Summary: student Tanaka Aoi and one other; scores were 42 and 88.";
    },
  };
}

const CSV =
  "name,student_id,score\n" + "Tanaka Aoi,S-10241,42\n" + "Sato Ren,S-10242,88\n";
const APP = "export const answer = 42;\n";

const YAML =
  'version: "1"\nrules:\n' +
  "  - name: prep-data\n" +
  '    match: { paths: ["data/students.csv"] }\n' +
  "    action: prepare-locally\n" +
  "    processors: [summarize-local, pseudonymize, safety-check]\n" +
  "  - name: keep-secrets-out\n" +
  '    match: { paths: ["secret.txt"] }\n' +
  "    action: block\n";

describe("prepareWorkspace", () => {
  it("summarizes + pseudonymizes + safety-checks, writes prepared dir, leaves source untouched", async () => {
    put("data/students.csv", CSV);
    put("src/app.ts", APP);
    put("secret.txt", "top secret\n");
    put("yuhi.yaml", YAML);

    // Snapshot source mtimes/content to prove read-only behavior.
    const csvAbs = path.join(dir, "data/students.csv");
    const appAbs = path.join(dir, "src/app.ts");
    const csvBefore = { content: readFileSync(csvAbs, "utf8"), mtime: statSync(csvAbs).mtimeMs };
    const appBefore = { content: readFileSync(appAbs, "utf8"), mtime: statSync(appAbs).mtimeMs };

    const messages: string[] = [];
    const report = await prepareWorkspace(dir, {
      provider: fakeProvider(),
      createdAt: "2026-01-01T00:00:00.000Z",
      onProgress: (m) => messages.push(m),
    });

    // Prepared output directory exists under .yuhi/prepared/<runId>.
    expect(report.outDir).toContain(path.join(".yuhi", "prepared", report.runId));
    expect(existsSync(report.outDir)).toBe(true);

    // The summarize target ran the full pipeline and is approved.
    const csvEntry = report.files.find((f) => f.relpath === "data/students.csv");
    expect(csvEntry?.status).toBe("ok");
    expect(csvEntry?.transmission).toBe("approved");
    expect(report.blocked).toHaveLength(0);
    expect(report.errors).toHaveLength(0);
    expect(report.sourceModified).toBe(0);

    // Prepared CSV: summarized + identifier masked (pseudonymize + safety-check ran).
    const preparedCsv = readFileSync(path.join(report.outDir, "data", "students.csv"), "utf8");
    expect(preparedCsv).toMatch(/Summary/);
    expect(preparedCsv).not.toContain("Tanaka Aoi");
    expect(preparedCsv).toMatch(/Subject-[0-9A-F]{6}/);

    // `allow` file copied verbatim.
    expect(readFileSync(path.join(report.outDir, "src", "app.ts"), "utf8")).toBe(APP);

    // Blocked file omitted from the prepared tree.
    expect(existsSync(path.join(report.outDir, "secret.txt"))).toBe(false);
    const secretEntry = report.files.find((f) => f.relpath === "secret.txt");
    expect(secretEntry?.omitted).toBe(true);

    // Manifest written with an aggregate reduction report.
    const manifest = JSON.parse(readFileSync(path.join(report.outDir, "manifest.json"), "utf8"));
    expect(manifest.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(manifest.reduction).toBeDefined();
    expect(manifest.reduction.beforeTokens).toBeGreaterThan(0);
    expect(manifest.reduction.filesSummarized).toBe(1);
    expect(manifest.reduction.sensitiveMasked).toBe(1);
    expect(manifest.sourceModified).toBe(0);
    expect(Array.isArray(manifest.provenance)).toBe(true);
    expect(manifest.provenance.some((p: { source: string }) => p.source === "data/students.csv")).toBe(true);

    // Report-level reduction matches manifest.
    expect(report.report.filesSummarized).toBe(1);
    expect(report.report.approx).toBe(true);

    // SOURCE FILES UNCHANGED (content + mtime).
    expect(readFileSync(csvAbs, "utf8")).toBe(csvBefore.content);
    expect(readFileSync(appAbs, "utf8")).toBe(appBefore.content);
    expect(statSync(csvAbs).mtimeMs).toBe(csvBefore.mtime);
    expect(statSync(appAbs).mtimeMs).toBe(appBefore.mtime);

    // Progress callback fired.
    expect(messages.length).toBeGreaterThan(0);
  });
});
