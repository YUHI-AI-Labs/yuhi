/**
 * Yuhi v0.3.5 "Progressive Context" — the VS Code surface.
 *
 * After Yuhi Mode is ready, background preparation (PDF/DOCX extraction, OCR, local
 * summaries) keeps running and, when a result passes the safety gate, adds a
 * sanitized companion to the agent-visible workspace. This module lets the panel
 * HONESTLY show that progress and lets the user Cancel it or Refresh the delivered
 * Context Revision.
 *
 * SECURITY BOUNDARY (enforced here): every displayed number and label is derived
 * ONLY from the PUBLIC status document (`<preparedDir>/.yuhi/background-status.json`
 * → {@link PublicBackgroundStatus}). The PRIVATE queue state (the internal
 * background root under the managed base) — which carries absolute source paths,
 * staging paths, provider detail, and raw errors — is NEVER read from here. The
 * public status is path-safe by construction, and the view model below carries only
 * counts, aggregate per-kind progress, and a revision number: no absolute path, no
 * original filename, no secret, no raw error ever reaches the UI.
 *
 * Split (mirrors agent-picker.ts):
 *   - a PURE view builder + renderer — no VS Code, no DOM, unit-tested;
 *   - a HOST-WIRING controller that takes injected core primitives (start / cancel /
 *     read-status / reduce-revision) so it is fully testable with fakes.
 */
import type {
  ProgressiveContextState,
  PublicBackgroundStatus,
  PublicStatusItem,
} from "@yuhi/core";

// ---------------------------------------------------------------------------
// Pure view model.
// ---------------------------------------------------------------------------

/** Which honest surface to show for the background run. */
export type ProgressivePhase = "initial" | "processing" | "completed" | "limited";

/** Aggregate progress for one kind of heavy work (NO per-file paths). */
export interface KindProgress {
  label: string;
  done: number;
  total: number;
}

/**
 * The path-safe view model the panel renders. Derived ONLY from the public status
 * (+ the already-known count of base context files). Contains counts, aggregate
 * per-kind progress, and a revision number — never a path, filename, or secret.
 */
export interface ProgressiveContextViewModel {
  phase: ProgressivePhase;
  /** Files already available to the agent (base prepared files). */
  contextFilesReady: number;
  /** Still queued or in flight (pending + processing). */
  pending: number;
  /** Terminal-but-unpublished: kept-local + failed + timed-out + cancelled. */
  keptLocal: number;
  /** Originals are already warning-available, but no verified companion was produced. */
  companionUnavailable: number;
  /** Safely-published companions (== completed). */
  safeArtifactsAdded: number;
  /** The delivered Context Revision to display. */
  revision: number;
  /** Always 0 — the safety boundary never exposes the original bytes. */
  secretsExposed: 0;
  /** Per-kind aggregate progress (processing phase only). */
  perKind: KindProgress[];
}

/** Human labels for the three heavy-work kinds (aggregate, path-free). */
const KIND_LABELS: Record<string, string> = {
  "document-extraction": "PDF extraction",
  ocr: "OCR",
  "summarize-local": "Local summaries",
};

/** Stable display order of the kinds. */
const KIND_ORDER = ["document-extraction", "ocr", "summarize-local"] as const;

/** Terminal-but-unpublished items count as "kept local" for display purposes. */
function keptLocalCount(status: PublicBackgroundStatus): number {
  const c = status.counts;
  return c.keptLocal + c.failed + c.cancelled;
}

/** True when this status describes any background work at all. */
export function hasBackgroundWork(status: PublicBackgroundStatus | undefined): status is PublicBackgroundStatus {
  return !!status && status.counts.total > 0;
}

/**
 * Derive the honest phase purely from the public counts, so a fixture renders the
 * same state a live run would:
 *   - active (pending/processing) & nothing has moved yet → `initial`
 *   - active & something has started/finished              → `processing`
 *   - terminal & at least one item kept-local/failed/etc.  → `limited`
 *   - terminal & all published                             → `completed`
 */
export function deriveProgressivePhase(status: PublicBackgroundStatus): ProgressivePhase {
  const c = status.counts;
  const active = c.pending + c.processing > 0;
  if (active) {
    const moved = c.processing + c.completed + keptLocalCount(status) > 0;
    return moved ? "processing" : "initial";
  }
  if (keptLocalCount(status) > 0 || status.counts.companionUnavailable > 0) return "limited";
  return "completed";
}

/** Build the per-kind aggregate progress from the public items (no paths leak). */
function perKindProgress(status: PublicBackgroundStatus): KindProgress[] {
  const totals = new Map<string, { done: number; total: number }>();
  for (const item of status.items) {
    const entry = totals.get(item.kind) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (item.status === "completed") entry.done += 1;
    totals.set(item.kind, entry);
  }
  const out: KindProgress[] = [];
  for (const kind of KIND_ORDER) {
    const entry = totals.get(kind);
    if (entry && entry.total > 0) {
      out.push({ label: KIND_LABELS[kind] ?? kind, done: entry.done, total: entry.total });
    }
  }
  return out;
}

/**
 * Build the path-safe {@link ProgressiveContextViewModel} from the public status.
 * `contextFilesReady` is the already-known count of base prepared files; `revision`
 * defaults to the status' own revision but may be overridden (e.g. after an explicit
 * Refresh recomputes it).
 */
export function buildProgressiveContextView(
  status: PublicBackgroundStatus,
  opts: { contextFilesReady: number; revision?: number } = { contextFilesReady: 0 },
): ProgressiveContextViewModel {
  const bySource = new Map<string, PublicStatusItem>();
  const rank = (value: string): number => value === "completed" ? 5 : value === "processing" ? 4 : value === "pending" ? 3 : value === "failed" ? 2 : 1;
  for (const item of status.items) {
    // Identity, not name: a withheld original has no agent-visible `relpath`, so the
    // per-source dedup keys on the stable `documentId` (see `metadata-boundary.ts`).
    const key = item.documentId ?? item.relpath ?? item.displayName ?? "";
    const current = bySource.get(key);
    if (!current || rank(item.status) >= rank(current.status)) bySource.set(key, item);
  }
  const sources = [...bySource.values()];
  const pending = sources.filter((item) => item.status === "pending" || item.status === "processing").length;
  const completed = sources.filter((item) => item.status === "completed").length;
  const companionUnavailable = sources.filter(
    (item) => item.originalSharedWithWarning && !["pending", "processing", "completed"].includes(item.status),
  ).length;
  const keptLocal = sources.filter(
    (item) => !item.originalSharedWithWarning && !["pending", "processing", "completed"].includes(item.status),
  ).length;
  return {
    phase: deriveProgressivePhase(status),
    contextFilesReady: Math.max(0, opts.contextFilesReady),
    pending,
    keptLocal,
    companionUnavailable,
    safeArtifactsAdded: completed,
    revision: opts.revision ?? status.revision,
    secretsExposed: 0,
    perKind: perKindProgress(status),
  };
}

// ---------------------------------------------------------------------------
// Pure render (markup only; the panel owns the single acquireVsCodeApi handle).
// ---------------------------------------------------------------------------

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}

/** The button ids the panel script wires for the background surface. */
export const PROGRESSIVE_CANCEL_ID = "cancelBackground";
export const PROGRESSIVE_REFRESH_ID = "refreshContext";

function pcLine(mark: "done" | "warn" | "active" | "todo", text: string): string {
  const glyph =
    mark === "done"
      ? '<span class="ck ok" aria-hidden="true">✓</span>'
      : mark === "warn"
        ? '<span class="ck warn" aria-hidden="true">⚠</span>'
        : mark === "active"
          ? '<span class="ck spin" aria-hidden="true">◐</span>'
          : '<span class="ck todo" aria-hidden="true">·</span>';
  return `<div class="st ${mark}">${glyph}<span>${esc(text)}</span></div>`;
}

function pcButton(id: string, label: string): string {
  return `<button type="button" id="${id}" class="btn">${esc(label)}</button>`;
}

/**
 * Render the Progressive Context card for a given view model. MARKUP ONLY — no
 * `<script>`; the enclosing panel already wires the Cancel / Refresh button ids.
 * The output carries only counts, aggregate labels, and a revision number.
 */
export function renderProgressiveContext(vm: ProgressiveContextViewModel): string {
  let heading: string;
  let body: string;
  switch (vm.phase) {
    case "initial":
      heading = "Background context";
      body =
        pcLine("done", `Context files ready: ${vm.contextFilesReady}`) +
        pcLine("active", `Background processing: ${vm.pending} pending`) +
        pcLine("todo", `Kept local: ${vm.keptLocal}`) +
        pcLine("todo", `Companion unavailable: ${vm.companionUnavailable}`) +
        pcLine("done", `Secrets exposed: ${vm.secretsExposed}`);
      break;
    case "processing":
      heading = "Improving context locally";
      body =
        (vm.perKind.length
          ? vm.perKind.map((k) => pcLine("active", `${k.label} ${k.done}/${k.total}`)).join("")
          : pcLine("active", `Background processing: ${vm.pending} pending`)) +
        pcButton(PROGRESSIVE_CANCEL_ID, "Cancel background processing");
      break;
    case "completed":
      heading = "Context improved";
      body =
        pcLine("done", `${vm.safeArtifactsAdded} safe artifact${vm.safeArtifactsAdded === 1 ? "" : "s"} added`) +
        pcLine("todo", `${vm.keptLocal} file${vm.keptLocal === 1 ? "" : "s"} remain local`) +
        pcLine("done", `Context revision: ${vm.revision}`) +
        pcButton(PROGRESSIVE_REFRESH_ID, "Refresh Context");
      break;
    case "limited":
      heading = "Background processing completed with limitations";
      body =
        pcLine("done", `Safe artifacts added: ${vm.safeArtifactsAdded}`) +
        pcLine("warn", `Still kept local: ${vm.keptLocal}`) +
        (vm.companionUnavailable > 0
          ? pcLine("warn", `${vm.companionUnavailable} warning-available file${vm.companionUnavailable === 1 ? " has" : "s have"} no verified companion`)
          : "") +
        pcButton(PROGRESSIVE_REFRESH_ID, "Refresh Context");
      break;
  }
  return (
    `<div class="pcard" role="group" aria-label="Background context">` +
    `<div class="pc-h">${esc(heading)}</div>` +
    body +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// Host-wiring — the controller (never blocks launch, never reads private state).
// ---------------------------------------------------------------------------

/** The injected core primitives — all path-safe / public-status only. */
export interface ProgressiveContextHost {
  /**
   * Start the local worker for a run (fire-and-forget by the caller). Wraps
   * `runBackgroundForRun`. The controller aborts it via the provided signal.
   */
  runBackground(input: { runId: string; preparedDir: string; signal: AbortSignal }): Promise<unknown>;
  /** Persistently request cancellation. Wraps `requestBackgroundCancel`. */
  cancelBackground(input: { runId: string; preparedDir: string }): Promise<void>;
  /** Read the PUBLIC status document ONLY. Wraps `readPublicStatus`. */
  readStatus(preparedDir: string): Promise<PublicBackgroundStatus | undefined>;
  /**
   * Recompute the {@link ProgressiveContextState} for the delivered set, keeping the
   * SAME baseContextId (which the revisionId folds in — no base-file hashes needed).
   * Wraps `reduceProgressiveContextState`. MUST NOT re-prepare.
   */
  computeRevision(input: {
    baseContextId: string;
    status: PublicBackgroundStatus;
  }): ProgressiveContextState;
  /** Persist the used revision into the session manifest (optional). */
  recordRevision?(preparedDir: string, state: ProgressiveContextState): Promise<void>;
  /** Push the current view (or `undefined` to clear) to the panel. */
  onView(view: ProgressiveContextViewModel | undefined): void;
}

export interface ProgressiveContextStartInput {
  runId: string;
  preparedDir: string;
  /** == report.contextId. IMMUTABLE — never recomputed by Refresh; folded into revisionId. */
  baseContextId: string;
  /** Count of base context files already available (display only). */
  filesAvailable: number;
  /**
   * Start the local worker (true in the prepared window that OWNS the run). When
   * false the controller only polls the public status to display progress.
   */
  startWorker?: boolean;
}

/**
 * Drives the Progressive Context panel surface from the PUBLIC status file. It never
 * blocks launch (the worker is fire-and-forget), never reads private state, and
 * always leaves the UI usable: Cancel is prompt and Refresh only re-reads + recomputes
 * (never re-prepares).
 */
export class ProgressiveContextController {
  private controller?: AbortController;
  private input?: ProgressiveContextStartInput;
  private lastStatus?: PublicBackgroundStatus;
  /** Set once Refresh recomputes it; overrides the status' own revision in the view. */
  private displayRevision?: number;
  private disposed = false;

  constructor(private readonly host: ProgressiveContextHost) {}

  /** The immutable base Context ID this controller is bound to (for assertions/tests). */
  get baseContextId(): string | undefined {
    return this.input?.baseContextId;
  }

  /**
   * Bind to a run and (optionally) start the local worker fire-and-forget. Returns
   * immediately — it NEVER awaits the worker, so launch is never blocked. An initial
   * status read restores whatever the public file already shows (survives reload).
   */
  start(input: ProgressiveContextStartInput): void {
    this.dispose(); // supersede any previous run
    this.disposed = false;
    this.input = input;
    this.displayRevision = undefined;
    if (input.startWorker) {
      const controller = new AbortController();
      this.controller = controller;
      // Fire-and-forget: a failure only leaves the last public status; the UI stays
      // usable. The worker is idempotent, so resuming after a reload is safe.
      void this.host
        .runBackground({ runId: input.runId, preparedDir: input.preparedDir, signal: controller.signal })
        .catch(() => {})
        .finally(() => {
          // A finished/aborted worker leaves a terminal public status; reflect it.
          if (!this.disposed) void this.refreshFromDisk();
        });
    }
    void this.refreshFromDisk();
  }

  /**
   * Re-read the PUBLIC status file and push a fresh view. Called on a poll tick and on
   * activation so the surface survives a window reload. Reads ONLY the public status.
   */
  async refreshFromDisk(): Promise<void> {
    if (!this.input || this.disposed) return;
    const status = await this.host.readStatus(this.input.preparedDir);
    this.lastStatus = status;
    this.emit();
  }

  /**
   * Cancel the background run: persist the cancel request (so any worker — this one or
   * one from a prior window — aborts and discards late results) AND abort the local
   * worker. The panel returns to a usable state (never stuck).
   */
  async cancel(): Promise<void> {
    if (!this.input) return;
    const { runId, preparedDir } = this.input;
    this.controller?.abort();
    try {
      await this.host.cancelBackground({ runId, preparedDir });
    } catch {
      // Cancel must never throw into the UI; the re-read below still recovers the panel.
    }
    await this.refreshFromDisk();
  }

  /**
   * Explicit Refresh Context: re-read the public status, recompute the revision with
   * the SAME baseContextId (NO re-scan, NO re-prepare), record it in the session
   * manifest, and update the displayed Context Revision. Returns the recomputed state
   * (or undefined when there is nothing to refresh).
   */
  async refresh(): Promise<ProgressiveContextState | undefined> {
    if (!this.input || this.disposed) return undefined;
    const status = await this.host.readStatus(this.input.preparedDir);
    this.lastStatus = status;
    if (!status) {
      this.emit();
      return undefined;
    }
    const state = this.host.computeRevision({
      baseContextId: this.input.baseContextId, // SAME id — never recomputed here.
      status,
    });
    this.displayRevision = state.revision;
    if (this.host.recordRevision) {
      try {
        await this.host.recordRevision(this.input.preparedDir, state);
      } catch {
        // Recording is best-effort; a failure must not break the panel.
      }
    }
    this.emit();
    return state;
  }

  /** True while the last read public status still has queued/in-flight work. */
  isRunning(): boolean {
    if (!this.lastStatus) return false;
    return this.lastStatus.counts.pending + this.lastStatus.counts.processing > 0;
  }

  /** The current view model (or undefined when there is no background work). */
  currentView(): ProgressiveContextViewModel | undefined {
    if (!hasBackgroundWork(this.lastStatus)) return undefined;
    return buildProgressiveContextView(this.lastStatus, {
      contextFilesReady: this.input?.filesAvailable ?? 0,
      ...(this.displayRevision !== undefined ? { revision: this.displayRevision } : {}),
    });
  }

  private emit(): void {
    if (this.disposed) return;
    this.host.onView(this.currentView());
  }

  /** Stop the worker + polling. Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    this.controller = undefined;
  }
}
