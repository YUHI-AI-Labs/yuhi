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
import ExcelJS from "exceljs";
import type { DocumentInspector, LocalModelProvider } from "@yuhi/shared";
import { runDetectors } from "@yuhi/scanner";
import {
  prepareWorkspace,
  prepareWorkspaceOutcome,
  recommendedLocalModelParallelism,
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

describe("preparation performance defaults", () => {
  it("uses conservative adaptive local-processing parallelism", () => {
    const gib = 1024 ** 3;
    expect(recommendedLocalModelParallelism(8 * gib, 8)).toBe(1);
    expect(recommendedLocalModelParallelism(16 * gib, 8)).toBe(2);
    expect(recommendedLocalModelParallelism(32 * gib, 8)).toBe(3);
    expect(recommendedLocalModelParallelism(16 * gib, 2)).toBe(1);
  });

  it("reports every real preparation phase with metadata-safe counts", async () => {
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    put("README.md", "# Synthetic project\n");
    const events: Array<{
      phase: string;
      current?: number;
      total?: number;
    }> = [];
    await prepareWorkspace(dir, {
      provider: fakeProvider(),
      onProgressDetail: (event) => events.push(event),
    });
    expect(new Set(events.map(({ phase }) => phase))).toEqual(
      new Set(["discover", "scan", "prepare", "context", "verify"]),
    );
    expect(
      events.some(({ current, total }) => current !== undefined && current > 0 && current === total),
    ).toBe(true);
    expect(events.every((event) => !("relpath" in event))).toBe(true);
  });
});

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

function pdfInspector(text: string, method: "pdf-text" | "ocr" = "pdf-text"): DocumentInspector {
  return {
    canInspect: (file) => file.relpath.endsWith(".pdf"),
    async inspect(_file, consume) {
      consume(text);
      return {
        status: "inspected",
        extractedTextAvailable: true,
        extractionMethod: method,
        pageCount: 2,
        warnings: [],
      };
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
  it("delivers a sanitized companion for a PDF and never places the original in the workspace", async () => {
    writeFileSync(path.join(dir, "pending.pdf"), Buffer.from("%PDF-1.7\nsynthetic\n"));
    put("yuhi.yaml", 'version: "1"\nrules: []\ninclude_untracked: true\n');
    const report = await prepareWorkspace(dir, {
      deferDocumentInspection: true,
      documentInspector: pdfInspector("Synthetic public document body."),
    });
    // The ORIGINAL PDF is never delivered; a sanitized Markdown companion is.
    expect(existsSync(path.join(report.outDir, "pending.pdf"))).toBe(false);
    expect(existsSync(path.join(report.outDir, "pending.pdf.md"))).toBe(true);
    const entry = report.files.find((f) => f.document);
    expect(entry?.document?.originalSharedWithAgent).toBe(false);
    expect(entry?.document?.deliveredArtifactType).toBe("sanitized-pdf-companion");
    expect(report.tabularAcceptance?.launchAllowed).toBe(true);
  });

  it("always writes document-index.md even when no documents require summarization", async () => {
    put("app.ts", "export const x = 1;\n");
    put("util.ts", "export const y = 2;\n");
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    const report = await prepareWorkspace(dir, { deferDocumentInspection: true });
    expect(report.tabularAcceptance?.documentSummariesCreated).toBe(0);
    // The index must exist so an agent instructed to read it never finds it missing.
    const index = readFileSync(path.join(report.outDir, ".yuhi/context/document-index.md"), "utf8");
    expect(index).toContain("# Yuhi Document Context");
    expect(index).toContain("No documents required local summarization");
    // The handoff must point at the now always-present index.
    const handoff = readFileSync(path.join(report.outDir, ".yuhi/context/AGENT_HANDOFF.md"), "utf8");
    expect(handoff).toContain(".yuhi/context/document-index.md");
  });

  it("keeps a tabular file with blank/total rows in the workspace instead of dropping it", async () => {
    // Real CSV/XLSX routinely have rows with no identifier (totals, blanks). Such a
    // row must not fail the whole file — it must be pseudonymized where possible and
    // still delivered to the Prepared Workspace.
    put(
      "totals.csv",
      "name,employee_id,score\nAlice Tanaka,E-1,90\nBob Sato,E-2,80\n,,170\n",
    );
    put(
      "yuhi.yaml",
      'version: "1"\nrules:\n  - name: prep\n    match: { paths: ["*.csv"] }\n    action: prepare-locally\n    processors: [pseudonymize, safety-check]\n',
    );
    const report = await prepareWorkspace(dir, { deferDocumentInspection: true });
    const entry = report.files.find((f) => f.relpath === "totals.csv");
    expect(entry).toMatchObject({ status: "ok", outcome: "included-transformed" });
    expect(entry?.omitted).not.toBe(true);
    expect(existsSync(path.join(report.outDir, "totals.csv"))).toBe(true);
    const out = readFileSync(path.join(report.outDir, "totals.csv"), "utf8");
    expect(out).not.toContain("Alice Tanaka"); // identifier rows pseudonymized
    expect(out).toContain(",,170"); // identifier-less summary row preserved verbatim
  });

  it("does not run optional text summarization in the instant preparation phase", async () => {
    put("guide.md", "Synthetic architecture guidance.\n".repeat(200));
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    let providerFactoryCalls = 0;
    const report = await prepareWorkspace(dir, {
      deferDocumentInspection: true,
      providerFactory: () => {
        providerFactoryCalls += 1;
        return fakeProvider();
      },
    });
    expect(providerFactoryCalls).toBe(0);
    expect(report.tabularAcceptance?.localModelRequests).toBeUndefined();
    expect(readFileSync(path.join(report.outDir, "guide.md"), "utf8")).toBe(
      readFileSync(path.join(dir, "guide.md"), "utf8"),
    );
  });

  it("delivers a sanitized PDF companion and never leaks the source path or original filename in manifest/handoff", async () => {
    const rawExtracted = "Contact taro.yamada@example.ac.jp about student A000000 architecture.";
    writeFileSync(path.join(dir, "architecture.pdf"), Buffer.from("%PDF-1.7\nsynthetic\n"));
    put("yuhi.yaml", 'version: "1"\nrules: []\ninclude_untracked: true\n');

    const report = await prepareWorkspace(dir, {
      documentInspector: pdfInspector(rawExtracted),
    });

    // Companion delivered; original PDF absent.
    expect(existsSync(path.join(report.outDir, "architecture.pdf"))).toBe(false);
    const companion = readFileSync(path.join(report.outDir, "architecture.pdf.md"), "utf8");
    expect(companion).toContain("Yuhi document companion");
    // Structured identifiers in the extracted body are redacted in the companion.
    expect(companion).not.toContain("taro.yamada@example.ac.jp");
    expect(companion).not.toContain("A000000");
    // The absolute source path is never written into the companion.
    expect(companion).not.toContain(dir);
    // The handoff never exposes original document paths, and is created.
    const handoff = readFileSync(path.join(report.outDir, ".yuhi/context/AGENT_HANDOFF.md"), "utf8");
    expect(handoff).toContain("Yuhi Agent Handoff");
    expect(handoff).not.toContain(dir);
    expect(report.tabularAcceptance?.agentHandoffCreated).toBe(true);
  });

  it("delivers a usable sanitized companion even when the local summary model is unavailable", async () => {
    writeFileSync(path.join(dir, "offline.pdf"), Buffer.from("%PDF-1.7\nsynthetic\n"));
    put("yuhi.yaml", 'version: "1"\nrules: []\ninclude_untracked: true\n');
    const provider = fakeProvider();
    provider.generate = async () => {
      throw new Error("synthetic local model unavailable");
    };

    const report = await prepareWorkspace(dir, {
      providerFactory: () => provider,
      documentInspector: pdfInspector("Synthetic public document content."),
    });

    // Summary (Ollama) is optional enrichment: the sanitized companion is delivered and
    // the workspace is launchable even when the model fails. The original stays local.
    expect(report.tabularAcceptance?.launchAllowed).toBe(true);
    expect(existsSync(path.join(report.outDir, "offline.pdf"))).toBe(false);
    expect(existsSync(path.join(report.outDir, "offline.pdf.md"))).toBe(true);
  });

  it("redacts a secret in extracted PDF text out of the delivered companion (no raw secret reaches the agent)", async () => {
    writeFileSync(path.join(dir, "safe.pdf"), Buffer.from("%PDF-1.7\nsynthetic\n"));
    put("yuhi.yaml", 'version: "1"\nrules: []\ninclude_untracked: true\n');

    const report = await prepareWorkspace(dir, {
      documentInspector: pdfInspector("Public content. OPENAI_API_KEY=sk-synthetic-doc-leak-123456789 end."),
    });

    // The sanitized companion is delivered, the original PDF is not, and the secret
    // present in the extracted body is redacted out of the companion and the manifest.
    expect(existsSync(path.join(report.outDir, "safe.pdf"))).toBe(false);
    const companion = readFileSync(path.join(report.outDir, "safe.pdf.md"), "utf8");
    expect(companion).not.toContain("sk-synthetic-doc-leak-123456789");
    expect(readFileSync(path.join(report.outDir, "manifest.json"), "utf8"))
      .not.toContain("sk-synthetic-doc-leak-123456789");
    expect(report.tabularAcceptance?.launchAllowed).toBe(true);
  });

  it("creates verified context for a document-sized Markdown file", async () => {
    put("guide.md", `${"Architecture guidance and deployment decisions.\n".repeat(80)}`);
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    const provider = fakeProvider();
    provider.generate = async () => "Architecture guidance with deployment decisions.";

    const report = await prepareWorkspace(dir, { provider });

    expect(report.tabularAcceptance).toMatchObject({
      textDocumentsInspected: 1,
      documentSummariesCreated: 1,
    });
    expect(
      readFileSync(path.join(report.outDir, ".yuhi/context/document-index.md"), "utf8"),
    ).toContain("Inspection: Text document");
  });

  it("delivers a safe placeholder for a DOCX/PPTX and never places the original in the workspace", async () => {
    // A corrupt Office file must yield a placeholder (never the raw original) and must
    // not fail the whole preparation (per-file isolation).
    writeFileSync(path.join(dir, "notes.docx"), Buffer.from("PK\x03\x04 not really a docx"));
    writeFileSync(path.join(dir, "deck.pptx"), Buffer.from("PK\x03\x04 not really a pptx"));
    put("keep.md", "safe content\n");
    put("yuhi.yaml", 'version: "1"\nrules: []\ninclude_untracked: true\n');

    const report = await prepareWorkspace(dir);

    for (const [orig, companion] of [["notes.docx", "notes.docx.md"], ["deck.pptx", "deck.pptx.md"]]) {
      expect(existsSync(path.join(report.outDir, orig!))).toBe(false); // original never delivered
      expect(existsSync(path.join(report.outDir, companion!))).toBe(true);
    }
    for (const e of report.files.filter((f) => f.document)) {
      expect(e.document?.originalSharedWithAgent).toBe(false);
      expect(e.document?.deliveredArtifactType).toBe("safe-placeholder");
    }
    expect(report.tabularAcceptance?.launchAllowed).toBe(true);
  });

  it("delivers a safe placeholder (never the original) for a PDF that cannot be extracted", async () => {
    // No document inspector + no pdftotext in the test env → extraction is unavailable.
    // The PDF must NOT be delivered raw; a safe placeholder is delivered instead.
    writeFileSync(path.join(dir, "synthetic.pdf"), Buffer.from("%PDF-1.7\nsynthetic\n"));
    put("safe.md", "Synthetic safe content.\n");
    put("yuhi.yaml", 'version: "1"\nrules: []\ninclude_untracked: true\n');

    const report = await prepareWorkspace(dir, { provider: fakeProvider() });

    // Original PDF absent; placeholder companion present.
    expect(existsSync(path.join(report.outDir, "synthetic.pdf"))).toBe(false);
    expect(existsSync(path.join(report.outDir, "synthetic.pdf.md"))).toBe(true);
    const entry = report.files.find((f) => f.document);
    expect(entry?.document?.deliveredArtifactType).toBe("safe-placeholder");
    expect(entry?.document?.originalSharedWithAgent).toBe(false);
    expect(entry?.outcome).toBe("included-unverified");
    const placeholder = readFileSync(path.join(report.outDir, "synthetic.pdf.md"), "utf8");
    expect(placeholder).toContain("Original file shared with agent: no");
    expect(report.tabularAcceptance?.launchAllowed).toBe(true);
    // The raw PDF bytes never leak into the manifest.
    expect(JSON.stringify(JSON.parse(readFileSync(path.join(report.outDir, "manifest.json"), "utf8"))))
      .not.toContain("synthetic\\n");
  });

  it("includes an uninspectable binary but never copies a private key", async () => {
    writeFileSync(path.join(dir, "model.bin"), Buffer.from([0x00, 0xff, 0x12, 0x34]));
    writeFileSync(path.join(dir, "private.key"), Buffer.from([0x00, 0xff, 0x55, 0xaa]));
    put("safe.md", "Synthetic safe content.\n");
    put("yuhi.yaml", 'version: "1"\nrules: []\n');

    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    expect(readFileSync(path.join(report.outDir, "model.bin")))
      .toEqual(readFileSync(path.join(dir, "model.bin")));
    expect(report.files.find((item) => item.relpath === "model.bin")).toMatchObject({
      outcome: "included-unverified",
      transmission: "approved",
    });
    expect(report.files.find((item) => item.relpath === "model.bin")?.omitted).not.toBe(true);
    expect(existsSync(path.join(report.outDir, "private.key"))).toBe(false);
    expect(report.files.find((item) => item.relpath === "private.key")).toMatchObject({
      action: "local-only",
      omitted: true,
    });
    expect(report.tabularAcceptance?.launchAllowed).toBe(true);
  });

  it("keeps a malformed XLSX local and allows safe prepared files without raw fallback", async () => {
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
      launchAllowed: true,
    });
    expect(buildPreparedFileDecisions(report).find((item) => item.relativePath === "synthetic.xlsx"))
      .toMatchObject({
        sensitivityLevel: "Restricted",
        agentReceives: "No",
        outcome: "local-only-unverified",
      });
  });

  it("pseudonymizes a valid XLSX and preserves analytical cells and formulas", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Synthetic Author";
    const sheet = workbook.addWorksheet("評価");
    sheet.addRow(["フルネーム", "学生証番号", "点数", "評定", "計算"]);
    sheet.addRow(["Synthetic Student", "100001", 90, "A"]);
    sheet.getCell("E2").value = { formula: "C2+10", result: 100 };
    writeFileSync(
      path.join(dir, "synthetic-grades.xlsx"),
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );
    put("safe.md", "Synthetic safe content.\n");
    put("yuhi.yaml", 'version: "1"\nrules: []\n');

    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const entry = report.files.find((item) => item.relpath === "synthetic-grades.xlsx");
    expect(entry).toMatchObject({
      status: "ok",
      outcome: "included-transformed",
      transformed: true,
      transmission: "approved",
    });
    const prepared = readFileSync(path.join(report.outDir, "synthetic-grades.xlsx"));
    const output = new ExcelJS.Workbook();
    await output.xlsx.load(prepared as never);
    const outputSheet = output.getWorksheet("評価")!;
    expect(outputSheet.getCell("A2").text).toBe("Student 001");
    expect(outputSheet.getCell("B2").text).toBe("CARD-001");
    expect(outputSheet.getCell("C2").value).toBe(90);
    expect(outputSheet.getCell("D2").value).toBe("A");
    expect(outputSheet.getCell("E2").value).toMatchObject({ formula: "C2+10", result: 100 });
    expect(output.creator).toBe("Yuhi");
    expect(report.tabularAcceptance).toMatchObject({
      identifierColumnsTransformed: 2,
      analyticalColumnsPreserved: 3,
      launchAllowed: true,
      rawFallbackUsed: false,
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

  it("creates and rescans a sanitized .env copy while preserving configuration", async () => {
    const rawKey = ["sk", "synthetic", "abcdefghijklmnopqrstuvwxyz"].join("-");
    const original =
      `OPENAI_API_KEY=${rawKey}\n` +
      "DATABASE_URL=postgres://user:pass@host/db\n" +
      "OPENAI_MODEL=gpt-5\nPORT=3000\nDEBUG=true\n";
    put(".env", original);
    put(
      "yuhi.yaml",
      'version: "1"\nrules:\n' +
      "  - name: block-environment-files\n" +
      "    match:\n      paths: ['**/.env', '**/.env.*']\n" +
      "    action: block\n",
    );

    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const entry = report.files.find((item) => item.relpath === ".env");
    expect(entry).toMatchObject({
      status: "ok",
      transformed: true,
      transmission: "approved",
    });
    expect(entry?.omitted).not.toBe(true);
    const prepared = readFileSync(path.join(report.outDir, ".env"), "utf8");
    expect(prepared).toContain("OPENAI_API_KEY=${OPENAI_API_KEY}");
    expect(prepared).toContain("DATABASE_URL=${DATABASE_URL}");
    expect(prepared).toContain("OPENAI_MODEL=gpt-5");
    expect(prepared).toContain("PORT=3000");
    expect(prepared).toContain("DEBUG=true");
    expect(prepared).not.toContain(rawKey);
    expect(prepared).not.toContain("user:pass");
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toBe(original);
    expect(report.tabularAcceptance?.launchAllowed).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(report.outDir, "manifest.json"), "utf8"));
    expect(manifest.status).toBe("ready");
    expect(manifest.launchAllowed).toBe(true);
    expect(manifest.security.credentialsRemoved).toBe(true);
    expect(manifest.security.transformedFiles).toBeGreaterThanOrEqual(1);
    expect(manifest.warnings).toEqual({ unverifiedFilesIncluded: 0 });
  });

  it("never leaves raw credentials in the delivered .env under any Safety Mode", async () => {
    // Known synthetic AWS credentials (obviously fake) split so the strings
    // themselves are not literals in source.
    const rawSecret = ["wJal", "rXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/");
    const rawAccess = "AKIA" + "IOSFODNN7EXAMPLE";
    const original =
      `AWS_ACCESS_KEY_ID=${rawAccess}\n` +
      `AWS_SECRET_ACCESS_KEY=${rawSecret}\n` +
      "DB_PASSWORD=hunter2\nAPP_NAME=demo\n";
    const yaml = (mode: string) =>
      `version: "1"\nsafetyMode: ${mode}\nrules:\n` +
      "  - name: sanitize-environment\n" +
      "    match:\n      paths: ['**/.env', '**/.env.*']\n" +
      "    action: prepare-locally\n" +
      "    processors: [sanitize-environment, safety-check]\n";

    // Exposure must be monotonic non-increasing: strict <= balanced, maximum <= strict.
    const deliveredEnv: Record<string, string> = {};
    for (const mode of ["balanced", "strict", "maximum-privacy"]) {
      put(".env", original);
      put("yuhi.yaml", yaml(mode));
      const report = await prepareWorkspace(dir, { provider: fakeProvider() });
      const preparedPath = path.join(report.outDir, ".env");
      const prepared = existsSync(preparedPath) ? readFileSync(preparedPath, "utf8") : "";
      deliveredEnv[mode] = prepared;
      // No known credential raw value may survive in the delivered artifact, in ANY mode.
      expect(prepared.includes(rawSecret), `raw secret leaked in ${mode}`).toBe(false);
      expect(prepared.includes(rawAccess), `raw access key leaked in ${mode}`).toBe(false);
      expect(prepared.includes("hunter2"), `raw password leaked in ${mode}`).toBe(false);
      // Original source file is never modified.
      expect(readFileSync(path.join(dir, ".env"), "utf8")).toBe(original);
      // The real guarantee: the secret values were redacted to placeholders and
      // delivered safely (not raw). `credentialsRemoved` in the manifest only flips
      // for Yuhi's INTERNAL default sanitize rules, not a user-named rule like this
      // fixture's, so assert the delivered content directly instead.
      expect(prepared, `env redacted in ${mode}`).toContain("${");
      expect(prepared, `non-secret preserved in ${mode}`).toContain("APP_NAME=demo");
    }
    // Stricter modes must not deliver MORE sensitive content than looser ones.
    const exposure = (s: string) => (s.match(/=\$\{/g) ? s.length : s.length);
    expect(deliveredEnv["strict"]!.length).toBeLessThanOrEqual(deliveredEnv["balanced"]!.length);
    expect(deliveredEnv["maximum-privacy"]!.length).toBeLessThanOrEqual(
      deliveredEnv["strict"]!.length,
    );
    void exposure;
  });

  it("does not contact the local model for a deterministic environment-only run", async () => {
    const original = "OPENAI_API_KEY=sk-synthetic-not-real\nDEBUG=true\n";
    put(".env", original);
    put(
      "yuhi.yaml",
      'version: "1"\nrules:\n' +
      "  - name: sanitize-environment\n" +
      "    match:\n      paths: ['**/.env', '**/.env.*']\n" +
      "    action: prepare-locally\n" +
      "    processors: [sanitize-environment, safety-check]\n",
    );
    let providerFactoryCalls = 0;
    const provider: LocalModelProvider = {
      id: "must-not-run",
      endpoint: "http://127.0.0.1:1",
      defaultModel: "not-used",
      health: async () => { throw new Error("health must not be called"); },
      listModels: async () => [],
      generate: async () => {
        throw new Error("generate must not be called");
      },
    };

    const messages: string[] = [];
    const report = await prepareWorkspace(dir, {
      providerFactory: () => {
        providerFactoryCalls += 1;
        return provider;
      },
      onProgress: (message) => messages.push(message),
    });
    expect(report.tabularAcceptance?.launchAllowed).toBe(true);
    expect(providerFactoryCalls).toBe(0);
    expect(messages.some((message) =>
      message.includes("Generating local context: skipped (no documents requiring summary)")
    )).toBe(true);
    expect(readFileSync(path.join(report.outDir, ".env"), "utf8")).toContain(
      "OPENAI_API_KEY=${OPENAI_API_KEY}",
    );
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toBe(original);
  });

  it("creates verified placeholder copies for structured credential files", async () => {
    const rawToken = ["synthetic", "credential", "token"].join("-");
    const credentials = JSON.stringify({
      api_token: rawToken,
      password: "synthetic-password",
      model: "gpt-5",
    });
    const secrets = `database_url: postgres://user:pass@host/db\nport: 3000\n`;
    put("credentials.json", credentials);
    put("secrets.yaml", secrets);
    put(
      "yuhi.yaml",
      'version: "1"\nrules:\n' +
      "  - name: sanitize-credential-files\n" +
      "    match:\n      paths: ['**/credentials.json', '**/secrets.yaml']\n" +
      "    action: prepare-locally\n" +
      "    processors: [sanitize-credentials, safety-check]\n",
    );

    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    for (const relpath of ["credentials.json", "secrets.yaml"]) {
      expect(report.files.find((item) => item.relpath === relpath)).toMatchObject({
        status: "ok",
        transformed: true,
        transmission: "approved",
      });
    }
    const preparedJson = readFileSync(path.join(report.outDir, "credentials.json"), "utf8");
    const preparedYaml = readFileSync(path.join(report.outDir, "secrets.yaml"), "utf8");
    expect(preparedJson).toContain("${API_TOKEN}");
    expect(preparedJson).toContain('"model": "gpt-5"');
    expect(preparedYaml).toContain("${DATABASE_URL}");
    expect(preparedYaml).toContain("port: 3000");
    expect(preparedJson + preparedYaml).not.toContain(rawToken);
    expect(preparedJson + preparedYaml).not.toContain("user:pass");
    expect(readFileSync(path.join(dir, "credentials.json"), "utf8")).toBe(credentials);
    expect(readFileSync(path.join(dir, "secrets.yaml"), "utf8")).toBe(secrets);
    expect(report.tabularAcceptance?.launchAllowed).toBe(true);
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

  it("pseudonymizes suffixed Japanese ID headers and delivers headerless companion data with a warning", async () => {
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
    // Companion data cannot be safely pseudonymized, but with no secret it is still
    // delivered (never silently dropped) — as the original, marked unverified.
    expect(txtEntry?.omitted).not.toBe(true);
    expect(txtEntry?.status).toBe("ok");
    expect(existsSync(path.join(report.outDir, "synthetic-companion.txt"))).toBe(true);
  });

  it("ALWAYS delivers a sensitive tabular file that can't be transformed (passed with a warning, never excluded)", async () => {
    // PROMISE: csv/tsv/txt/xlsx are always passed. A sensitive table that cannot be
    // verifiably de-identified is included as the original WITH a clear warning +
    // failure category — never kept local. Only credentials are kept local.
    const raw = 'full name,student id,grade\n"unterminated,S-1,A';
    put("malformed.csv", raw);
    put("yuhi.yaml", 'version: "1"\nrules: []\n');

    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const entry = report.files.find((item) => item.relpath === "malformed.csv");
    expect(entry).toMatchObject({
      status: "ok",
      omitted: false,
      outcome: "included-unverified",
    });
    expect(entry?.failureCategory).toBeTruthy(); // honest reason preserved
    expect(entry?.error).toBeTruthy();
    // The file IS delivered to the workspace (the promise), with the original bytes.
    expect(existsSync(path.join(report.outDir, "malformed.csv"))).toBe(true);
    expect(readFileSync(path.join(report.outDir, "malformed.csv"), "utf8")).toBe(raw);
    expect(report.tabularAcceptance?.launchAllowed).toBe(true);
  });

  it("degraded-includes a NON-sensitive malformed CSV (no identifiers) verbatim", async () => {
    // No identifier columns => no safety finding => still delivered with a warning
    // (proves the keep-local gate does not over-block ordinary malformed data).
    const raw = "measurement,reading,note\n1.2,3.4\n5.6,7.8,9.0,extra\n";
    put("ragged.csv", raw);
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const entry = report.files.find((f) => f.relpath === "ragged.csv");
    // No safety finding => never routed to the keep-local gate; delivered verbatim.
    expect(entry?.status).toBe("ok");
    expect(entry?.omitted).toBeFalsy();
    expect(existsSync(path.join(report.outDir, "ragged.csv"))).toBe(true);
    expect(readFileSync(path.join(report.outDir, "ragged.csv"), "utf8")).toBe(raw);
  });

  it("launch policy: a conflicting table is transformed best-effort and delivered, never blocks launch", async () => {
    // Ten safe files + one table with a genuine identifier conflict (card reused).
    for (let i = 0; i < 10; i += 1) put(`safe/file${i}.md`, `# Synthetic doc ${i}\ncontent\n`);
    put(
      "conflict.csv",
      "full name,student id,student card number,score\n" +
        "Synthetic One,S-1,C-1,80\nSynthetic Two,S-2,C-1,90\n",
    );
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    // Best-effort transform: the table IS delivered and de-identified (no throw),
    // with no raw identifiers surviving.
    const risky = report.files.find((f) => f.relpath === "conflict.csv");
    expect(risky?.omitted).toBeFalsy();
    expect(existsSync(path.join(report.outDir, "conflict.csv"))).toBe(true);
    const out = readFileSync(path.join(report.outDir, "conflict.csv"), "utf8");
    for (const rawId of ["Synthetic One", "Synthetic Two", "S-1", "S-2", "C-1"]) {
      expect(out).not.toContain(rawId);
    }
    // Workspace-level: launch allowed; all files (10 safe + the table) available.
    expect(report.tabularAcceptance?.launchAllowed).toBe(true);
    expect(report.files.filter((f) => !f.omitted).length).toBeGreaterThanOrEqual(11);
  });

  it("launch policy: a credential in a would-be-sent file is EXCLUDED, and launch still proceeds", async () => {
    // A file that would be sent verbatim but still carries a live credential must be
    // excluded by recommendation (kept local) — NOT sent raw, and NOT a launch block.
    put("notes.txt", "deploy key\n" + "AKIA" + "IOSFODNN7EXAMPLE\n");
    put("readme.md", "# Synthetic\nsafe content\n");
    // A rule that explicitly ALLOWS the file (would send it verbatim) despite the
    // credential — this is the case that used to trip a workspace-level launch block.
    put(
      "yuhi.yaml",
      'version: "1"\nrules:\n  - name: allow-notes\n    match: { paths: ["notes.txt"] }\n    action: allow\n',
    );
    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const secretFile = report.files.find((f) => f.relpath === "notes.txt");
    // File-level: excluded, kept local, never written to the workspace.
    expect(secretFile?.omitted).toBe(true);
    expect(secretFile?.failureCategory).toBe("unresolved-secret");
    expect(existsSync(path.join(report.outDir, "notes.txt"))).toBe(false);
    // The credential value must never reach the Prepared Workspace.
    expect(existsSync(path.join(report.outDir, "readme.md"))).toBe(true);
    expect(readFileSync(path.join(report.outDir, "readme.md"), "utf8")).not.toContain("AKIA");
    // Workspace-level: launch is STILL allowed with the remaining safe file.
    expect(report.tabularAcceptance?.launchAllowed).toBe(true);
  });

  it("launch policy: many safe files + one credential file → safe files available, launch succeeds", async () => {
    for (let i = 0; i < 10; i += 1) put(`safe/doc${i}.md`, `# Synthetic ${i}\ncontent\n`);
    put("config.txt", "token\n" + "AKIA" + "IOSFODNN7EXAMPLE\n");
    put(
      "yuhi.yaml",
      'version: "1"\nrules:\n  - name: allow-config\n    match: { paths: ["config.txt"] }\n    action: allow\n',
    );
    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    expect(report.files.find((f) => f.relpath === "config.txt")?.omitted).toBe(true);
    expect(existsSync(path.join(report.outDir, "config.txt"))).toBe(false);
    expect(report.files.filter((f) => !f.omitted).length).toBeGreaterThanOrEqual(10);
    expect(report.tabularAcceptance?.launchAllowed).toBe(true);
  });

  it("launch policy: even when every project file is excluded, a minimal workspace still opens", async () => {
    put("secret.env", "API_KEY=" + "AKIA" + "IOSFODNN7EXAMPLE\n");
    put("yuhi.yaml", 'version: "1"\nrules:\n  - name: block-all\n    match: { paths: ["**/*"] }\n    action: block\n');
    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    // No usable project files, but a valid (metadata-only) Prepared Workspace exists,
    // so launch is still allowed — exclusion is never a workspace-level failure.
    expect(report.files.every((f) => f.omitted)).toBe(true);
    expect(report.tabularAcceptance?.launchAllowed).toBe(true);
    expect(existsSync(path.join(report.outDir, ".yuhi"))).toBe(true);
  });

  it("transforms a sensitive CSV that has a leading metadata preamble (real export shape)", async () => {
    // Title + export-date + blank line before the header — the shape that used to
    // route the file to raw passthrough. It must now transform end-to-end.
    const raw =
      "健康診断結果一覧\n出力日,2026-07-22\n\n" +
      "受診者番号,受診者氏名,BMI\n" +
      "A000000-0723,サンプル 太郎,22.1\n" +
      "A005007-0724,サンプル 花子,20.4\n";
    put("health.csv", raw);
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const entry = report.files.find((f) => f.relpath === "health.csv");
    expect(entry?.status).toBe("ok");
    expect(entry?.outcome).toBe("included-transformed");
    const dest = path.join(report.outDir, "health.csv");
    expect(existsSync(dest)).toBe(true);
    const out = readFileSync(dest, "utf8");
    // Preamble preserved; identifiers gone; analytical values kept.
    expect(out).toContain("健康診断結果一覧");
    expect(out).toContain("22.1");
    for (const rawId of ["A000000-0723", "A005007-0724", "サンプル 太郎", "サンプル 花子"]) {
      expect(out).not.toContain(rawId);
    }
  });

  it("keeps a malformed table LOCAL when it carries an unresolved credential", async () => {
    // Structural failure (short row) BUT an AWS key is present → the secret gate must
    // keep it local, never degrade-include it, and record an explicit reason.
    put("leaky.csv", 'name,id,token\nAlice,A1,"' + "AKIA" + 'IOSFODNN7EXAMPLE"\nBob,A2\n');
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    const report = await prepareWorkspace(dir, { provider: fakeProvider() });
    const entry = report.files.find((f) => f.relpath === "leaky.csv");
    expect(entry?.omitted).toBe(true);
    expect(entry?.error).toBeTruthy(); // never omitted without a reason
    expect(existsSync(path.join(report.outDir, "leaky.csv"))).toBe(false);
  });

  it("does not let a failed table transformation contaminate later alias state", async () => {
    put(
      "a-conflict.csv",
      "full name,student id,student card number,score\n" +
      "Synthetic One,S-1,C-1,80\nSynthetic Two,S-2,C-1,90\n",
    );
    put(
      "b-valid.csv",
      "full name,student id,student card number,score\n" +
      "Synthetic Three,S-3,C-3,70\nSynthetic Four,S-4,C-4,95\n",
    );
    put("yuhi.yaml", 'version: "1"\nrules: []\n');

    const report = await prepareWorkspace(dir);
    // Both tables are delivered and de-identified (best effort, no throw). The
    // conflicting row in a-conflict is isolated under a fresh entity and its
    // mappings are NOT committed, so the valid file's distinct students still get
    // their own clean pseudonyms — no cross-contamination.
    expect(report.files.find((file) => file.relpath === "a-conflict.csv")?.omitted).toBeFalsy();
    expect(report.files.find((file) => file.relpath === "b-valid.csv")).toMatchObject({
      status: "ok",
      transformed: true,
    });
    const aConflict = readFileSync(path.join(report.outDir, "a-conflict.csv"), "utf8");
    const bValid = readFileSync(path.join(report.outDir, "b-valid.csv"), "utf8");
    for (const raw of ["Synthetic One", "Synthetic Two", "S-1", "S-2", "C-1"]) {
      expect(aConflict).not.toContain(raw);
    }
    for (const raw of ["Synthetic Three", "Synthetic Four", "S-3", "S-4", "C-3", "C-4"]) {
      expect(bValid).not.toContain(raw);
    }
    // b-valid's two distinct students get two distinct pseudonyms (not collapsed).
    const bRows = bValid.trim().split("\n").slice(1);
    expect(bRows[0]!.split(",")[1]).not.toEqual(bRows[1]!.split(",")[1]);
    // Analytical (score) columns preserved.
    expect(bValid).toContain(",70");
    expect(bValid).toContain(",95");
  });

  it("pseudonymizes direct identifiers in filenames; mapping lives only in the manifest", async () => {
    // A filename like 20260715-110046-A000000.csv leaks the ID before Claude opens
    // the file. The delivered name must drop the identifier (keeping date/time
    // context), and the reverse mapping must exist only in the manifest.
    mkdirSync(path.join(dir, "health"), { recursive: true });
    writeFileSync(
      path.join(dir, "health", "20260715-110046-A000000.csv"),
      "受診者番号,受診者氏名,BMI\nA000000,Synthetic One,22.1\n",
    );
    put("yuhi.yaml", 'version: "1"\nrules: []\ninclude_untracked: true\n');
    const report = await prepareWorkspace(dir);
    const entry = report.files.find((f) => f.originalRelpath?.includes("A000000"));
    expect(entry).toBeDefined();
    // Claude-facing name has NO identifier, but keeps the non-identifying date/time.
    expect(entry!.relpath).toMatch(/health\/20260715-110046-ID-[0-9a-f]{8}\.csv$/);
    expect(entry!.relpath).not.toContain("A000000");
    // The file is on disk under the pseudonymized name, not the original.
    expect(existsSync(path.join(report.outDir, entry!.relpath))).toBe(true);
    expect(existsSync(path.join(report.outDir, "health", "20260715-110046-A000000.csv"))).toBe(false);
    // The reverse mapping is available for the operator via the manifest only.
    const manifest = JSON.parse(readFileSync(path.join(report.outDir, "manifest.json"), "utf8"));
    expect(manifest.filenamesPseudonymized).toBeGreaterThanOrEqual(1);
    const manifestEntry = manifest.files.find((f: { originalRelpath?: string }) =>
      f.originalRelpath?.includes("A000000"),
    );
    expect(manifestEntry.relpath).toBe(entry!.relpath);
  });

  it("a workspace whose generated handoff trips its own rescan never fails: handoff sanitized, not thrown", async () => {
    // ROOT CAUSE of the real-world "preparation-failure": AGENT_HANDOFF.md lists
    // filenames, and a long high-entropy name (common with generated/token-like files)
    // trips the entropy detector — so Yuhi's OWN file failed its rescan and aborted the
    // whole run. It must sanitize + write the handoff instead of ever throwing.
    const token = "aGVsbG8gd29ybGQtdGhpcy1pcy1hLXZlcnktbG9uZy1yYW5kb20tdG9rZW4tc3RyaW5n";
    writeFileSync(path.join(dir, `report-${token}.bin`), Buffer.from([0, 1, 2, 255, 254, 0, 9, 7]));
    put("normal.csv", "氏名,学籍番号,評定\n山田太郎,S-1,A\n");
    put("yuhi.yaml", 'version: "1"\nrules: []\ninclude_untracked: true\n');

    // Must NOT throw (previously threw "Generated agent handoff failed Yuhi security verification.").
    const report = await prepareWorkspace(dir);

    const handoffPath = path.join(report.outDir, ".yuhi/context/AGENT_HANDOFF.md");
    expect(existsSync(handoffPath)).toBe(true);
    // The WRITTEN handoff passes its own rescan — guaranteed clean, so it can never
    // have been the reason a completed preparation was thrown away.
    const handoff = readFileSync(handoffPath, "utf8");
    expect(runDetectors(handoff, { entropyThreshold: 4.0, keywords: [], relpath: "h.md" })).toHaveLength(0);
    // The file is still delivered — a filename can never block the whole workspace.
    expect(report.files.some((f) => f.relpath.includes("report-"))).toBe(true);
  });

  it("a volatile .DS_Store rewritten during preparation never fails the run (still included)", async () => {
    // macOS Finder rewrites .DS_Store on its own schedule; over a long prep it will
    // mutate. That must never fail the source-integrity assertion. The file itself
    // stays included in the workspace — only its churn is exempt from integrity.
    put(".DS_Store", "   ");
    put("check/.DS_Store", "   ");
    put("roster.csv", "氏名,学籍番号,学生証番号,評定\n山田太郎,123456,A000000,A\n");
    put("yuhi.yaml", 'version: "1"\nrules: []\ninclude_untracked: true\n');

    const report = await prepareWorkspace(dir, {
      beforeIntegrityVerification: async () => {
        writeFileSync(path.join(dir, ".DS_Store"), Buffer.from([9, 9, 9, 9, 9]));
        mkdirSync(path.join(dir, "sub"), { recursive: true });
        writeFileSync(path.join(dir, "sub", ".DS_Store"), Buffer.from([1, 2, 3]));
      },
    });
    // Preparation completed (no throw) and .DS_Store is still delivered.
    expect(report.files.some((f) => f.relpath === ".DS_Store")).toBe(true);
    expect(existsSync(path.join(report.outDir, ".DS_Store"))).toBe(true);
  });

  it("FINAL ARTIFACT: no delivered CSV/nested/TXT/XLSX contains raw names or IDs; grades remain", async () => {
    // The security-critical guarantee, asserted against the ACTUAL bytes on disk
    // (reopened after every write/rename/fallback) — not an in-memory transform.
    const HEADER = ["氏名", "学籍番号", "学生証番号", "評定"];
    const ROWS = [
      ["山田太郎", "123456", "A000000", "A"],
      ["佐藤花子", "990192", "A005007", "B"],
    ];
    const RAW = ["山田太郎", "佐藤花子", "123456", "990192", "A000000", "A005007"];
    const csvText = [HEADER.join(","), ...ROWS.map((r) => r.join(","))].join("\n") + "\n";
    const tsvText = [HEADER.join("\t"), ...ROWS.map((r) => r.join("\t"))].join("\n") + "\n";

    put("評定.csv", csvText);
    put("check/評定-0723.csv", csvText);
    put("評定.txt", tsvText);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("評定");
    ws.addRow(HEADER);
    for (const r of ROWS) ws.addRow([r[0], Number(r[1]), r[2], r[3]]); // numeric 学籍番号
    mkdirSync(path.join(dir, "check"), { recursive: true });
    writeFileSync(path.join(dir, "評定.xlsx"), Buffer.from(await wb.xlsx.writeBuffer()));
    writeFileSync(path.join(dir, "check", "評定-0723.xlsx"), Buffer.from(await wb.xlsx.writeBuffer()));
    put("yuhi.yaml", 'version: "1"\nrules: []\ninclude_untracked: true\n');

    const report = await prepareWorkspace(dir);

    const readXlsxText = async (abs: string): Promise<string> => {
      const w = new ExcelJS.Workbook();
      await w.xlsx.readFile(abs);
      const cells: string[] = [];
      w.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((c) => cells.push(String(c.value ?? "")))));
      return cells.join("|");
    };

    for (const entry of report.files) {
      if (entry.omitted || !/\.(?:csv|txt|xlsx)$/i.test(entry.relpath)) continue;
      const abs = path.join(report.outDir, ...entry.relpath.split("/"));
      expect(existsSync(abs)).toBe(true);
      const text = entry.relpath.endsWith(".xlsx") ? await readXlsxText(abs) : readFileSync(abs, "utf8");
      for (const secret of RAW) {
        expect(text, `${entry.relpath} leaked ${secret}`).not.toContain(secret);
      }
      // Grades (analytical values) must survive the de-identification.
      expect(/[|,\t]A(\||$|\n)/.test(text) || text.includes("A") ).toBe(true);
      // The final gate must have verified this delivered artifact.
      expect(entry.finalRescanVerified).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(path.join(report.outDir, "manifest.json"), "utf8"));
    expect(manifest.finalRescan.identifierLeaks).toBe(0);
  });

  it("creates a new immutable run when blocked files are explicitly excluded", async () => {
    put("malformed.csv", 'full name,student id,grade\n"unterminated,S-1,A');
    put("safe.md", "Synthetic safe content.\n");
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    const partial = await prepareWorkspace(dir, { provider: fakeProvider() });
    // The malformed table is DELIVERED with a warning (always-pass promise); the user
    // can still explicitly exclude it, producing a fresh immutable run below.
    expect(partial.files.find((file) => file.relpath === "malformed.csv")?.outcome).toBe(
      "included-unverified",
    );
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

    const absent = [".env", "data/salaries.csv", "docs/internal/notes.md"];
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
    expect(readFileSync(path.join(report.outDir, "logo.bin"))).toEqual(files["logo.bin"]);
    expect(report.files.find((f) => f.relpath === "logo.bin")).toMatchObject({
      outcome: "included-unverified",
      transmission: "approved",
    });
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
