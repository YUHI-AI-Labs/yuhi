/**
 * v0.3.5 integration tests for the real-processor wiring (`runBackgroundForRun`).
 *
 * These drive the WHOLE background path end-to-end against real fixtures for the
 * extraction/publish side (real BackgroundQueue, real BackgroundPublisher safety
 * gate, real document/summarize processors) while the PROVIDERS (Ollama local model
 * + PDF/OCR extractor) are FAKED/injected — no real network, model, or binary.
 *
 * Invariants asserted:
 *  - A clean fixture flows extract → normalize → pseudonymize → inspect → policy and
 *    its sanitized companion is published atomically under the prepared root.
 *  - The ORIGINAL source (PDF/txt) is never copied into the prepared root.
 *  - A secret-carrying fixture is kept local (never published); secrets exposed == 0.
 *  - An unavailable provider (OCR / local model) keeps the item local, never failed.
 *  - The private staging dir never remains after the run.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LocalModelProvider } from "@yuhi/shared";
import type { PdfTextExtractor } from "../document-artifact.js";
import { BackgroundQueue, runBackgroundForRun, type EnqueueInput } from "./index.js";

// Canonical AWS example key shape — recognised by the scanner's api-key detector.
const AWS_SECRET = "AKIAIOSFODNN7EXAMPLE";

let sourceDir: string;
let preparedDir: string;
let parentDir: string;

beforeEach(() => {
  parentDir = mkdtempSync(path.join(tmpdir(), "yuhi-bg-wiring-"));
  sourceDir = path.join(parentDir, "src");
  // Prepared root is a child of parentDir so the sibling staging dir also lands there.
  preparedDir = path.join(parentDir, "prepared-run");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(preparedDir, { recursive: true });
});

afterEach(() => {
  rmSync(parentDir, { recursive: true, force: true });
});

function putSource(rel: string, content: string): string {
  const abs = path.join(sourceDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

/** All on-disk file bytes under a directory tree (recursive). */
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

async function enqueue(input: Partial<EnqueueInput> & Pick<EnqueueInput, "relpath" | "kind" | "sourceArtifactPath">): Promise<void> {
  const queue = await BackgroundQueue.open(path.join(preparedDir, ".yuhi", "background"));
  await queue.enqueue({
    runId: "run-1",
    contextId: "ctx-1",
    sourceContentHash: "hash-" + input.relpath,
    processorVersion: "test@1",
    policyHash: "policy-1",
    ...input,
  });
}

/** A fake local model that returns a fixed completion (no network/model). */
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

describe("runBackgroundForRun — real-processor wiring (integration)", () => {
  it("publishes a sanitized companion for a clean document; original PDF never shared", async () => {
    const original = putSource("report.pdf", "%PDF-1.4 binary bytes not parsed by fake");
    await enqueue({ relpath: "report.pdf", kind: "document-extraction", sourceArtifactPath: original });

    // Faked PDF extractor — benign extracted text, no real pdftotext.
    const extractor: PdfTextExtractor = async () => ({
      text: "Quarterly report. Revenue increased. All figures nominal.",
      method: "pdf-text",
      pageCount: 1,
    });

    const summary = await runBackgroundForRun({
      runId: "run-1",
      preparedDir,
      pdfTextExtractor: extractor,
    });

    expect(summary.completed).toBe(1);
    expect(summary.keptLocal).toBe(0);
    expect(summary.failed).toBe(0);

    // The sanitized companion is published under the prepared (agent-visible) root.
    const companion = path.join(preparedDir, "report.pdf.md");
    expect(existsSync(companion)).toBe(true);
    expect(readFileSync(companion, "utf8")).toContain("Revenue increased");

    // The ORIGINAL PDF was never copied into the prepared workspace.
    expect(existsSync(path.join(preparedDir, "report.pdf"))).toBe(false);

    // Staging never remains.
    expect(existsSync(path.join(parentDir, ".yuhi-bg-staging-prepared-run"))).toBe(false);
  });

  it("keeps a secret-carrying summary local; the secret is never written anywhere", async () => {
    const original = putSource("notes.txt", "internal ops notes\n");
    await enqueue({ relpath: "notes.txt", kind: "summarize-local", sourceArtifactPath: original });

    // The fake model "leaks" a secret into its output — the safety gate must catch it.
    const provider = fakeProvider(`Summary of notes. Access key ${AWS_SECRET} referenced.`);

    const summary = await runBackgroundForRun({
      runId: "run-1",
      preparedDir,
      providerFactory: () => provider,
    });

    // Kept local — NOT published, NOT a hard failure.
    expect(summary.completed).toBe(0);
    expect(summary.keptLocal).toBe(1);

    expect(existsSync(path.join(preparedDir, "notes.txt"))).toBe(false);

    // Secrets exposed == 0: the raw secret is absent from EVERY delivered/staged byte.
    const preparedBytes = allBytesUnder(preparedDir);
    const stagedBytes = allBytesUnder(path.join(parentDir, ".yuhi-bg-staging-prepared-run"));
    for (const buf of [...preparedBytes, ...stagedBytes]) {
      expect(buf.toString("utf8")).not.toContain(AWS_SECRET);
    }
    expect(existsSync(path.join(parentDir, ".yuhi-bg-staging-prepared-run"))).toBe(false);
  });

  it("publishes a clean local summary companion at the file's own path", async () => {
    const original = putSource("memo.md", "Meeting agenda and action items.\n");
    await enqueue({ relpath: "memo.md", kind: "summarize-local", sourceArtifactPath: original });
    const calls = { n: 0 };
    const provider = fakeProvider("Agenda covers planning; action items assigned.", calls);

    const summary = await runBackgroundForRun({
      runId: "run-1",
      preparedDir,
      providerFactory: () => provider,
    });

    expect(calls.n).toBe(1); // the local model WAS invoked in the background
    expect(summary.completed).toBe(1);
    expect(existsSync(path.join(preparedDir, "memo.md"))).toBe(true);
    expect(readFileSync(path.join(preparedDir, "memo.md"), "utf8")).toContain("action items");
  });

  it("keeps local when the OCR provider is unavailable (no extractor injected)", async () => {
    const original = putSource("scan.pdf", "%PDF scanned image only");
    await enqueue({ relpath: "scan.pdf", kind: "ocr", sourceArtifactPath: original });

    const summary = await runBackgroundForRun({ runId: "run-1", preparedDir /* no pdfTextExtractor */ });

    expect(summary.completed).toBe(0);
    expect(summary.keptLocal).toBe(1);
    expect(summary.failed).toBe(0);
    expect(existsSync(path.join(preparedDir, "scan.pdf.md"))).toBe(false);
  });

  it("keeps local when the local model is unavailable (no providerFactory)", async () => {
    const original = putSource("draft.txt", "some content to summarize\n");
    await enqueue({ relpath: "draft.txt", kind: "summarize-local", sourceArtifactPath: original });

    const summary = await runBackgroundForRun({ runId: "run-1", preparedDir /* no providerFactory */ });

    expect(summary.completed).toBe(0);
    expect(summary.keptLocal).toBe(1);
    expect(existsSync(path.join(preparedDir, "draft.txt"))).toBe(false);
  });

  it("never mutates the source workspace and leaves no staging behind", async () => {
    const original = putSource("report.pdf", "%PDF original bytes");
    const sourceBefore = allBytesUnder(sourceDir).map((b) => b.toString("utf8"));
    const sourceRelBefore = relFilesUnder(sourceDir).sort();

    await enqueue({ relpath: "report.pdf", kind: "document-extraction", sourceArtifactPath: original });
    const extractor: PdfTextExtractor = async () => ({ text: "Benign extracted content.", method: "pdf-text" });
    await runBackgroundForRun({ runId: "run-1", preparedDir, pdfTextExtractor: extractor });

    expect(relFilesUnder(sourceDir).sort()).toEqual(sourceRelBefore);
    expect(allBytesUnder(sourceDir).map((b) => b.toString("utf8"))).toEqual(sourceBefore);
    expect(existsSync(path.join(parentDir, ".yuhi-bg-staging-prepared-run"))).toBe(false);
  });
});
