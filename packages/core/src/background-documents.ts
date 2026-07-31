import { createHash } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { PdfDocumentInspector, runDetectors } from "@yuhi/scanner";
import { runLocalPreparation } from "./route-executor.js";
import type { DocumentInspector, LocalModelProvider } from "@yuhi/shared";

export interface BackgroundDocumentResult {
  inspected: number;
  summariesCreated: number;
  summariesRejected: number;
  sensitiveDocuments: number;
  documents: {
    relpath: string;
    inspection: "pdf-text" | "ocr" | "incomplete";
    pages?: number;
    summary: "created" | "rejected" | "not-added";
    summaryRelpath?: string;
  }[];
}

export interface BackgroundDocumentOptions {
  relpaths: readonly string[];
  providerFactory?: () => LocalModelProvider;
  documentInspector?: DocumentInspector;
  localModelParallelism?: number;
  /** How many documents to inspect/summarize concurrently (speed). Default 3. */
  inspectionConcurrency?: number;
  /**
   * Optional Phase-3 enrichment: run the local model to summarize clean documents.
   * DEFAULT false — Yuhi's core (extract + OCR + rule inspection) must not depend on
   * Ollama. When false, inspection still completes; summaries are simply "unavailable".
   */
  enrichWithOllama?: boolean;
  /**
   * Honest, human-readable reason shown in the document index when local summaries
   * were NOT produced — e.g. "Local summary is disabled" or "Ollama is not running".
   * Prevents a silent "0 summaries" from looking like a failure.
   */
  summaryStatusNote?: string;
  /** Hard wall-clock cap per document so a slow/stuck file never traps the user. Default 60s. */
  perDocumentTimeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: {
    phase: "inspect" | "summarize" | "complete";
    current: number;
    total: number;
    /** Relpath of the document currently being processed (for a "current file" label). */
    relpath?: string;
  }) => void;
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Race a document inspection against a wall-clock cap. Returns "timeout" if the
 *  cap wins; the underlying subprocess is left to its own internal timeouts. */
async function withDocumentTimeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

/**
 * Optional intelligence over copies already present in a Prepared Workspace.
 * Raw extracted text remains in memory and is discarded after each document.
 */
export async function prepareDocumentsInBackground(
  preparedRoot: string,
  options: BackgroundDocumentOptions,
): Promise<BackgroundDocumentResult> {
  const root = await realpath(preparedRoot);
  const inspector = options.documentInspector ?? new PdfDocumentInspector();
  const documents: {
    relpath: string;
    inspection: "pdf-text" | "ocr" | "incomplete";
    pages?: number;
    summary: "created" | "rejected" | "not-added";
    summaryRelpath?: string;
  }[] = [];
  let provider: LocalModelProvider | undefined;
  let inspected = 0;
  let summariesCreated = 0;
  let summariesRejected = 0;
  let sensitiveDocuments = 0;
  const total = options.relpaths.length;

  type DocRecord = BackgroundDocumentResult["documents"][number];
  const ordered: (DocRecord | undefined)[] = new Array(total);
  let completed = 0;

  async function processDocument(index: number, relpath: string): Promise<void> {
    const candidate = path.resolve(root, relpath);
    if (!contained(root, candidate)) return;
    const candidateStat = await lstat(candidate);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) return;
    const canonical = await realpath(candidate);
    if (!contained(root, canonical)) return;
    const stat = await lstat(canonical);
    if (!stat.isFile()) return;
    options.onProgress?.({ phase: "inspect", current: completed, total, relpath });
    let extracted = "";
    // Hard per-document wall-clock timeout: a slow/stuck inspection (huge scan,
    // OCR over many pages, a wedged tool) must NEVER trap the user. On timeout the
    // document is treated as not-inspected (included with a warning) and we move on.
    const result = await withDocumentTimeout(
      inspector.inspect({ relpath, absPath: canonical }, (text) => { extracted = text; }),
      options.perDocumentTimeoutMs ?? 60_000,
    );
    if (result === "timeout") {
      ordered[index] = { relpath, inspection: "incomplete", summary: "not-added" };
      return;
    }
    inspected += 1;
    const metadata = {
      relpath,
      inspection:
        result.extractionMethod === "ocr"
          ? "ocr" as const
          : result.extractionMethod === "pdf-text"
            ? "pdf-text" as const
            : "incomplete" as const,
      ...(result.pageCount !== undefined ? { pages: result.pageCount } : {}),
    };
    if (result.status !== "inspected" || extracted.length === 0) {
      ordered[index] = { ...metadata, summary: "not-added" };
      return;
    }
    const sourceFindings = runDetectors(extracted, {
      relpath,
      entropyThreshold: 4.5,
      keywords: [],
    });
    const personalInformation =
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+\d{1,3}[- ]?)?(?:\(\d{2,4}\)[- ]?)?\d{2,4}[- ]\d{2,4}[- ]\d{3,4}|(?:氏名|full\s*name|address|住所)\s*[:：]/i;
    if (sourceFindings.length > 0 || personalInformation.test(extracted)) {
      sensitiveDocuments += 1;
      ordered[index] = { ...metadata, summary: "not-added" };
      return;
    }
    // Phase-3 enrichment is OFF by default: inspection (extract + rule scan) is the
    // core; Ollama summarization is optional. When disabled, the document is fully
    // inspected and simply has no summary — the Prepared Workspace stays usable.
    if (!options.enrichWithOllama) {
      ordered[index] = { ...metadata, summary: "not-added" };
      return;
    }
    provider ??= options.providerFactory?.();
    if (!provider) {
      ordered[index] = { ...metadata, summary: "not-added" };
      return;
    }
    options.onProgress?.({ phase: "summarize", current: completed, total, relpath });
    try {
      const prepared = await runLocalPreparation(
        extracted,
        ["summarize-local", "safety-check"],
        {
          provider,
          mode: "balanced",
          localModelParallelism: options.localModelParallelism ?? 2,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      const markdown =
        `# Document Summary\n\n${prepared.output.trim()}\n\n---\n\nGenerated locally by Yuhi.\n`;
      const summaryFindings = runDetectors(markdown, {
        relpath: "document-summary.md",
        entropyThreshold: 4.5,
        keywords: [],
      });
      if (
        prepared.status !== "ok" ||
        prepared.transmission !== "approved" ||
        summaryFindings.length > 0
      ) {
        summariesRejected += 1;
        ordered[index] = { ...metadata, summary: "rejected" };
      } else {
        const stem = path.basename(relpath, path.extname(relpath))
          .replace(/[^A-Za-z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "document";
        const suffix = createHash("sha256").update(relpath).digest("hex").slice(0, 8);
        const summaryRelpath = `.yuhi/context/${stem}.${suffix}.summary.md`;
        await atomicWrite(path.join(root, summaryRelpath), markdown);
        summariesCreated += 1;
        ordered[index] = { ...metadata, summary: "created", summaryRelpath };
      }
    } catch {
      summariesRejected += 1;
      ordered[index] = { ...metadata, summary: "rejected" };
    }
  }

  // Bounded-concurrency pool: inspect/summarize several documents at once so the
  // background enrichment finishes far sooner (the Prepared Workspace is already
  // usable — this only speeds up the optional context).
  const concurrency = Math.max(1, Math.min(options.inspectionConcurrency ?? 3, total || 1));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      if (options.signal?.aborted) {
        throw new DOMException("Background preparation aborted", "AbortError");
      }
      await processDocument(index, options.relpaths[index]!);
      completed += 1;
      options.onProgress?.({ phase: "inspect", current: completed, total });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  for (const record of ordered) if (record) documents.push(record);

  const index = [
    "# Yuhi Document Context",
    "",
    "Generated locally by Yuhi. Extracted document text is not stored.",
    "",
    "Some documents may have been available to Claude Code before background inspection completed.",
    "",
    // Honest local-summary status: never leave "0 summaries" unexplained.
    `## Local summaries: ${
      summariesCreated > 0
        ? `${summariesCreated} created`
        : options.enrichWithOllama === false
          ? `none — ${options.summaryStatusNote ?? "local summary is disabled"}`
          : options.summaryStatusNote
            ? `none — ${options.summaryStatusNote}`
            : "none created this run"
    }`,
    "",
    "Document text is extracted and rule-scanned locally, then discarded (never stored).",
    "Summaries are an optional local-model (Ollama) enrichment; the workspace is fully",
    "usable without them — open the original document directly when no summary is listed.",
    "",
    "## Documents",
    "",
    ...documents.flatMap((document) => [
      `### ${document.relpath}`,
      "",
      "- Status: Available",
      `- Inspection: ${
        document.inspection === "ocr"
          ? "OCR"
          : document.inspection === "pdf-text"
            ? "PDF text extraction"
            : "Incomplete"
      }`,
      ...(document.pages !== undefined ? [`- Pages: ${document.pages}`] : []),
      `- Summary: ${
        document.summary === "created"
          ? "Created"
          : document.summary === "rejected"
            ? "Not added (verification did not pass)"
            : "Not added"
      }`,
      ...(document.summaryRelpath ? [`- Context file: ${document.summaryRelpath}`] : []),
      "",
    ]),
  ].join("\n");
  await atomicWrite(path.join(root, ".yuhi/context/document-index.md"), `${index}\n`);
  options.onProgress?.({ phase: "complete", current: total, total });
  return { inspected, summariesCreated, summariesRejected, sensitiveDocuments, documents };
}
