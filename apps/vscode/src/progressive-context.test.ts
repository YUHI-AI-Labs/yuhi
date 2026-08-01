import { describe, it, expect } from "vitest";
import { publicStatusPath, type PublicBackgroundStatus, type ProgressiveContextState } from "@yuhi/core";
import {
  ProgressiveContextController,
  buildProgressiveContextView,
  deriveProgressivePhase,
  hasBackgroundWork,
  renderProgressiveContext,
  type ProgressiveContextHost,
} from "./progressive-context.js";
import { renderActivityPanel } from "./activity-panel.js";

// ---------------------------------------------------------------------------
// Fixtures — hand-built PUBLIC status documents (path-safe by construction).
// ---------------------------------------------------------------------------

type Item = PublicBackgroundStatus["items"][number];

function mkStatus(items: Item[], revision = 0): PublicBackgroundStatus {
  const counts = {
    total: items.length,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    keptLocal: 0,
    cancelled: 0,
  };
  for (const it of items) {
    if (it.status === "pending") counts.pending += 1;
    else if (it.status === "processing") counts.processing += 1;
    else if (it.status === "completed") counts.completed += 1;
    else if (it.status === "failed") counts.failed += 1;
    else if (it.status === "cancelled") counts.cancelled += 1;
    else counts.keptLocal += 1; // kept-local / timed-out
  }
  return { schemaVersion: 1, counts, revision, items };
}

const INITIAL = mkStatus([
  { relpath: "a.pdf", kind: "document-extraction", status: "pending" },
  { relpath: "b.pdf", kind: "document-extraction", status: "pending" },
  { relpath: "notes.md", kind: "summarize-local", status: "pending" },
]);

const PROCESSING = mkStatus([
  { relpath: "a.pdf", kind: "document-extraction", status: "completed", preparedRelpath: "a.pdf.md" },
  { relpath: "b.pdf", kind: "document-extraction", status: "processing" },
  { relpath: "b.pdf", kind: "ocr", status: "pending" },
  { relpath: "notes.md", kind: "summarize-local", status: "pending" },
], 1);

const COMPLETED = mkStatus([
  { relpath: "a.pdf", kind: "document-extraction", status: "completed", preparedRelpath: "a.pdf.md" },
  { relpath: "notes.md", kind: "summarize-local", status: "completed", preparedRelpath: "notes.md" },
], 2);

const LIMITED = mkStatus([
  { relpath: "a.pdf", kind: "document-extraction", status: "completed", preparedRelpath: "a.pdf.md" },
  { relpath: "b.pdf", kind: "ocr", status: "kept-local", reasonCode: "background-ocr-unavailable" },
  { relpath: "c.pdf", kind: "document-extraction", status: "failed", reasonCode: "background-extraction-failed" },
], 1);

const CSP = "vscode-resource:";
const NONCE = "NONCE123";

// ---------------------------------------------------------------------------
// Pure phase derivation + view model.
// ---------------------------------------------------------------------------

describe("Progressive Context — phase derivation", () => {
  it("derives each phase purely from the public counts", () => {
    expect(deriveProgressivePhase(INITIAL)).toBe("initial");
    expect(deriveProgressivePhase(PROCESSING)).toBe("processing");
    expect(deriveProgressivePhase(COMPLETED)).toBe("completed");
    expect(deriveProgressivePhase(LIMITED)).toBe("limited");
  });

  it("hasBackgroundWork is false when there is nothing to process", () => {
    expect(hasBackgroundWork(mkStatus([]))).toBe(false);
    expect(hasBackgroundWork(undefined)).toBe(false);
    expect(hasBackgroundWork(INITIAL)).toBe(true);
  });

  it("view model carries only counts + revision (never a path)", () => {
    const vm = buildProgressiveContextView(PROCESSING, { contextFilesReady: 11 });
    expect(vm).toMatchObject({
      phase: "processing",
      contextFilesReady: 11,
      pending: 3, // processing(1) + pending(2) — the three unfinished items
      safeArtifactsAdded: 1,
      secretsExposed: 0,
    });
    // Per-kind aggregate progress — labels, not filenames.
    expect(vm.perKind).toEqual([
      { label: "PDF extraction", done: 1, total: 2 },
      { label: "OCR", done: 0, total: 1 },
      { label: "Local summaries", done: 0, total: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pure render — each state renders FROM a PublicBackgroundStatus fixture.
// ---------------------------------------------------------------------------

describe("Progressive Context — render each state", () => {
  const render = (s: PublicBackgroundStatus, contextFilesReady = 11) =>
    renderProgressiveContext(buildProgressiveContextView(s, { contextFilesReady }));

  it("initial: ready / pending / kept-local / secrets exposed 0", () => {
    const out = render(INITIAL);
    expect(out).toContain("Context files ready: 11");
    expect(out).toContain("Background processing: 3 pending");
    expect(out).toContain("Kept local: 0");
    expect(out).toContain("Secrets exposed: 0");
  });

  it("processing: per-kind progress + Cancel button", () => {
    const out = render(PROCESSING);
    expect(out).toContain("Improving context locally");
    expect(out).toContain("PDF extraction 1/2");
    expect(out).toContain("OCR 0/1");
    expect(out).toContain("Local summaries 0/1");
    expect(out).toContain("Cancel background processing");
    expect(out).toContain('id="cancelBackground"');
  });

  it("completed: artifacts added / remain local / revision + Refresh", () => {
    const out = render(COMPLETED);
    expect(out).toContain("Context improved");
    expect(out).toContain("2 safe artifacts added");
    expect(out).toContain("0 files remain local");
    expect(out).toContain("Context revision: 2");
    expect(out).toContain("Refresh Context");
    expect(out).toContain('id="refreshContext"');
  });

  it("failed/limited: safe artifacts added / still kept local", () => {
    const out = render(LIMITED);
    expect(out).toContain("Background processing completed with limitations");
    expect(out).toContain("Safe artifacts added: 1");
    expect(out).toContain("Still kept local: 2");
  });

  it("never renders an absolute path in any state", () => {
    for (const s of [INITIAL, PROCESSING, COMPLETED, LIMITED]) {
      const out = render(s);
      expect(out).not.toMatch(/(^|["'\s(])\/(Users|home|var|private|tmp|Applications)\//);
      // No .internal private-state path ever appears in the UI.
      expect(out).not.toContain(".internal");
    }
  });
});

// ---------------------------------------------------------------------------
// Panel integration — the card renders on BOTH launchable surfaces.
// ---------------------------------------------------------------------------

describe("Progressive Context — panel integration", () => {
  it("renders inside the YUHI MODE surface", () => {
    const vm = buildProgressiveContextView(PROCESSING, { contextFilesReady: 11 });
    const out = renderActivityPanel(
      { phase: "yuhi-mode", filesAvailable: 11, filesExcluded: 0, progressive: vm },
      CSP,
      NONCE,
    );
    expect(out).toContain("YUHI MODE");
    expect(out).toContain("Improving context locally");
    expect(out).toContain("Cancel background processing");
  });

  it("renders inside the Ready surface", () => {
    const vm = buildProgressiveContextView(COMPLETED, { contextFilesReady: 5 });
    const out = renderActivityPanel(
      {
        phase: "ready",
        filesDiscovered: 5,
        documentsInspected: 2,
        summariesRejected: 0,
        contextIndex: true,
        agentHandoff: true,
        progressive: vm,
      },
      CSP,
      NONCE,
    );
    expect(out).toContain("Context improved");
    expect(out).toContain("Refresh Context");
  });
});

// ---------------------------------------------------------------------------
// Host-wiring controller — with fakes (start / cancel / refresh / reload).
// ---------------------------------------------------------------------------

const BASE_CONTEXT_ID = "sha256:" + "a".repeat(64);
const REVISION_ID = "sha256:" + "b".repeat(64);

function fakeState(revision: number, baseContextId = BASE_CONTEXT_ID): ProgressiveContextState {
  return {
    baseContextId,
    revision,
    revisionId: REVISION_ID,
    completedItems: revision,
    pendingItems: 0,
    failedItems: 0,
    updatedAt: "",
  };
}

interface Calls {
  runBackground: Array<{ runId: string; preparedDir: string }>;
  cancelBackground: Array<{ runId: string; preparedDir: string }>;
  readStatusPaths: string[];
  computeRevision: Array<{ baseContextId: string }>;
  recordRevision: Array<{ preparedDir: string; state: ProgressiveContextState }>;
  views: Array<ReturnType<ProgressiveContextController["currentView"]>>;
}

function makeHost(statusRef: { value: PublicBackgroundStatus | undefined }): {
  host: ProgressiveContextHost;
  calls: Calls;
} {
  const calls: Calls = {
    runBackground: [],
    cancelBackground: [],
    readStatusPaths: [],
    computeRevision: [],
    recordRevision: [],
    views: [],
  };
  const host: ProgressiveContextHost = {
    runBackground: async ({ runId, preparedDir }) => {
      calls.runBackground.push({ runId, preparedDir });
    },
    cancelBackground: async ({ runId, preparedDir }) => {
      calls.cancelBackground.push({ runId, preparedDir });
    },
    readStatus: async (preparedDir) => {
      calls.readStatusPaths.push(preparedDir);
      return statusRef.value;
    },
    computeRevision: ({ baseContextId }) => {
      calls.computeRevision.push({ baseContextId });
      return fakeState(statusRef.value?.counts.completed ?? 0, baseContextId);
    },
    recordRevision: async (preparedDir, state) => {
      calls.recordRevision.push({ preparedDir, state });
    },
    onView: (view) => {
      calls.views.push(view);
    },
  };
  return { host, calls };
}

const PREPARED_DIR = "/prepared/run-xyz"; // a preparedDir; the private state is NOT under it
const START = {
  runId: "run-xyz",
  preparedDir: PREPARED_DIR,
  baseContextId: BASE_CONTEXT_ID,
  filesAvailable: 11,
};

describe("ProgressiveContextController — host wiring", () => {
  it("start(worker) runs the background run fire-and-forget and reads the public status", async () => {
    const statusRef = { value: INITIAL as PublicBackgroundStatus | undefined };
    const { host, calls } = makeHost(statusRef);
    const controller = new ProgressiveContextController(host);
    controller.start({ ...START, startWorker: true });
    await controller.refreshFromDisk();
    expect(calls.runBackground).toEqual([{ runId: "run-xyz", preparedDir: PREPARED_DIR }]);
    expect(calls.readStatusPaths.every((p) => p === PREPARED_DIR)).toBe(true);
    expect(controller.currentView()?.phase).toBe("initial");
  });

  it("Cancel calls requestBackgroundCancel and recovers to a usable state (never stuck)", async () => {
    const statusRef = { value: PROCESSING as PublicBackgroundStatus | undefined };
    const { host, calls } = makeHost(statusRef);
    const controller = new ProgressiveContextController(host);
    controller.start({ ...START, startWorker: true });
    // Simulate the queue reflecting the cancel (pending → cancelled).
    statusRef.value = mkStatus([
      { relpath: "a.pdf", kind: "document-extraction", status: "completed", preparedRelpath: "a.pdf.md" },
      { relpath: "b.pdf", kind: "document-extraction", status: "cancelled" },
    ], 1);
    await controller.cancel();
    expect(calls.cancelBackground).toEqual([{ runId: "run-xyz", preparedDir: PREPARED_DIR }]);
    const view = controller.currentView();
    expect(view).toBeDefined(); // panel is usable, not stuck
    expect(controller.isRunning()).toBe(false);
  });

  it("Refresh recomputes the revision with the SAME baseContextId and does NOT re-prepare", async () => {
    const statusRef = { value: COMPLETED as PublicBackgroundStatus | undefined };
    const { host, calls } = makeHost(statusRef);
    const controller = new ProgressiveContextController(host);
    controller.start({ ...START, startWorker: true });
    const runsBefore = calls.runBackground.length;

    const state = await controller.refresh();
    expect(state?.baseContextId).toBe(BASE_CONTEXT_ID); // SAME id, never recomputed
    expect(calls.computeRevision).toEqual([{ baseContextId: BASE_CONTEXT_ID }]);
    // Refresh MUST NOT re-run the worker (no re-prepare / re-scan).
    expect(calls.runBackground.length).toBe(runsBefore);
    // The used revision is recorded in the session manifest.
    expect(calls.recordRevision).toHaveLength(1);
    expect(calls.recordRevision[0]!.state.baseContextId).toBe(BASE_CONTEXT_ID);
    // The displayed revision updates.
    expect(controller.currentView()?.revision).toBe(2);
  });

  it("restores state from the public status file after a simulated reload (poll-only, no re-run)", async () => {
    const statusRef = { value: COMPLETED as PublicBackgroundStatus | undefined };
    const { host, calls } = makeHost(statusRef);
    // A fresh controller (as after a window reload) that only READS the public status.
    const controller = new ProgressiveContextController(host);
    controller.start({ ...START, startWorker: false });
    await controller.refreshFromDisk();
    expect(calls.runBackground).toHaveLength(0); // display-only: no worker started
    expect(controller.currentView()?.phase).toBe("completed");
    expect(controller.currentView()?.revision).toBe(2);
  });

  it("reads ONLY the public status path — never the private .internal/background state", async () => {
    const statusRef = { value: PROCESSING as PublicBackgroundStatus | undefined };
    const { host, calls } = makeHost(statusRef);
    const controller = new ProgressiveContextController(host);
    controller.start({ ...START, startWorker: true });
    await controller.refreshFromDisk();
    await controller.refresh();
    await controller.cancel();
    // Every path the controller ever touched is the prepared dir (public), and the
    // real public-status file resolves under it — NOT under the private root.
    for (const p of calls.readStatusPaths) expect(p).toBe(PREPARED_DIR);
    const publicFile = publicStatusPath(PREPARED_DIR);
    expect(publicFile).toContain(".yuhi");
    expect(publicFile).not.toContain(".internal");
    for (const c of [...calls.runBackground, ...calls.cancelBackground]) {
      expect(c.preparedDir).not.toContain(".internal");
    }
  });

  it("dispose() aborts and stops emitting", async () => {
    const statusRef = { value: INITIAL as PublicBackgroundStatus | undefined };
    const { host, calls } = makeHost(statusRef);
    const controller = new ProgressiveContextController(host);
    controller.start({ ...START, startWorker: true });
    controller.dispose();
    const before = calls.views.length;
    await controller.refreshFromDisk();
    expect(calls.views.length).toBe(before); // no further emissions after dispose
  });
});
