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
    expect(report.publicSummary?.backgroundPendingFiles).toBe(1);
    expect(report.publicSummary?.excludedForSafetyFiles).toBe(0);
    const handoff = readFileSync(
      path.join(report.outDir, ".yuhi", "context", "AGENT_HANDOFF.md"),
      "utf8",
    );
    expect(handoff).toContain("Processing locally in background: 1");
    expect(handoff).not.toContain("notes/report.md");
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

    // Balanced exposes the useful original with a warning; heavy extraction did not run.
    expect(existsSync(path.join(report.outDir, "docs", "report.pdf.md"))).toBe(false);
    expect(existsSync(path.join(report.outDir, "docs", "report.pdf"))).toBe(true);

    const entry = report.files.find((f) => (f.originalRelpath ?? f.relpath) === "docs/report.pdf");
    expect(entry?.outcome).toBe("background-processing-pending");
    expect(entry?.omitted).toBe(false);
    expect(entry?.availabilityStatus).toBe("available-with-warning");
    expect(entry?.document?.sourceType).toBe("pdf");
    expect(entry?.document?.extractionStatus).toBe("pending");
    expect(entry?.document?.originalSharedWithAgent).toBe(true);
    expect(report.publicSummary?.availableWithWarningFiles).toBe(1);
    expect(report.publicSummary?.backgroundPendingFiles).toBe(1);
    expect(report.publicSummary?.excludedForSafetyFiles).toBe(0);
    expect(
      readFileSync(path.join(report.outDir, ".yuhi", "context", "AGENT_HANDOFF.md"), "utf8"),
    ).not.toContain("docs/report.pdf");

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
    // Balanced keeps the warning-marked original available while adding the companion.
    expect(existsSync(path.join(report.outDir, "docs", "report.pdf"))).toBe(true);
  });
});

/** A provider that would sleep `ms` PER CALL — so any foreground per-item model work
 *  would show up as N*ms of wall-time. Under deferral it is never called at all. */
function sleepingProvider(calls: { n: number }, ms: number): LocalModelProvider {
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
      await new Promise((r) => setTimeout(r, ms));
      return "should never run in foreground";
    },
  } as unknown as LocalModelProvider;
}

describe("v0.3.5 gate — foreground wall-time is independent of background item count", () => {
  /** Add N extra summarize-local targets (matched by the `notes/*.md` rule). */
  function addNotes(n: number): void {
    for (let i = 0; i < n; i += 1) {
      put(`notes/extra-${i}.md`, "# Extra\n\n" + "Prose line. ".repeat(30) + "\n");
    }
  }

  it("foreground makes ZERO heavy calls and does not grow with N deferred items", async () => {
    // A tiny run (1 deferred item, from beforeEach) vs a large run (65 deferred items).
    // The provider would sleep 80ms PER CALL, so if the foreground did per-item heavy
    // work the large run would cost >= 64*80ms = ~5.1s more than the tiny run.
    const perCallMs = 80;

    const smallCalls = { n: 0 };
    const t0s = performance.now();
    const small = await prepareWorkspace(dir, {
      managedWorkspaceBase: managedDir,
      deferLocalSummary: true,
      provider: sleepingProvider(smallCalls, perCallMs),
    });
    const smallElapsed = performance.now() - t0s;

    addNotes(64); // now 65 summarize-local targets total
    const largeCalls = { n: 0 };
    const t0l = performance.now();
    const large = await prepareWorkspace(dir, {
      managedWorkspaceBase: managedDir,
      deferLocalSummary: true,
      provider: sleepingProvider(largeCalls, perCallMs),
    });
    const largeElapsed = performance.now() - t0l;

    // 1) Foreground made ZERO heavy provider calls at BOTH scales (the heavy path is
    //    never entered in the foreground, whatever the item count).
    expect(smallCalls.n).toBe(0);
    expect(largeCalls.n).toBe(0);

    // 2) All the deferred items were queued (proving the work really was registered,
    //    not silently dropped): 65 background items in the large run's private queue.
    const largeQueue = await BackgroundQueue.open(privateBackgroundDir(managedDir, large.runId));
    const summarizeItems = largeQueue.list(large.runId).filter((i) => i.kind === "summarize-local");
    expect(summarizeItems.length).toBe(65);
    expect(summarizeItems.every((i) => i.status === "pending")).toBe(true);

    // 3) Wall-time did NOT grow with the heavy per-item cost. If foreground had summarized
    //    per item, the extra 64 items would add >= 64*80ms; assert the growth stays far
    //    below that (a generous bound that still fails hard on per-item foreground work).
    const perItemBudget = 64 * perCallMs; // ~5120ms of heavy work that MUST NOT happen
    expect(largeElapsed - smallElapsed).toBeLessThan(perItemBudget * 0.5);
    // Sanity: the small foreground itself never paid a single 80ms heavy call.
    expect(smallElapsed).toBeLessThan(perItemBudget);
  });
});

describe("v0.3.5 gate — private background state is NOT reachable from the prepared root", () => {
  /** Every file path (repo-relative, POSIX) under a directory tree. */
  function walkRel(root: string): string[] {
    if (!existsSync(root)) return [];
    return (readdirSync(root, { recursive: true }) as string[])
      .filter((rel) => {
        try {
          return statSync(path.join(root, rel)).isFile();
        } catch {
          return false;
        }
      })
      .map((rel) => rel.split(path.sep).join("/"));
  }

  it("no private queue/staging/cancel state exists anywhere under the agent-visible prepared root", async () => {
    put("docs/scan.pdf", "%PDF-1.4 fake\n");
    const report = await prepareWorkspace(dir, {
      managedWorkspaceBase: managedDir,
      deferLocalSummary: true,
      deferDocumentInspection: true,
    });

    // Drain the queue so private records, staging, and cancel flags have all had a
    // chance to be written — then prove NONE of them landed under the prepared root.
    await runBackgroundForRun({
      runId: report.runId,
      preparedDir: report.outDir,
      pdfTextExtractor: async () => ({ text: "Benign extracted text.", method: "pdf-text", pageCount: 1 }),
    });

    const preparedRoot = path.resolve(report.outDir);
    const relFiles = walkRel(preparedRoot);

    // Not one private-state artifact is reachable by walking the prepared root.
    for (const rel of relFiles) {
      expect(rel).not.toContain(".internal");
      expect(rel).not.toContain("queue.json");
      expect(rel).not.toMatch(/(^|\/)items(\/|$)/);
      expect(rel).not.toContain("staging");
      expect(rel).not.toContain("cancel");
      expect(rel).not.toContain("sourceArtifactPath");
    }
    // The only `.yuhi` background surface is the single PUBLIC status file.
    const yuhiFiles = relFiles.filter((r) => r.startsWith(".yuhi/"));
    expect(yuhiFiles).toContain(".yuhi/background-status.json");

    // The private root is a REAL directory, but it resolves OUTSIDE the prepared root
    // (path.relative escapes upward with `..`), so it is unreachable from within.
    const privateRoot = privateBackgroundDir(managedDir, report.runId);
    expect(existsSync(path.join(privateRoot, "items"))).toBe(true);
    const rel = path.relative(preparedRoot, privateRoot);
    expect(rel.startsWith("..")).toBe(true);
    expect(privateRoot.startsWith(preparedRoot + path.sep)).toBe(false);
  });
});
