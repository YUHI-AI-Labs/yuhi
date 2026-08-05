/**
 * v0.3.5 integration tests for the real-processor wiring (`runBackgroundForRun`) and
 * the private/public boundary + doc→OCR fallback + cancel + retry control plane.
 *
 * Extraction/publish uses REAL fixtures and the REAL safety-gated publisher; PROVIDERS
 * (local model + PDF/OCR extractors) are FAKED/injected — no real network/model/binary.
 */
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
  statSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createStudentAliasContext,
  pseudonymizeStudentRecords,
  type LocalModelProvider,
} from "@yuhi/shared";
import type { PdfTextExtractor } from "../document-artifact.js";
import { documentIdFor, withheldDisplayName } from "../metadata-boundary.js";
import {
  BackgroundQueue,
  CancelStore,
  runBackgroundForRun,
  requestBackgroundCancel,
  retryBackgroundItem,
  retryBackgroundTerminal,
  privateAliasRegistryPath,
  privateBackgroundDir,
  privateStagingDir,
  publicStatusPath,
  readPublicStatus,
  writePrivateAliasRegistry,
  type EnqueueInput,
} from "./index.js";

const AWS_SECRET = "AKIAIOSFODNN7EXAMPLE";
const RUN = "run-1";

// managedBase = parentDir; preparedDir = <parentDir>/prepared-run; private state lives
// under <parentDir>/.internal/background/<RUN> (OUTSIDE the agent-visible prepared root).
let parentDir: string;
let sourceDir: string;
let preparedDir: string;

beforeEach(() => {
  parentDir = mkdtempSync(path.join(tmpdir(), "yuhi-bg-wiring-"));
  sourceDir = path.join(parentDir, "src");
  preparedDir = path.join(parentDir, "prepared-run");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(preparedDir, { recursive: true });
});

afterEach(() => {
  rmSync(parentDir, { recursive: true, force: true });
});

function privateDir(): string {
  return privateBackgroundDir(parentDir, RUN);
}

function putSource(rel: string, content: string): string {
  const abs = path.join(sourceDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function allBytesUnder(dir: string): Buffer[] {
  if (!existsSync(dir)) return [];
  const out: Buffer[] = [];
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = path.join(dir, rel);
    try {
      if (statSync(abs).isFile()) out.push(readFileSync(abs));
    } catch {
      /* transient */
    }
  }
  return out;
}

function relFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter((rel) => {
    try {
      return statSync(path.join(dir, rel)).isFile();
    } catch {
      return false;
    }
  });
}

async function enqueue(
  input: Partial<EnqueueInput> & Pick<EnqueueInput, "relpath" | "kind" | "sourceArtifactPath">,
): Promise<string> {
  const queue = await BackgroundQueue.open(privateDir());
  const outcome = await queue.enqueue({
    runId: RUN,
    contextId: "ctx-1",
    sourceContentHash: "hash-" + input.relpath,
    processorVersion: "test@1",
    policyHash: "policy-1",
    ...input,
  });
  return outcome.record.item.itemId;
}

/**
 * Where a companion for a WITHHELD original must be published: under the document's
 * public identity, never a path derived from the source filename (P0-C metadata
 * boundary — a filename like `9999990001 評定.pdf` is itself identifying data).
 */
function withheldCompanion(relpath: string): string {
  return path.join(
    ".yuhi",
    "context",
    "companions",
    `${withheldDisplayName(relpath, documentIdFor(relpath, "ctx-1"))}.md`,
  );
}

function fakeProvider(output: string, calls?: { n: number }): LocalModelProvider {
  return {
    id: "fake",
    endpoint: "http://localhost:0",
    defaultModel: "fake",
    async health() {
      return { reachable: true, models: ["fake"] };
    },
    async listModels() {
      return ["fake"];
    },
    async generate() {
      if (calls) calls.n += 1;
      return output;
    },
  } as unknown as LocalModelProvider;
}

function goodPdf(text: string): PdfTextExtractor {
  return async () => ({ text, method: "pdf-text", pageCount: 1 });
}
const emptyPdf: PdfTextExtractor = async () => ({ text: "", method: "none" });

describe("runBackgroundForRun — extraction, publish, and safety gate", () => {
  it("publishes a sanitized companion for a clean document; original PDF never shared", async () => {
    const original = putSource("report.pdf", "%PDF-1.4 binary bytes not parsed by fake");
    await enqueue({ relpath: "report.pdf", kind: "document-extraction", sourceArtifactPath: original });

    const summary = await runBackgroundForRun({
      runId: RUN,
      preparedDir,
      pdfTextExtractor: goodPdf("Quarterly report. Revenue increased. All figures nominal."),
    });

    expect(summary.completed).toBe(1);
    expect(summary.revision).toBe(1);
    // The original was never delivered, so the companion carries the document's public
    // identity — publishing `report.pdf.md` would republish the withheld filename.
    const companion = path.join(preparedDir, withheldCompanion("report.pdf"));
    expect(existsSync(companion)).toBe(true);
    expect(readFileSync(companion, "utf8")).toContain("Revenue increased");
    expect(existsSync(path.join(preparedDir, "report.pdf"))).toBe(false);
    expect(existsSync(path.join(preparedDir, "report.pdf.md"))).toBe(false);
    expect(relFilesUnder(preparedDir).some((rel) => rel.includes("report"))).toBe(false);
    expect(existsSync(privateStagingDir(parentDir, RUN))).toBe(false);
  });

  it("masks a PII-bearing document (issue #21) and publishes the sanitized companion", async () => {
    // Before the 0.4.7 fix this published RAW, labelled "Verified" (issue #21): the
    // pseudonymizer only understood delimited tables, threw on prose, and the catch
    // silently returned an empty forbidden list. It must now be masked AND published —
    // not just kept local, which would make the feature useless on ordinary documents.
    const original = putSource("hr.pdf", "%PDF binary");
    await enqueue({ relpath: "hr.pdf", kind: "document-extraction", sourceArtifactPath: original });

    const summary = await runBackgroundForRun({
      runId: RUN,
      preparedDir,
      pdfTextExtractor: goodPdf("Employee record. 氏名：山田太郎 Contact: taro.yamada@example.com"),
    });

    expect(summary.completed).toBe(1);
    expect(summary.keptLocal).toBe(0);
    const companion = path.join(preparedDir, withheldCompanion("hr.pdf"));
    expect(existsSync(companion)).toBe(true);
    const published = readFileSync(companion, "utf8");
    // The label itself ("氏名：") is an operational column header, correctly preserved —
    // only the VALUE next to it is masked.
    expect(published).toContain("氏名");
    expect(published).toMatch(/PERSON-\d{3}/);
    expect(published).toMatch(/EMAIL-\d{3}/);
    for (const buf of allBytesUnder(preparedDir)) {
      const text = buf.toString("utf8");
      expect(text).not.toContain("山田太郎");
      expect(text).not.toContain("taro.yamada@example.com");
    }
  });

  it("reuses the SAME token a same-run CSV already minted, when the document also carries the linking key", async () => {
    // The core 0.4.7 identity linkage policy: `student-id` (or another strong key)
    // present in BOTH the table and the document is what authorizes reusing the
    // table's token — never a bare name match alone. Registry setup mirrors what
    // `prepareWorkspace()` does synchronously (call the same real tabular transform,
    // then persist), without paying for the whole prepare pipeline in this test.
    const registryContext = createStudentAliasContext();
    pseudonymizeStudentRecords(
      "学籍番号,氏名\nSID_CANARY_001,山田太郎\n",
      registryContext,
    );
    await writePrivateAliasRegistry(parentDir, RUN, registryContext);

    const original = putSource("cert.pdf", "%PDF binary");
    await enqueue({ relpath: "cert.pdf", kind: "document-extraction", sourceArtifactPath: original });

    const summary = await runBackgroundForRun({
      runId: RUN,
      preparedDir,
      pdfTextExtractor: goodPdf(
        "Certificate of enrollment. 学籍番号：SID_CANARY_001 氏名：山田太郎",
      ),
    });

    expect(summary.completed).toBe(1);
    const companion = path.join(preparedDir, withheldCompanion("cert.pdf"));
    const published = readFileSync(companion, "utf8");
    // Same run, same table -> same entity -> the SAME PERSON-001 the CSV minted, not
    // an independently-numbered token.
    expect(published).toContain("PERSON-001");
    expect(published).toContain("SID_CANARY_001"); // operational key: preserved, not masked
    expect(published).not.toContain("山田太郎");
  });

  it("does NOT reuse the table's token for a same-named person with no key in the document", async () => {
    // Two different people can share a name. A bare name match must mint a NEW entity,
    // never silently merge onto the table's PERSON-001 — merging would be data
    // corruption (docs/design/0.4.7_document_privacy.md).
    const registryContext = createStudentAliasContext();
    pseudonymizeStudentRecords(
      "学籍番号,氏名\nSID_CANARY_001,山田太郎\n",
      registryContext,
    );
    await writePrivateAliasRegistry(parentDir, RUN, registryContext);

    const original = putSource("visitor.pdf", "%PDF binary");
    await enqueue({ relpath: "visitor.pdf", kind: "document-extraction", sourceArtifactPath: original });

    const summary = await runBackgroundForRun({
      runId: RUN,
      preparedDir,
      // Same name, but NO student id anywhere in this document.
      pdfTextExtractor: goodPdf("Visitor sign-in sheet. 氏名：山田太郎"),
    });

    expect(summary.completed).toBe(1);
    const companion = path.join(preparedDir, withheldCompanion("visitor.pdf"));
    const published = readFileSync(companion, "utf8");
    expect(published).not.toContain("山田太郎");
    // Masked, but NOT with the table's PERSON-001 — this document has nothing linking
    // it to that entity.
    expect(published).not.toContain("PERSON-001");
    expect(published).toMatch(/PERSON-\d{3}/);
  });

  it("masks a name with NO linking key present, without merging it onto an unrelated entity", async () => {
    const original = putSource("memo.pdf", "%PDF binary");
    await enqueue({ relpath: "memo.pdf", kind: "document-extraction", sourceArtifactPath: original });

    const summary = await runBackgroundForRun({
      runId: RUN,
      preparedDir,
      // No student id, no key of any kind — just a bare name.
      pdfTextExtractor: goodPdf("Visitor log. 氏名：鈴木花子"),
    });

    expect(summary.completed).toBe(1);
    const companion = path.join(preparedDir, withheldCompanion("memo.pdf"));
    const published = readFileSync(companion, "utf8");
    expect(published).not.toContain("鈴木花子");
    // Masked (never raw) but with SOME token — this run minted no other entities, so
    // asserting a token exists at all is the safety property; a future run's specific
    // numbering is an implementation detail, not part of the contract.
    expect(published).toMatch(/PERSON-\d{3}/);
  });

  it("still masks and publishes safely when the private alias registry is unavailable", async () => {
    // No prepareWorkspace() ran for this RUN, so readPrivateAliasRegistry has nothing
    // to read. Confirms the documented safety property: masking and independent
    // verification do not depend on the registry — only cross-format token reuse does.
    const original = putSource("solo.pdf", "%PDF binary");
    await enqueue({ relpath: "solo.pdf", kind: "document-extraction", sourceArtifactPath: original });

    const summary = await runBackgroundForRun({
      runId: RUN,
      preparedDir,
      pdfTextExtractor: goodPdf("Standalone note. 氏名：高橋一郎 Contact: ichiro@example.com"),
    });

    expect(summary.completed).toBe(1);
    const companion = path.join(preparedDir, withheldCompanion("solo.pdf"));
    const published = readFileSync(companion, "utf8");
    expect(published).not.toContain("高橋一郎");
    expect(published).not.toContain("ichiro@example.com");
    expect(published).toMatch(/PERSON-\d{3}/);
    expect(published).toMatch(/EMAIL-\d{3}/);
  });

  it("still masks and publishes safely when the private alias registry is CORRUPT (not just absent)", async () => {
    mkdirSync(privateBackgroundDir(parentDir, RUN), { recursive: true });
    writeFileSync(privateAliasRegistryPath(parentDir, RUN), "{ not valid json", "utf8");

    const original = putSource("corrupt-registry.pdf", "%PDF binary");
    await enqueue({
      relpath: "corrupt-registry.pdf",
      kind: "document-extraction",
      sourceArtifactPath: original,
    });

    const summary = await runBackgroundForRun({
      runId: RUN,
      preparedDir,
      pdfTextExtractor: goodPdf("Note. 氏名：渡辺三郎 Contact: saburo@example.com"),
    });

    expect(summary.completed).toBe(1);
    const companion = path.join(preparedDir, withheldCompanion("corrupt-registry.pdf"));
    const published = readFileSync(companion, "utf8");
    expect(published).not.toContain("渡辺三郎");
    expect(published).not.toContain("saburo@example.com");
    expect(published).toMatch(/PERSON-\d{3}/);
    expect(published).toMatch(/EMAIL-\d{3}/);
  });

  it("keeps a secret-carrying summary local; the secret is never written anywhere", async () => {
    const original = putSource("notes.txt", "internal ops notes\n");
    await enqueue({ relpath: "notes.txt", kind: "summarize-local", sourceArtifactPath: original });
    const provider = fakeProvider(`Summary of notes. Access key ${AWS_SECRET} referenced.`);

    const summary = await runBackgroundForRun({ runId: RUN, preparedDir, providerFactory: () => provider });

    expect(summary.completed).toBe(0);
    expect(summary.keptLocal).toBe(1);
    for (const buf of [
      ...allBytesUnder(preparedDir),
      ...allBytesUnder(privateStagingDir(parentDir, RUN)),
    ]) {
      expect(buf.toString("utf8")).not.toContain(AWS_SECRET);
    }
  });

  it("publishes a clean local summary companion at the file's own path", async () => {
    const original = putSource("memo.md", "Meeting agenda and action items.\n");
    // The original WAS delivered to the agent (`publicRelpath`), so the summary
    // replaces it in place rather than appearing under a synthetic identity.
    await enqueue({
      relpath: "memo.md",
      publicRelpath: "memo.md",
      kind: "summarize-local",
      sourceArtifactPath: original,
    });
    const calls = { n: 0 };
    const summary = await runBackgroundForRun({
      runId: RUN,
      preparedDir,
      providerFactory: () => fakeProvider("Agenda covers planning; action items assigned.", calls),
    });
    expect(calls.n).toBe(1);
    expect(summary.completed).toBe(1);
    expect(readFileSync(path.join(preparedDir, "memo.md"), "utf8")).toContain("action items");
  });

  it("keeps local when the local model is unavailable (no providerFactory)", async () => {
    const original = putSource("draft.txt", "some content to summarize\n");
    await enqueue({ relpath: "draft.txt", kind: "summarize-local", sourceArtifactPath: original });
    const summary = await runBackgroundForRun({ runId: RUN, preparedDir });
    expect(summary.completed).toBe(0);
    expect(summary.keptLocal).toBe(1);
    expect(existsSync(path.join(preparedDir, "draft.txt"))).toBe(false);
  });

  it("never mutates the source workspace and leaves no staging behind", async () => {
    const original = putSource("report.pdf", "%PDF original bytes");
    const sourceBefore = allBytesUnder(sourceDir).map((b) => b.toString("utf8"));
    const sourceRelBefore = relFilesUnder(sourceDir).sort();
    await enqueue({ relpath: "report.pdf", kind: "document-extraction", sourceArtifactPath: original });
    await runBackgroundForRun({ runId: RUN, preparedDir, pdfTextExtractor: goodPdf("Benign extracted content.") });
    expect(relFilesUnder(sourceDir).sort()).toEqual(sourceRelBefore);
    expect(allBytesUnder(sourceDir).map((b) => b.toString("utf8"))).toEqual(sourceBefore);
    expect(existsSync(privateStagingDir(parentDir, RUN))).toBe(false);
  });
});

describe("document → OCR fallback (dependent, not parallel)", () => {
  it("a successful document extraction does NOT start OCR", async () => {
    const original = putSource("clean.pdf", "%PDF");
    await enqueue({ relpath: "clean.pdf", kind: "document-extraction", sourceArtifactPath: original });

    const summary = await runBackgroundForRun({
      runId: RUN,
      preparedDir,
      pdfTextExtractor: goodPdf("Readable text extracted directly."),
      ocrExtractor: goodPdf("OCR SHOULD NOT RUN"),
    });

    expect(summary.completed).toBe(1);
    const queue = await BackgroundQueue.open(privateDir());
    expect(queue.list(RUN).some((i) => i.kind === "ocr")).toBe(false);
    expect(
      readFileSync(path.join(preparedDir, withheldCompanion("clean.pdf")), "utf8"),
    ).not.toContain("OCR SHOULD NOT RUN");
  });

  it("an insufficient-text extraction enqueues a dependent OCR item that publishes once", async () => {
    const original = putSource("scanned.pdf", "%PDF image-only");
    await enqueue({ relpath: "scanned.pdf", kind: "document-extraction", sourceArtifactPath: original });

    const summary = await runBackgroundForRun({
      runId: RUN,
      preparedDir,
      pdfTextExtractor: emptyPdf, // extraction recovers nothing → OCR fallback
      ocrExtractor: goodPdf("Recovered via OCR. Quarterly numbers within plan."),
    });

    const queue = await BackgroundQueue.open(privateDir());
    const items = queue.list(RUN);
    const extraction = items.find((i) => i.kind === "document-extraction");
    const ocr = items.find((i) => i.kind === "ocr");
    expect(extraction?.status).toBe("kept-local");
    expect(extraction?.reasonCode).toBe("background-ocr-deferred");
    expect(ocr?.status).toBe("completed");
    // Exactly one final safe artifact → revision increments exactly once, one companion.
    expect(summary.revision).toBe(1);
    expect(summary.completed).toBe(1);
    const companions = relFilesUnder(preparedDir).filter((r) => r.endsWith(".md") && r.includes("companions"));
    expect(companions).toHaveLength(1);
    expect(
      readFileSync(path.join(preparedDir, withheldCompanion("scanned.pdf")), "utf8"),
    ).toContain("Recovered via OCR");
    // The withheld original's filename never reaches the delivered tree.
    expect(relFilesUnder(preparedDir).some((rel) => rel.includes("scanned"))).toBe(false);
  });

  it("keeps local with an OCR-unavailable reason when no OCR extractor is configured", async () => {
    const original = putSource("scan.pdf", "%PDF image-only");
    await enqueue({ relpath: "scan.pdf", kind: "document-extraction", sourceArtifactPath: original });

    const summary = await runBackgroundForRun({ runId: RUN, preparedDir, pdfTextExtractor: emptyPdf });

    expect(summary.completed).toBe(0);
    expect(summary.keptLocal).toBe(2); // extraction deferred + ocr unavailable
    const ocr = (await BackgroundQueue.open(privateDir())).list(RUN).find((i) => i.kind === "ocr");
    expect(ocr?.reasonCode).toBe("background-ocr-unavailable");
    expect(existsSync(path.join(preparedDir, "scan.pdf.md"))).toBe(false);
  });
});

describe("private/public state boundary", () => {
  it("keeps private queue state OUT of the agent-visible prepared root", async () => {
    const original = putSource("report.pdf", "%PDF");
    await enqueue({ relpath: "report.pdf", kind: "document-extraction", sourceArtifactPath: original });
    await runBackgroundForRun({ runId: RUN, preparedDir, pdfTextExtractor: goodPdf("Clean text.") });

    // No queue records / private files anywhere under the prepared (agent-visible) root.
    for (const rel of relFilesUnder(preparedDir)) {
      expect(rel).not.toContain("queue.json");
      expect(rel).not.toContain("private-results");
      expect(rel).not.toMatch(/background[\\/]items/);
    }
    // The private state DOES exist, under the managed base, outside the prepared root.
    expect(existsSync(path.join(privateDir(), "items"))).toBe(true);
  });

  it("public background-status.json contains no absolute path and no forbidden fields", async () => {
    const original = putSource("report.pdf", "%PDF");
    await enqueue({ relpath: "report.pdf", kind: "document-extraction", sourceArtifactPath: original });
    await runBackgroundForRun({ runId: RUN, preparedDir, pdfTextExtractor: goodPdf("Clean text.") });

    const raw = readFileSync(publicStatusPath(preparedDir), "utf8");
    expect(raw).not.toContain(parentDir); // managed base / staging absolute path
    expect(raw).not.toContain(preparedDir); // agent-visible absolute path
    expect(raw).not.toContain(sourceDir); // source absolute path
    expect(raw).not.toContain("sourceArtifactPath");
    expect(raw).not.toContain("staging");
    // No forbidden keys anywhere in the parsed document.
    const status = await readPublicStatus(preparedDir);
    const keys = new Set<string>();
    JSON.stringify(status, (k, v) => (keys.add(k), v));
    for (const forbidden of ["sourceArtifactPath", "absPath", "provider", "error", "username", "machine", "env"]) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(status?.counts.completed).toBe(1);
    expect(status?.revision).toBe(1);
  });
});

describe("cancel reaches the worker", () => {
  it("discards a provider result that arrives AFTER a cancel (never published)", async () => {
    const original = putSource("late.pdf", "%PDF");
    const itemId = await enqueue({
      relpath: "late.pdf",
      kind: "document-extraction",
      sourceArtifactPath: original,
      itemId: "late-item",
    });
    // The extractor records a durable cancel for THIS item just before returning — so
    // the result "arrives after cancel" and must be discarded, not published.
    const cancelStore = new CancelStore(privateDir());
    const extractor: PdfTextExtractor = async () => {
      await cancelStore.requestItem(itemId);
      return { text: "Clean text that must NOT be published after cancel.", method: "pdf-text" };
    };

    const summary = await runBackgroundForRun({ runId: RUN, preparedDir, pdfTextExtractor: extractor });

    expect(summary.completed).toBe(0);
    expect(existsSync(path.join(preparedDir, "late.pdf.md"))).toBe(false);
    const item = (await BackgroundQueue.open(privateDir())).status(itemId);
    expect(item?.status).toBe("cancelled");
  });

  it("honors a persisted whole-run cancel requested before the worker runs", async () => {
    const original = putSource("a.txt", "content\n");
    await enqueue({ relpath: "a.txt", kind: "summarize-local", sourceArtifactPath: original });
    await requestBackgroundCancel({ runId: RUN, preparedDir });

    const summary = await runBackgroundForRun({
      runId: RUN,
      preparedDir,
      providerFactory: () => fakeProvider("should never publish"),
    });
    expect(summary.completed).toBe(0);
    expect(existsSync(path.join(preparedDir, "a.txt"))).toBe(false);
  });
});

describe("retry as a core API", () => {
  async function runToKeptLocal(): Promise<string> {
    const original = putSource("x.txt", "content\n");
    const itemId = await enqueue({ relpath: "x.txt", kind: "summarize-local", sourceArtifactPath: original });
    await runBackgroundForRun({ runId: RUN, preparedDir }); // no provider → kept-local
    return itemId;
  }

  it("retryItem re-queues the SAME itemId (no duplicate item)", async () => {
    const itemId = await runToKeptLocal();
    const before = (await BackgroundQueue.open(privateDir())).list(RUN);
    const retried = await retryBackgroundItem({ runId: RUN, preparedDir, itemId });
    const after = (await BackgroundQueue.open(privateDir())).list(RUN);
    expect(retried?.itemId).toBe(itemId);
    expect(retried?.status).toBe("pending");
    expect(after).toHaveLength(before.length); // no duplicate created
  });

  it("never retries a completed item", async () => {
    const original = putSource("done.pdf", "%PDF");
    const itemId = await enqueue({ relpath: "done.pdf", kind: "document-extraction", sourceArtifactPath: original });
    await runBackgroundForRun({ runId: RUN, preparedDir, pdfTextExtractor: goodPdf("Clean.") });
    const retried = await retryBackgroundItem({ runId: RUN, preparedDir, itemId });
    expect(retried?.status).toBe("completed"); // unchanged; not re-queued
  });

  it("failedOnly retry re-queues only failed/timed-out items", async () => {
    // One kept-local (summarize, no provider) and one hard-FAILED (publication fails
    // because its target path is blocked by a non-empty directory).
    const keptId = await enqueue({
      relpath: "keep.txt",
      kind: "summarize-local",
      sourceArtifactPath: putSource("keep.txt", "c\n"),
    });
    const failId = await enqueue({
      relpath: "boom.pdf",
      kind: "document-extraction",
      sourceArtifactPath: putSource("boom.pdf", "%PDF"),
    });
    // Block the publish target with a non-empty directory → the atomic rename fails →
    // the item is recorded `failed` (not kept-local).
    const blocked = path.join(preparedDir, withheldCompanion("boom.pdf"));
    mkdirSync(blocked, { recursive: true });
    writeFileSync(path.join(blocked, "occupied"), "x");

    await runBackgroundForRun({ runId: RUN, preparedDir, pdfTextExtractor: goodPdf("Clean text.") });

    const failed = (await BackgroundQueue.open(privateDir())).status(failId);
    expect(failed?.status).toBe("failed");

    const requeued = await retryBackgroundTerminal({ runId: RUN, preparedDir, failedOnly: true });
    const ids = requeued.map((i) => i.itemId);
    expect(ids).toContain(failId);
    expect(ids).not.toContain(keptId);
  });
});
