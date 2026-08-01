/**
 * Thin queue facade over the persistent state store: enqueue, dedup, status
 * queries, cancel, retry. The heavy lifting (bounded reliable processing) lives
 * in {@link BackgroundWorker}; this file is the durable book-keeping surface the
 * worker and the public API build on.
 */
import {
  BackgroundStateStore,
  type BackgroundRecord,
  type EnqueueOutcome,
} from "./state-store.js";
import {
  type BackgroundClock,
  type BackgroundPreparationResult,
  type EnqueueInput,
  type PublicBackgroundItem,
  defaultReasonForStatus,
  systemBackgroundClock,
} from "./types.js";

export class BackgroundQueue {
  private constructor(private readonly store: BackgroundStateStore) {}

  static async open(
    baseDir: string,
    clock: BackgroundClock = systemBackgroundClock,
  ): Promise<BackgroundQueue> {
    return new BackgroundQueue(await BackgroundStateStore.load(baseDir, clock));
  }

  /** Direct access to the underlying store (used by the worker). */
  get stateStore(): BackgroundStateStore {
    return this.store;
  }

  /** Enqueue work (dedup-aware). */
  async enqueue(input: EnqueueInput): Promise<EnqueueOutcome> {
    return this.store.enqueue(input);
  }

  /** Public, path-safe status of one item. */
  status(itemId: string): PublicBackgroundItem | undefined {
    const record = this.store.get(itemId);
    return record ? this.store.projectItem(record) : undefined;
  }

  /** Public, path-safe result of one item (or `undefined` if unknown). */
  result(itemId: string): BackgroundPreparationResult | undefined {
    const record = this.store.get(itemId);
    if (!record) return undefined;
    return {
      itemId: record.item.itemId,
      status: record.status,
      preparedRelpath: record.preparedRelpath,
      reasonCode: record.reasonCode ?? defaultReasonForStatus(record.status),
      elapsedMs: record.elapsedMs,
    };
  }

  /** All items (optionally scoped to a run), public-safe. */
  list(runId?: string): PublicBackgroundItem[] {
    return this.store.publicProjection(runId);
  }

  /**
   * Cancel a still-live item (pending/processing). Already-terminal items are
   * left unchanged. An in-flight item is aborted by the worker via its signal;
   * here we mark the durable state so a never-started item won't run.
   */
  async cancel(itemId: string): Promise<PublicBackgroundItem | undefined> {
    const record = this.store.get(itemId);
    if (!record) return undefined;
    if (record.status === "pending" || record.status === "processing") {
      const updated = await this.store.update(itemId, {
        status: "cancelled",
        reasonCode: "background-cancelled",
      });
      return updated ? this.store.projectItem(updated) : undefined;
    }
    return this.store.projectItem(record);
  }

  /**
   * Retry a terminal item by resetting it to pending. Only meaningful for
   * non-completed outcomes (failed / timed-out / cancelled / kept-local); a
   * completed item is returned unchanged (its result is already published).
   */
  async retry(itemId: string): Promise<PublicBackgroundItem | undefined> {
    const record = this.store.get(itemId);
    if (!record) return undefined;
    if (record.status === "completed") return this.store.projectItem(record);
    const updated = await this.store.update(itemId, {
      status: "pending",
      reasonCode: "background-pending",
      preparedRelpath: undefined,
      elapsedMs: 0,
    });
    return updated ? this.store.projectItem(updated) : undefined;
  }

  /**
   * Re-queue terminal items in bulk, keeping each item's SAME itemId + idempotency
   * key (never a duplicate). `completed` items are never retried. When
   * `failedOnly` is true, only `failed` / `timed-out` items are re-queued; otherwise
   * all non-completed terminal items (also `cancelled` / `kept-local`) are. Returns
   * the public projection of the items that were moved back to `pending`.
   */
  async retryTerminal(
    options: { failedOnly?: boolean; runId?: string } = {},
  ): Promise<PublicBackgroundItem[]> {
    const retryable = new Set<string>(
      options.failedOnly
        ? ["failed", "timed-out"]
        : ["failed", "timed-out", "cancelled", "kept-local"],
    );
    const requeued: PublicBackgroundItem[] = [];
    for (const record of this.store.all()) {
      if (options.runId !== undefined && record.item.runId !== options.runId) continue;
      if (!retryable.has(record.status)) continue; // completed / pending / processing skipped
      const updated = await this.store.update(record.item.itemId, {
        status: "pending",
        reasonCode: "background-pending",
        preparedRelpath: undefined,
        elapsedMs: 0,
      });
      if (updated) requeued.push(this.store.projectItem(updated));
    }
    return requeued;
  }

  /** Records still needing processing (priority-ordered). */
  pending(runId?: string): BackgroundRecord[] {
    return this.store.pending(runId);
  }
}
