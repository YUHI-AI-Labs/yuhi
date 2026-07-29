import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  rmSync,
  chmodSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { LocalModelProvider } from "@yuhi/shared";
import { prepareWorkspace, SOURCE_INTEGRITY_ERROR } from "./prepare-workspace.js";
import { buildPreparedMetrics, buildPreparedRuntimeBoundary } from "./prepared-metrics.js";

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

  it("acceptance: prepares a synthetic mixed-sensitivity workspace without changing sources", async () => {
    const acceptanceYaml =
      'version: "1"\nrules:\n' +
      "  - name: secrets-stay-local\n" +
      '    match: { paths: [".env"] }\n' +
      "    action: local-only\n" +
      "  - name: employee-data-confidential\n" +
      '    match: { paths: ["data/employees.csv"] }\n' +
      "    action: prepare-locally\n" +
      "    processors: [summarize-local, pseudonymize, safety-check]\n" +
      "  - name: salary-restricted\n" +
      '    match: { paths: ["data/salaries.csv"] }\n' +
      "    action: local-only\n" +
      "  - name: internal-notes-local\n" +
      '    match: { paths: ["docs/internal/**"] }\n' +
      "    action: local-only\n" +
      "  - name: summarize-large-doc\n" +
      '    match: { paths: ["docs/large.md"] }\n' +
      "    action: prepare-locally\n" +
      "    processors: [summarize-local, pseudonymize, safety-check]\n";
    const files: Record<string, string | Buffer> = {
      "src/app.ts": "export function main() { return 'ready'; }\n",
      "README.md": "# Synthetic application\nRuns a local demonstration.\n",
      ".env": "YUHI_FAKE_API_KEY=YUHI_SYNTHETIC_SECRET_NOT_REAL\n",
      "data/employees.csv": "employee_id,name,team\nE-1001,Example Person,Research\n",
      "data/salaries.csv": "employee_id,synthetic_salary\nE-1001,12345\n",
      "docs/internal/notes.md": "# Internal\nSynthetic planning notes only.\n",
      "logo.bin": Buffer.from([0, 255, 1, 254, 2, 253]),
      "docs/large.md": "# Synthetic handbook\n" + "Public process description. ".repeat(800),
      "yuhi.yaml": acceptanceYaml,
    };
    for (const [rel, content] of Object.entries(files)) put(rel, content as string);

    const hash = (rel: string) =>
      createHash("sha256").update(readFileSync(path.join(dir, rel))).digest("hex");
    const before = new Map(Object.keys(files).map((rel) => [rel, hash(rel)]));

    const report = await prepareWorkspace(dir, {
      provider: {
        ...fakeProvider(),
        async generate() {
          return "Summary: employee E-1001 works in Research. The handbook describes the public process.";
        },
      },
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    for (const rel of Object.keys(files)) expect(hash(rel), `${rel} changed`).toBe(before.get(rel));
    expect(report.sourceModified).toBe(0);
    expect(report.errors).toHaveLength(0);

    const absent = [".env", "data/salaries.csv", "docs/internal/notes.md", "logo.bin"];
    for (const rel of absent) expect(existsSync(path.join(report.outDir, rel)), rel).toBe(false);
    expect(readFileSync(path.join(report.outDir, "src/app.ts"), "utf8")).toBe(files["src/app.ts"]);
    expect(readFileSync(path.join(report.outDir, "README.md"), "utf8")).toBe(files["README.md"]);

    const employee = readFileSync(path.join(report.outDir, "data/employees.csv"), "utf8");
    const large = readFileSync(path.join(report.outDir, "docs/large.md"), "utf8");
    const preparedText = employee + large + readFileSync(path.join(report.outDir, "manifest.json"), "utf8");
    expect(preparedText).not.toContain("YUHI_SYNTHETIC_SECRET_NOT_REAL");
    expect(employee).not.toContain("E-1001");
    expect(employee).toMatch(/Subject-[0-9A-F]{6}/);
    expect(large.length).toBeLessThan((files["docs/large.md"] as string).length);

    const salaryDecision = report.decisions?.find((d) => d.relpath === "data/salaries.csv");
    expect(salaryDecision?.action).toBe("local-only");
    expect(salaryDecision?.ruleName).toBe("salary-restricted");
    expect(report.files.find((f) => f.relpath === "logo.bin")?.omitted).toBe(true);
    expect(report.report.filesSummarized).toBe(2);
    const metrics = buildPreparedMetrics(report);
    expect(metrics.filesInspected).toBe(report.files.length);
    expect(metrics.preparedFilesModified).toBe(
      report.files.filter((file) => file.status === "ok" && !file.omitted && file.transformed).length,
    );
    expect(metrics.filesWithMaskedValues).toBe(
      report.files.filter((file) => (file.maskedValues ?? 0) > 0).length,
    );
    expect(metrics.sensitiveValuesMasked).toBe(
      report.files.reduce((total, file) => total + (file.maskedValues ?? 0), 0),
    );
    expect(metrics.filesKeptLocal).toBe(3);
    expect(metrics.filesExcluded).toBe(1);
  });

  it("uses the exact shared runtime-boundary model", () => {
    expect(buildPreparedRuntimeBoundary()).toEqual({
      initialContextPrepared: true,
      startDirectory: "prepared-workspace",
      workspaceInstructionPresent: true,
      workspaceBoundary: "advisory",
      filesystemEnforcement: "none",
      osSandboxEnabled: false,
      externalPathAccessPossible: true,
    });
  });

  it("writes privacy-safe manifest schema v2 aggregates without raw finding data", async () => {
    const rawDescription = "YUHI_RAW_FINDING_DESCRIPTION_MUST_NOT_PERSIST";
    const rawSecret = "YUHI_SYNTHETIC_SECRET_MUST_NOT_PERSIST";
    put("secret.txt", rawSecret);
    put("yuhi.yaml", YAML);
    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    report.decisions?.forEach((decision) => {
      decision.findings.forEach((finding) => {
        finding.description = rawDescription;
      });
    });
    const manifestRaw = readFileSync(path.join(report.outDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifestRaw).not.toContain(rawDescription);
    expect(manifestRaw).not.toContain(rawSecret);
    expect(manifestRaw).not.toContain('"description"');
    expect(manifest.files.find((file: { relpath: string }) => file.relpath === "secret.txt"))
      .toMatchObject({
        findingCategoryCounts: expect.any(Object),
        findingSeverityCounts: expect.any(Object),
        unresolvedHighRiskCount: 0,
      });
  });

  describe("fail-closed source integrity", () => {
    const expectIntegrityFailure = async (
      setup: () => void,
      mutate?: () => void | Promise<void>,
    ) => {
      put("src/app.ts", APP);
      put("yuhi.yaml", 'version: "1"\nrules: []\n');
      setup();
      let error: unknown;
      try {
        await prepareWorkspace(dir, {
          provider: fakeProvider(),
          ...(mutate ? { beforeIntegrityVerification: mutate } : {}),
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(SOURCE_INTEGRITY_ERROR);
      expect((error as Error).message).not.toContain(dir);
      const sessions = existsSync(path.join(dir, ".yuhi"))
        ? readFileNames(path.join(dir, ".yuhi")).filter((name) => name.endsWith("session.json"))
        : [];
      expect(sessions).toHaveLength(0);
    };

    it("accepts unchanged regular files", async () => {
      put("src/app.ts", APP);
      put("yuhi.yaml", 'version: "1"\nrules: []\n');
      await expect(prepareWorkspace(dir, { provider: fakeProvider() })).resolves.toMatchObject({
        sourceModified: 0,
      });
    });

    it("fails when a source file is unreadable before hashing", async () => {
      const target = path.join(dir, "src", "app.ts");
      put("src/app.ts", APP);
      put("yuhi.yaml", 'version: "1"\nrules: []\n');
      chmodSync(target, 0);
      try {
        await expect(prepareWorkspace(dir, { provider: fakeProvider() })).rejects.toThrow(
          SOURCE_INTEGRITY_ERROR,
        );
      } finally {
        chmodSync(target, 0o600);
      }
    });

    it("fails when a source file is unreadable after hashing", async () => {
      const target = path.join(dir, "src", "app.ts");
      await expectIntegrityFailure(() => {}, () => chmodSync(target, 0));
      chmodSync(target, 0o600);
    });

    it("detects changed content", async () => {
      await expectIntegrityFailure(() => {}, () => put("src/app.ts", "changed\n"));
    });

    it("detects a deleted source file", async () => {
      await expectIntegrityFailure(() => {}, () => unlinkSync(path.join(dir, "src", "app.ts")));
    });

    it("detects a replaced source file even when bytes match", async () => {
      await expectIntegrityFailure(() => {}, () => {
        const target = path.join(dir, "src", "app.ts");
        const replacement = path.join(dir, "replacement.tmp");
        writeFileSync(replacement, APP);
        renameSync(replacement, target);
      });
    });

    it("detects a regular file changed into a directory", async () => {
      await expectIntegrityFailure(() => {}, () => {
        const target = path.join(dir, "src", "app.ts");
        unlinkSync(target);
        mkdirSync(target);
      });
    });

    it("detects a symlink target change", async () => {
      put("targets/one.txt", "one");
      put("targets/two.txt", "two");
      symlinkSync("targets/one.txt", path.join(dir, "linked.txt"));
      await expectIntegrityFailure(() => {}, () => {
        unlinkSync(path.join(dir, "linked.txt"));
        symlinkSync("targets/two.txt", path.join(dir, "linked.txt"));
      });
    });

    it("detects a symlink replaced by a regular file", async () => {
      put("target.txt", "target");
      symlinkSync("target.txt", path.join(dir, "linked.txt"));
      await expectIntegrityFailure(() => {}, () => {
        unlinkSync(path.join(dir, "linked.txt"));
        writeFileSync(path.join(dir, "linked.txt"), "target");
      });
    });

    it("rejects a symlink that escapes the source root", async () => {
      const outside = mkdtempSync(path.join(tmpdir(), "yuhi-integrity-outside-"));
      try {
        writeFileSync(path.join(outside, "outside.txt"), "outside");
        symlinkSync(path.join(outside, "outside.txt"), path.join(dir, "outside-link"));
        await expectIntegrityFailure(() => {});
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("detects a file added after the inspected set is frozen", async () => {
      await expectIntegrityFailure(() => {}, () => put("src/added.ts", "export {};\n"));
    });
  });
});

function readFileNames(root: string): string[] {
  const output: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else output.push(absolute);
    }
  };
  walk(root);
  return output;
}
