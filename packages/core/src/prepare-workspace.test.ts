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
import {
  prepareWorkspace,
  prepareWorkspaceOutcome,
  SOURCE_INTEGRITY_ERROR,
} from "./prepare-workspace.js";
import {
  buildPreparedFileDecisions,
  buildPreparedMetrics,
  buildPreparedRuntimeBoundary,
} from "./prepared-metrics.js";

let dir: string;
let managedDir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuhi-prepws-"));
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
  it("keeps an unsupported PDF local with an explicit limitation", async () => {
    writeFileSync(path.join(dir, "synthetic.pdf"), Buffer.from("%PDF-1.7\nsynthetic\n"));
    put("safe.md", "Synthetic safe content.\n");
    put("yuhi.yaml", 'version: "1"\nrules: []\n');

    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const entry = report.files.find((item) => item.relpath === "synthetic.pdf");
    expect(entry).toMatchObject({
      action: "local-only",
      status: "skipped",
      outcome: "local-only-unsupported",
      omitted: true,
      limitation: "inspection-unavailable",
      inspection: {
        fileType: "pdf",
        parserAvailable: false,
        scannerAvailable: false,
        transformerAvailable: false,
        postTransformVerifierAvailable: false,
        contentVerified: false,
      },
    });
    expect(existsSync(path.join(report.outDir, "synthetic.pdf"))).toBe(false);
    expect(report.tabularAcceptance).toMatchObject({
      unsupportedOrUnverifiedFiles: 1,
      restrictedUnresolvedFiles: 0,
      hasLimitations: true,
      launchAllowed: true,
    });
    expect(buildPreparedFileDecisions(report).find((item) => item.relativePath === "synthetic.pdf"))
      .toMatchObject({
        sensitivityLevel: "Unknown",
        agentReceives: "No",
        inspectionStatus: "Not available",
        limitationShown: true,
      });
  });

  it("makes an unsupported high-risk XLSX Partial and blocks launch", async () => {
    writeFileSync(
      path.join(dir, "synthetic.xlsx"),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]),
    );
    put("safe.md", "Synthetic safe content.\n");
    put("yuhi.yaml", 'version: "1"\nrules: []\n');

    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const entry = report.files.find((item) => item.relpath === "synthetic.xlsx");
    expect(entry).toMatchObject({
      action: "local-only",
      status: "error",
      outcome: "local-only-unverified",
      omitted: true,
      limitation: "transformation-unavailable",
    });
    expect(existsSync(path.join(report.outDir, "synthetic.xlsx"))).toBe(false);
    expect(report.tabularAcceptance).toMatchObject({
      unsupportedOrUnverifiedFiles: 1,
      restrictedUnresolvedFiles: 1,
      unverifiedTransformations: 1,
      rawFallbackUsed: false,
      launchAllowed: false,
    });
    expect(buildPreparedFileDecisions(report).find((item) => item.relativePath === "synthetic.xlsx"))
      .toMatchObject({
        sensitivityLevel: "Restricted",
        agentReceives: "No",
        outcome: "local-only-unverified",
      });
  });

  it("automatically pseudonymizes detected structured personal data before inclusion", async () => {
    const raw = "\uFEFFフルネーム,IDナンバ,学生証番号,評定\nSynthetic Person,100001,200001,A\n";
    const relpath = "合成評定.csv";
    put(
      relpath,
      raw,
    );
    put("README.md", "Synthetic fixture.\n");
    put("yuhi.yaml", 'version: "1"\nrules: []\n');

    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const decision = report.decisions?.find((item) => item.relpath === relpath);
    const entry = report.files.find((item) => item.relpath === relpath);

    expect(decision?.action).toBe("prepare-locally");
    expect(decision?.findings.length).toBeGreaterThanOrEqual(2);
    expect(entry?.omitted).not.toBe(true);
    expect(entry?.transformed).toBe(true);
    expect(report.tabularAcceptance).toMatchObject({
      entitiesPseudonymized: 1,
      identifierColumnsTransformed: 3,
      analyticalColumnsPreserved: 1,
      postTransformScanPassed: true,
      rawFallbackUsed: false,
      launchAllowed: true,
      claudeCodeStarted: false,
    });
    const prepared = readFileSync(path.join(report.outDir, relpath), "utf8");
    expect(prepared).toContain("Student 001,SID-001,CARD-001,A");
    expect(prepared).not.toContain("Synthetic Person");
    expect(prepared).not.toContain("100001");
    expect(prepared).not.toContain("200001");
    expect(readFileSync(path.join(dir, relpath), "utf8")).toBe(raw);
    const reviewDecision = buildPreparedFileDecisions(report)
      .find((item) => item.relativePath === relpath);
    expect(reviewDecision).toMatchObject({
      sensitivityLevel: "Restricted",
      included: true,
      transformed: true,
      agentReceives: "Transformed",
    });
    expect(reviewDecision?.transformationKinds).toContain("pseudonymized");
    expect(readFileSync(path.join(report.outDir, "README.md"), "utf8")).toBe("Synthetic fixture.\n");
  });

  it("does not reject an analytical number merely because it equals a source ID", async () => {
    const raw =
      "full name,student id,student card number,quiz score,grade\n" +
      "Synthetic One,100,9001,100,A\n" +
      "Synthetic Two,200,9002,100,B\n";
    put("numeric-overlap.csv", raw);
    put("yuhi.yaml", 'version: "1"\nrules: []\n');

    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const entry = report.files.find((item) => item.relpath === "numeric-overlap.csv");
    expect(entry?.status).toBe("ok");
    expect(entry?.transformed).toBe(true);
    const rows = readFileSync(path.join(report.outDir, "numeric-overlap.csv"), "utf8");
    expect(rows).toContain("Student 001,SID-001,CARD-001,100,A");
    expect(rows).toContain("Student 002,SID-002,CARD-002,100,B");
  });

  it("pseudonymizes suffixed Japanese ID headers and blocks headerless companion data", async () => {
    const csv =
      "\uFEFF学生証番号6桁,評点\n" +
      Array.from({ length: 20 }, (_, index) => `${String(300000 + index)},${index % 101}`).join("\n") +
      "\n";
    const txt = Array.from(
      { length: 20 },
      (_, index) => `123456,${String(300000 + index)},${index % 101}`,
    ).join("\n");
    put("synthetic-check.csv", csv);
    put("synthetic-companion.txt", txt);
    put("yuhi.yaml", 'version: "1"\nrules: []\n');

    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const csvEntry = report.files.find((item) => item.relpath === "synthetic-check.csv");
    const txtEntry = report.files.find((item) => item.relpath === "synthetic-companion.txt");
    expect(csvEntry).toMatchObject({ status: "ok", transformed: true });
    expect(csvEntry?.omitted).not.toBe(true);
    expect(readFileSync(path.join(report.outDir, "synthetic-check.csv"), "utf8"))
      .toContain("CARD-001");
    expect(txtEntry).toMatchObject({ status: "error", action: "local-only", omitted: true });
    expect(existsSync(path.join(report.outDir, "synthetic-companion.txt"))).toBe(false);
  });

  it("fails closed when a detected sensitive table cannot be transformed safely", async () => {
    const raw = 'full name,student id,grade\n"unterminated,S-1,A';
    put("malformed.csv", raw);
    put("yuhi.yaml", 'version: "1"\nrules: []\n');

    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const entry = report.files.find((item) => item.relpath === "malformed.csv");
    expect(entry?.status).toBe("error");
    expect(entry?.action).toBe("local-only");
    expect(entry?.omitted).toBe(true);
    expect(existsSync(path.join(report.outDir, "malformed.csv"))).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.tabularAcceptance).toMatchObject({
      malformedTables: 1,
      rawFallbackUsed: false,
      launchAllowed: false,
      claudeCodeStarted: false,
    });
    expect(readFileSync(path.join(dir, "malformed.csv"), "utf8")).toBe(raw);
  });

  it("creates a new immutable run when blocked files are explicitly excluded", async () => {
    put("malformed.csv", 'full name,student id,grade\n"unterminated,S-1,A');
    put("safe.md", "Synthetic safe content.\n");
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    const partial = await prepareWorkspace(dir, { provider: fakeProvider() });
    expect(partial.errors).toHaveLength(1);
    const oldManifest = readFileSync(path.join(partial.outDir, "manifest.json"), "utf8");

    const recovered = await prepareWorkspace(dir, {
      provider: fakeProvider(),
      excludeRelpaths: ["malformed.csv"],
    });
    expect(recovered.runId).not.toBe(partial.runId);
    expect(recovered.errors).toHaveLength(0);
    expect(recovered.files.find((file) => file.relpath === "malformed.csv")).toMatchObject({
      action: "block",
      status: "skipped",
      omitted: true,
    });
    expect(existsSync(path.join(recovered.outDir, "malformed.csv"))).toBe(false);
    expect(readFileSync(path.join(partial.outDir, "manifest.json"), "utf8")).toBe(oldManifest);
  });

  it("honors explicit aggregation and removes all individual identifiers", async () => {
    const raw =
      "full name,student id,quiz score,grade\n" +
      "Synthetic A,S-1,80,A\nSynthetic B,S-2,60,B\n";
    put("records.csv", raw);
    put(
      "yuhi.yaml",
      'version: "1"\nrules:\n' +
        "  - name: aggregate-records\n" +
        '    match: { paths: ["records.csv"] }\n' +
        "    action: prepare-locally\n" +
        "    processors: [aggregate-student-records, safety-check]\n",
    );
    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const prepared = readFileSync(path.join(report.outDir, "records.csv"), "utf8");
    expect(prepared).toContain("quiz score,2,70");
    expect(prepared).not.toContain("Synthetic A");
    expect(prepared).not.toContain("S-1");
    expect(report.files.find((item) => item.relpath === "records.csv")?.transformations)
      .toContain("aggregated");
  });

  it("links the same ID across files in one run without persisting a mapping", async () => {
    put("first.csv", "full name,student id,score\nSynthetic Name,S-1,80\n");
    put("second.csv", "full name,student id,grade\nSYNTHETIC NAME,S-1,A\n");
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const first = readFileSync(path.join(report.outDir, "first.csv"), "utf8");
    const second = readFileSync(path.join(report.outDir, "second.csv"), "utf8");
    expect(first).toContain("Student 001,SID-001,80");
    expect(second).toContain("Student 001,SID-001,A");
    const persisted = readFileNames(report.outDir)
      .map((file) => readFileSync(file))
      .map((buffer) => buffer.toString("utf8"))
      .join("\n");
    expect(persisted).not.toContain("Synthetic Name");
    expect(persisted).not.toContain("SYNTHETIC NAME");
    expect(persisted).not.toContain("S-1");
    expect(readFileNames(report.outDir).some((file) => /mapping/i.test(file))).toBe(false);
  });

  it("discards a transformed candidate when exact-output privacy rescan fails", async () => {
    put("records.csv", "full name,student id,score\nSynthetic A,S-1,80\n");
    put(
      "yuhi.yaml",
      'version: "1"\nrules:\n' +
        "  - name: explicit-summary\n" +
        '    match: { paths: ["records.csv"] }\n' +
        "    action: prepare-locally\n" +
        "    processors: [summarize-local, safety-check]\n",
    );
    const provider: LocalModelProvider = {
      ...fakeProvider(),
      async generate() {
        return "Unsafe transformed candidate " + "sk-proj-" + "abcdefghijklmnopqrstuvwxyz0123";
      },
    };
    const report = await prepareWorkspace(dir, { provider });
    const entry = report.files.find((item) => item.relpath === "records.csv");
    expect(entry?.status).toBe("error");
    expect(entry?.action).toBe("local-only");
    expect(entry?.error).toBe("Transformed output failed Yuhi privacy rescan.");
    expect(existsSync(path.join(report.outDir, "records.csv"))).toBe(false);
    expect(report.errors).toContain(entry);
  });

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

    // Prepared output is outside the source tree, under Yuhi's managed root.
    expect(report.outDir).toBe(path.join(managedDir, "workspaces", report.runId));
    expect(report.outDir.startsWith(path.join(dir, ".yuhi"))).toBe(false);
    expect(existsSync(report.outDir)).toBe(true);
    expect(statSync(report.outDir).mode & 0o777).toBe(0o700);

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
    expect(metrics.filesKeptLocal).toBe(4);
    expect(metrics.filesExcluded).toBe(0);
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

  it("completes without inventorying a synthetic large .venv", async () => {
    for (let index = 0; index < 100; index += 1) {
      put(`src/file-${index}.ts`, `export const value${index} = ${index};\n`);
    }
    for (let index = 0; index < 2_000; index += 1) {
      put(`.venv/lib/package-${index}.py`, `generated = ${index}\n`);
    }
    put(".env", "YUHI_FAKE_SECRET=local-only\n");
    put(
      "yuhi.yaml",
      'version: "1"\nrules:\n' +
        '  - name: secrets-local\n    match: { paths: [".env"] }\n    action: local-only\n',
    );
    const progress: string[] = [];
    const report = await prepareWorkspace(dir, {
      provider: fakeProvider(),
      onProgress: (message) => progress.push(message),
    });
    expect(report.files.length).toBeLessThan(110);
    expect(report.files.some((file) => file.relpath.startsWith(".venv/"))).toBe(false);
    expect(existsSync(path.join(report.outDir, ".venv"))).toBe(false);
    expect(report.files.find((file) => file.relpath === ".env")?.omitted).toBe(true);
    expect(progress.some((message) => message.includes("Scanning sensitive information")))
      .toBe(true);
    expect(progress.some((message) => message.includes("Preparing safe copies"))).toBe(true);
    expect(progress.some((message) => message.includes("Verifying prepared output"))).toBe(true);
    expect(existsSync(path.join(report.outDir, "manifest.json"))).toBe(true);
  }, 15_000);

  it("returns typed cancellation, cleans candidates, preserves source, and permits retry", async () => {
    for (let index = 0; index < 200; index += 1) {
      put(`src/file-${index}.txt`, "x".repeat(1_024));
    }
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    const sourceHashes = new Map(
      readFileNames(dir).map((file) => [
        path.relative(dir, file),
        createHash("sha256").update(readFileSync(file)).digest("hex"),
      ]),
    );
    const controller = new AbortController();
    let launchAttempted = false;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const outcome = await prepareWorkspaceOutcome(dir, {
        provider: fakeProvider(),
        signal: controller.signal,
        onCheckpoint: (checkpoint) => {
          if (checkpoint === "workspace-created") controller.abort();
        },
      });
      if (outcome.kind === "success" && outcome.launchAllowed) launchAttempted = true;
      expect(outcome).toEqual({ kind: "cancelled", launchAllowed: false });
      expect(launchAttempted).toBe(false);

      const workspaceRoot = path.join(managedDir, "workspaces");
      const candidates = existsSync(workspaceRoot)
        ? readdirSync(workspaceRoot, { withFileTypes: true })
        : [];
      expect(candidates).toHaveLength(0);
      expect(
        existsSync(workspaceRoot)
          ? readFileNames(workspaceRoot).filter(
              (file) => file.endsWith("manifest.json") || file.endsWith("session.json"),
            )
          : [],
      ).toEqual([]);
      for (const [relpath, digest] of sourceHashes) {
        expect(createHash("sha256").update(readFileSync(path.join(dir, relpath))).digest("hex"))
          .toBe(digest);
      }

      const retry = await prepareWorkspaceOutcome(dir, { provider: fakeProvider() });
      expect(retry.kind).toBe("success");
      if (retry.kind === "success") {
        expect(retry.launchAllowed).toBe(true);
        expect(existsSync(path.join(retry.report.outDir, "manifest.json"))).toBe(true);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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
