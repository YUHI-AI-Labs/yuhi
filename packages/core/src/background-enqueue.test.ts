/**
 * v0.3.5 Step 5 — foreground → background queue registration.
 *
 * The fast (foreground) prepare must reach "Yuhi Mode ready" with ZERO heavy-processor
 * calls (no Ollama, no OCR, no heavy extraction). For every file DEFERRED for local
 * summarization it must instead register a persistent background item and mark the
 * manifest `background-processing-pending` — but ONLY after the enqueue succeeds. If
 * the enqueue fails, the file stays kept-local (never mislabeled) and its original is
 * never delivered un-inspected.
 */
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LocalModelProvider } from "@yuhi/shared";
import type { PdfTextExtractor } from "./document-artifact.js";
import { prepareWorkspace } from "./prepare-workspace.js";
import {
  BackgroundQueue,
  runBackgroundForRun,
  privateBackgroundDir,
  publicStatusPath,
  readPublicStatus,
} from "./background/index.js";

let dir: string;
let managedDir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuhi-bgq-src-"));
  managedDir = mkdtempSync(path.join(tmpdir(), "yuhi-bgq-managed-"));

  put("src/index.ts", "export const answer = 42;\n");
  // A summarize target: routed `summarize-local`, so its de-identification pipeline
  // needs the local model. Under deferLocalSummary the model never runs in foreground.
  put("notes/report.md", "# Report\n\n" + "Detailed prose. ".repeat(50) + "\n");
  put(
    "yuhi.yaml",
    'version: "1"\n' +
      "include_untracked: true\n" +
      "defaults: { action: allow }\n" +
      "rules:\n" +
      "  - name: summarize-notes\n" +
      '    match: { paths: ["notes/*.md"] }\n' +
      "    action: summarize-local\n",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(managedDir, { recursive: true, force: true });
});

function put(rel: string, content: string): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** A local model provider that MUST NOT be called in the foreground; records calls. */
function trackingProvider(calls: { n: number }): LocalModelProvider {
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
      calls.n += 1;
      return "should never run in foreground";
    },
  } as unknown as LocalModelProvider;
}

describe("v0.3.5 foreground → background queue registration", () => {
  it("enqueues deferred summarize targets and marks them background-processing-pending (zero provider calls)", async () => {
    const calls = { n: 0 };
    const report = await prepareWorkspace(dir, {
      managedWorkspaceBase: managedDir,
      deferLocalSummary: true,
      provider: trackingProvider(calls),
    });

    // Yuhi Mode ready with ZERO Ollama/OCR/heavy-extraction calls in the foreground.
    expect(calls.n).toBe(0);

    const entry = report.files.find((f) => (f.originalRelpath ?? f.relpath) === "notes/report.md");
    expect(entry).toBeDefined();
    // Marked pending (enqueue succeeded); the original is still withheld (omitted).
    expect(entry?.outcome).toBe("background-processing-pending");
    expect(entry?.omitted).toBe(true);
    // The original is NOT delivered into the prepared workspace.
    expect(existsSync(path.join(report.outDir, "notes", "report.md"))).toBe(false);

    // A persistent background item was written to the run's PRIVATE queue (under the
    // managed base, NOT the agent-visible prepared root).
    const queue = await BackgroundQueue.open(privateBackgroundDir(managedDir, report.runId));
    const items = queue.list(report.runId);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("summarize-local");
    expect(items[0]?.relpath).toBe("notes/report.md");
    expect(items[0]?.status).toBe("pending");

    // Private queue state is NOT reachable from the agent-visible prepared root.
    expect(existsSync(path.join(report.outDir, ".yuhi", "background"))).toBe(false);
    // The PUBLIC status file IS in the prepared root and carries no absolute path.
    const raw = readFileSync(publicStatusPath(report.outDir), "utf8");
    expect(raw).not.toContain(managedDir);
    expect(raw).not.toContain("sourceArtifactPath");
    const status = await readPublicStatus(report.outDir);
    expect(status?.counts.pending).toBe(1);
  });

  it("keeps the file local (not pending) when the enqueue cannot be persisted", async () => {
    const calls = { n: 0 };
    // Sabotage the queue: create a FILE where the queue's items dir must be, so
    // BackgroundQueue.open() fails. The enqueue guard must then leave the file
    // kept-local — NEVER mislabeled as background-processing-pending.
    const report = await prepareWorkspace(dir, {
      managedWorkspaceBase: managedDir,
      deferLocalSummary: true,
      provider: trackingProvider(calls),
      onCheckpoint: (checkpoint) => {
        if (checkpoint !== "workspace-created") return;
        // The just-created run is the only dir under managedDir.
        const runId = readdirSync(managedDir).find((name) =>
          statSync(path.join(managedDir, name)).isDirectory(),
        );
        if (!runId) return;
        // Place a regular FILE where the PRIVATE queue dir must be, so opening the
        // queue (mkdir <privateDir>/items) fails → the enqueue guard keeps it local.
        const priv = privateBackgroundDir(managedDir, runId);
        mkdirSync(path.dirname(priv), { recursive: true });
        writeFileSync(priv, "blocker");
      },
    });

    expect(calls.n).toBe(0);
    const entry = report.files.find((f) => (f.originalRelpath ?? f.relpath) === "notes/report.md");
    expect(entry).toBeDefined();
    // Enqueue failed → NOT mislabeled; stays kept-local, original withheld.
    expect(entry?.outcome).not.toBe("background-processing-pending");
    expect(entry?.omitted).toBe(true);
    expect(existsSync(path.join(report.outDir, "notes", "report.md"))).toBe(false);
  });

  it("enqueues a document (PDF) for background extraction with ZERO foreground extraction", async () => {
    put("docs/report.pdf", "%PDF-1.4 fake bytes never parsed in the foreground\n");

    const report = await prepareWorkspace(dir, {
      managedWorkspaceBase: managedDir,
      deferDocumentInspection: true,
    });

    // No companion or original delivered in the foreground; heavy extraction did not run.
    expect(existsSync(path.join(report.outDir, "docs", "report.pdf.md"))).toBe(false);
    expect(existsSync(path.join(report.outDir, "docs", "report.pdf"))).toBe(false);

    const entry = report.files.find((f) => (f.originalRelpath ?? f.relpath) === "docs/report.pdf");
    expect(entry?.outcome).toBe("background-processing-pending");
    expect(entry?.omitted).toBe(true);
    expect(entry?.document?.sourceType).toBe("pdf");
    expect(entry?.document?.extractionStatus).toBe("pending");
    expect(entry?.document?.originalSharedWithAgent).toBe(false);

    // A persistent document-extraction item is in the run's queue.
    const queue = await BackgroundQueue.open(privateBackgroundDir(managedDir, report.runId));
    const item = queue.list(report.runId).find((i) => i.relpath === "docs/report.pdf");
    expect(item?.kind).toBe("document-extraction");
    expect(item?.status).toBe("pending");

    // The source PDF is untouched by the foreground pass.
    expect(existsSync(path.join(dir, "docs", "report.pdf"))).toBe(true);

    // Background processing (faked extractor) publishes the sanitized companion atomically.
    const extractor: PdfTextExtractor = async () => ({
      text: "Quarterly numbers are within plan. No blockers.",
      method: "pdf-text",
      pageCount: 1,
    });
    const summary = await runBackgroundForRun({
      runId: report.runId,
      preparedDir: report.outDir,
      pdfTextExtractor: extractor,
    });

    expect(summary.completed).toBe(1);
    const companion = path.join(report.outDir, "docs", "report.pdf.md");
    expect(existsSync(companion)).toBe(true);
    // The ORIGINAL PDF is still never shared into the prepared workspace.
    expect(existsSync(path.join(report.outDir, "docs", "report.pdf"))).toBe(false);
  });
});
