/**
 * Bounded, reliable background worker. It NEVER runs forever, even against a
 * hanging provider.
 *
 * Reliability design (a clean, worker-level re-implementation of the v0.3.3
 * local-model machinery in prepare-workspace.ts):
 *  - Injected clock + timer: every timeout / budget is measured on an injectable
 *    clock, so tests drive time with no real sleeps.
 *  - Per-item HARD timeout with AbortSignal propagation: a wedged provider is
 *    aborted; its late result is ignored (single-settle guard).
 *  - Global wall-time budget AND call-count budget: once either is spent, no
 *    further provider calls are made; remaining items are shed to `kept-local`.
 *  - Circuit breaker for the summarize-local (Ollama) path: the FIRST
 *    timeout-or-unavailable opens the circuit, and every remaining summarize
 *    item in the run goes straight to `kept-local` with ZERO further provider
 *    calls.
 *  - Per-kind concurrency limits (document-extraction 2, OCR 1, summarize 1).
 *  - One item's failure never stops the queue; cancellation is prompt; the queue
 *    terminates in bounded time.
 */
import { BackgroundQueue } from "./queue.js";
import type { BackgroundRecord } from "./state-store.js";
import { BackgroundPublisher, type RawExtraction } from "./publisher.js";
import {
  type BackgroundClock,
  type BackgroundPreparationItem,
  type BackgroundPreparationKind,
  type BackgroundPreparationStatus,
  type BackgroundReasonCode,
  type PublicBackgroundItem,
} from "./types.js";

/** The heavy work for one item (extract / OCR / summarize). Injected. */
export interface BackgroundProcessor {
  run(item: BackgroundPreparationItem, signal: AbortSignal): Promise<RawExtraction>;
}

export type ProcessorMap = Partial<Record<BackgroundPreparationKind, BackgroundProcessor>>;

/**
 * Throw this from a summarize-local processor to signal the provider is down.
 * The FIRST such signal (or the first timeout) opens the circuit for the run.
 */
export class ProviderUnavailableError extends Error {
  readonly code = "provider-unavailable";
  constructor(message = "provider unavailable") {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/**
 * Throw from a processor to signal a SAFE keep-local outcome (not a failure): the
 * item published nothing on purpose — e.g. document-extraction recovered too little
 * text and handed off to a dependent OCR item. Carries the privacy-safe reason code.
 */
export class KeepLocalError extends Error {
  constructor(readonly reasonCode: BackgroundReasonCode, message = "kept local") {
    super(message);
    this.name = "KeepLocalError";
  }
}

function isUnavailable(error: unknown): boolean {
  return (
    error instanceof ProviderUnavailableError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "provider-unavailable")
  );
}

/** Minimal persisted-cancel view the worker consults while running. */
export interface CancelSource {
  /** True when this item (or the whole run) has been cancelled durably. */
  isCancelled(itemId: string): boolean;
}

export interface WorkerConfig {
  concurrency: Record<BackgroundPreparationKind, number>;
  /** Hard per-item timeout (ms). */
  perItemTimeoutMs: number;
  /** Cumulative wall-time budget for the whole run (ms). */
  totalBudgetMs: number;
  /** Maximum number of provider calls the run may start. */
  maxCalls: number;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  concurrency: {
    "document-extraction": 2,
    ocr: 1,
    "summarize-local": 1,
  },
  perItemTimeoutMs: 10_000,
  totalBudgetMs: 60_000,
  maxCalls: 50,
};

export interface WorkerDeps {
  queue: BackgroundQueue;
  clock: BackgroundClock;
  processors: ProcessorMap;
  publisher: BackgroundPublisher;
  config?: Partial<WorkerConfig>;
  /** Persisted cancellation the worker checks between and around provider calls. */
  cancelStore?: CancelSource;
  /** Called after each item reaches a terminal state (used to rewrite public status). */
  onSettled?: () => void | Promise<void>;
}

export interface RunOptions {
  /** Restrict processing to one run. */
  runId?: string;
  /** Cooperative cancellation for the whole batch. */
  signal?: AbortSignal;
  /** Per-run config overrides. */
  config?: Partial<WorkerConfig>;
}

export interface RunSummary {
  results: PublicBackgroundItem[];
  callsMade: number;
  summarizeCircuitOpened: boolean;
}

type DeadlineOutcome<T> =
  | { kind: "ok"; value: T; elapsedMs: number }
  | { kind: "timeout"; elapsedMs: number }
  | { kind: "error"; error: unknown; elapsedMs: number }
  | { kind: "aborted"; elapsedMs: number };

/**
 * Run `work` under a hard timeout on the injected clock. Resolves exactly once.
 * A parent-abort resolves `aborted`; a fired timeout aborts the work's signal
 * and resolves `timeout`; a late resolution after either is ignored.
 */
function runWithDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  clock: BackgroundClock,
  parentSignal: AbortSignal | undefined,
): Promise<DeadlineOutcome<T>> {
  const controller = new AbortController();
  const start = clock.now();
  const elapsed = (): number => Math.max(0, clock.now() - start);
  return new Promise<DeadlineOutcome<T>>((resolve) => {
    let settled = false;
    let cancelTimer: () => void = () => {};
    let onAbort: (() => void) | undefined;
    const cleanup = (): void => {
      cancelTimer();
      if (onAbort && parentSignal) parentSignal.removeEventListener("abort", onAbort);
    };
    const finish = (outcome: DeadlineOutcome<T>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    onAbort = () => {
      controller.abort();
      finish({ kind: "aborted", elapsedMs: elapsed() });
    };
    if (parentSignal?.aborted) {
      controller.abort();
      finish({ kind: "aborted", elapsedMs: 0 });
      return;
    }
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    cancelTimer = clock.setTimer(() => {
      controller.abort();
      finish({ kind: "timeout", elapsedMs: elapsed() });
    }, ms);
    Promise.resolve()
      .then(() => work(controller.signal))
      .then(
        (value) => finish({ kind: "ok", value, elapsedMs: elapsed() }),
        (error) => {
          if ((error as { name?: unknown })?.name === "AbortError") {
            finish({ kind: "aborted", elapsedMs: elapsed() });
          } else {
            finish({ kind: "error", error, elapsedMs: elapsed() });
          }
        },
      );
  });
}

export class BackgroundWorker {
  private readonly queue: BackgroundQueue;
  private readonly clock: BackgroundClock;
  private readonly processors: ProcessorMap;
  private readonly publisher: BackgroundPublisher;
  private readonly baseConfig: WorkerConfig;
  private readonly cancelStore: CancelSource | undefined;
  private readonly onSettled: (() => void | Promise<void>) | undefined;

  constructor(deps: WorkerDeps) {
    this.queue = deps.queue;
    this.clock = deps.clock;
    this.processors = deps.processors;
    this.publisher = deps.publisher;
    this.baseConfig = mergeConfig(DEFAULT_WORKER_CONFIG, deps.config);
    this.cancelStore = deps.cancelStore;
    this.onSettled = deps.onSettled;
  }

  /** True when a durable cancel (item-level or run-level) applies to this item. */
  private cancelled(itemId: string): boolean {
    return this.cancelStore?.isCancelled(itemId) === true;
  }

  /** Fire the settle hook (rewrite public status) — best-effort, never throws. */
  private async settled(): Promise<void> {
    try {
      await this.onSettled?.();
    } catch {
      /* status write is best-effort */
    }
  }

  /**
   * Drain the pending queue under all reliability bounds. Resolves when every
   * item has reached a terminal state (or been shed / cancelled). Never throws
   * for a single item's failure.
   */
  async run(options: RunOptions = {}): Promise<RunSummary> {
    const config = mergeConfig(this.baseConfig, options.config);
    const store = this.queue.stateStore;
    const runId = options.runId;
    const parentSignal = options.signal;
    const start = this.clock.now();

    const active: Record<BackgroundPreparationKind, number> = {
      "document-extraction": 0,
      ocr: 0,
      "summarize-local": 0,
    };
    const inFlight = new Set<Promise<void>>();
    let callsMade = 0;
    let summarizeCircuitOpen = false;

    const budgetExceeded = (): boolean =>
      this.clock.now() - start >= config.totalBudgetMs || callsMade >= config.maxCalls;

    while (true) {
      if (parentSignal?.aborted) break;

      const pending = store.pending(runId);
      if (pending.length === 0 && inFlight.size === 0) break;

      let progressed = false;
      for (const record of pending) {
        const kind = record.item.kind;

        // Durable cancel for this specific pending item → mark cancelled, no call.
        if (this.cancelled(record.item.itemId)) {
          await store.update(record.item.itemId, {
            status: "cancelled",
            reasonCode: "background-cancelled",
            elapsedMs: 0,
          });
          await this.settled();
          progressed = true;
          continue;
        }

        // Budget spent → shed remaining work to kept-local, no provider call.
        if (budgetExceeded()) {
          await this.shed(record);
          progressed = true;
          continue;
        }
        // Circuit open → summarize items skip the provider entirely.
        if (kind === "summarize-local" && summarizeCircuitOpen) {
          await this.shed(record);
          progressed = true;
          continue;
        }
        // Concurrency gate for this kind.
        const limit = Math.max(1, config.concurrency[kind] ?? 1);
        if (active[kind] >= limit) continue;

        // Reserve + persist "processing" BEFORE launching (crash-safe: recovery
        // resets a mid-flight "processing" back to "pending").
        await store.update(record.item.itemId, {
          status: "processing",
          reasonCode: "background-processing",
        });
        active[kind] += 1;
        callsMade += 1;
        progressed = true;

        const task = (async () => {
          const { openedCircuit } = await this.execute(record, config, parentSignal);
          active[kind] -= 1;
          if (openedCircuit) summarizeCircuitOpen = true;
        })();
        const tracked = task.finally(() => {
          inFlight.delete(tracked);
        });
        inFlight.add(tracked);
      }

      if (inFlight.size > 0) {
        await Promise.race([...inFlight]);
      } else if (!progressed) {
        // Nothing running and nothing could be started this pass — terminate to
        // guarantee bounded completion (e.g. a misconfigured zero concurrency).
        break;
      }
    }

    // Cancellation: mark remaining pending as cancelled and let in-flight settle.
    // These items are still `pending` (never reserved), so write directly rather
    // than via finalize() (which only overwrites a `processing` item).
    if (parentSignal?.aborted) {
      for (const record of store.pending(runId)) {
        await store.update(record.item.itemId, {
          status: "cancelled",
          reasonCode: "background-cancelled",
          elapsedMs: 0,
        });
      }
    }
    await Promise.allSettled([...inFlight]);

    return {
      results: store.publicProjection(runId),
      callsMade,
      summarizeCircuitOpened: summarizeCircuitOpen,
    };
  }

  /** Process one reserved item end-to-end. Never throws. */
  private async execute(
    record: BackgroundRecord,
    config: WorkerConfig,
    parentSignal: AbortSignal | undefined,
  ): Promise<{ openedCircuit: boolean }> {
    const item = record.item;
    const kind = item.kind;
    const isSummarize = kind === "summarize-local";
    try {
      const processor = this.processors[kind];
      if (!processor) {
        // No processor wired for this kind → keep local; unavailable summarize
        // opens the circuit so we don't retry a missing provider.
        await this.finalize(record, "kept-local", "background-provider-unavailable", 0);
        return { openedCircuit: isSummarize };
      }

      const outcome = await runWithDeadline(
        (signal) => processor.run(item, signal),
        config.perItemTimeoutMs,
        this.clock,
        parentSignal,
      );

      switch (outcome.kind) {
        case "aborted":
          await this.finalize(record, "cancelled", "background-cancelled", outcome.elapsedMs);
          return { openedCircuit: false };

        case "timeout":
          await this.finalize(record, "timed-out", "background-timeout", outcome.elapsedMs);
          return { openedCircuit: isSummarize };

        case "error": {
          // A processor's explicit keep-local signal (e.g. document-extraction handed
          // off to OCR) is NOT a failure — publish nothing, record the safe reason.
          if (outcome.error instanceof KeepLocalError) {
            await this.finalize(record, "kept-local", outcome.error.reasonCode, outcome.elapsedMs);
            return { openedCircuit: false };
          }
          if (isSummarize && isUnavailable(outcome.error)) {
            await this.finalize(
              record,
              "kept-local",
              "background-provider-unavailable",
              outcome.elapsedMs,
            );
            return { openedCircuit: true };
          }
          // A non-summarize provider outage (e.g. OCR unavailable) is a SAFE keep-local
          // with a distinct reason — never a hard failure.
          if (isUnavailable(outcome.error)) {
            const reason: BackgroundReasonCode =
              kind === "ocr" ? "background-ocr-unavailable" : "background-provider-unavailable";
            await this.finalize(record, "kept-local", reason, outcome.elapsedMs);
            return { openedCircuit: false };
          }
          await this.finalize(
            record,
            "failed",
            "background-extraction-failed",
            outcome.elapsedMs,
          );
          return { openedCircuit: false };
        }

        case "ok": {
          // A cancel that landed WHILE the provider ran → discard the result. The late
          // value is never published; the item is recorded cancelled.
          if (this.cancelled(item.itemId)) {
            await this.finalize(record, "cancelled", "background-cancelled", outcome.elapsedMs);
            return { openedCircuit: false };
          }
          const published = await this.publisher.publish(item, outcome.value);
          if (published.status === "published") {
            await this.finalize(
              record,
              "completed",
              "background-completed",
              outcome.elapsedMs,
              published.preparedRelpath,
            );
          } else if (published.status === "rejected") {
            await this.finalize(record, "kept-local", published.reasonCode, outcome.elapsedMs);
          } else {
            await this.finalize(record, "failed", published.reasonCode, outcome.elapsedMs);
          }
          return { openedCircuit: false };
        }
      }
    } catch {
      // Absolute backstop: an unexpected throw must never stop the queue.
      await this.finalize(record, "failed", "background-extraction-failed", 0);
      return { openedCircuit: false };
    }
    return { openedCircuit: false };
  }

  /** Shed a still-pending item to kept-local (budget/circuit), no provider call. */
  private async shed(record: BackgroundRecord): Promise<void> {
    await this.queue.stateStore.update(record.item.itemId, {
      status: "kept-local",
      reasonCode: "background-provider-unavailable",
      elapsedMs: 0,
    });
    await this.settled();
  }

  /**
   * Write a terminal outcome, but ONLY if the item is still `processing`. If it
   * was cancelled (or otherwise moved terminal) out from under us, the late
   * result is ignored — cancellation wins.
   */
  private async finalize(
    record: BackgroundRecord,
    status: BackgroundPreparationStatus,
    reasonCode: BackgroundReasonCode,
    elapsedMs: number,
    preparedRelpath?: string,
  ): Promise<void> {
    const current = this.queue.stateStore.get(record.item.itemId);
    if (current && current.status !== "processing") return;
    await this.queue.stateStore.update(record.item.itemId, {
      status,
      reasonCode,
      elapsedMs,
      preparedRelpath,
    });
    await this.settled();
  }
}

function mergeConfig(base: WorkerConfig, patch?: Partial<WorkerConfig>): WorkerConfig {
  if (!patch) return base;
  return {
    concurrency: { ...base.concurrency, ...patch.concurrency },
    perItemTimeoutMs: patch.perItemTimeoutMs ?? base.perItemTimeoutMs,
    totalBudgetMs: patch.totalBudgetMs ?? base.totalBudgetMs,
    maxCalls: patch.maxCalls ?? base.maxCalls,
  };
}
