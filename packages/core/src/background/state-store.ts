/**
 * Persistent, crash-safe state store for the BackgroundPreparationQueue.
 *
 * Layout (under a prepared run's private `.yuhi/` tree, which is excluded from
 * the agent-visible workspace):
 *
 *   <baseDir>/                     e.g. <prepared-run>/.yuhi/background
 *     items/<itemId>.json          one atomic file per item (internal record)
 *
 * Design choices:
 *  - Per-item files (not one big queue.json) so a single corrupt file only ever
 *    affects ONE item — the rest of the queue recovers cleanly.
 *  - Atomic writes: write a temp file, fsync-free rename over the target. A crash
 *    mid-write leaves either the old file or the temp file, never a torn target.
 *  - Restart recovery: on load, any item left `processing` (a crash mid-run) is
 *    reset to `pending`; `pending` items are reloaded as-is.
 *  - Idempotency: a key derived from {contextId, relpath, sourceContentHash,
 *    kind, processorVersion, policyHash}. A completed item is never re-run, and
 *    an enqueue whose key matches a live/completed record dedupes to it.
 *  - Corruption safety: an unparseable item file is surfaced as a synthetic
 *    `kept-local` record with reason `background-state-corrupt`. Loading NEVER
 *    throws.
 *
 * Absolute paths appear only in the internal on-disk record and in-memory state.
 * {@link BackgroundStateStore.projectItem} / {@link BackgroundStateStore.publicProjection}
 * strip them for any public consumer.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  type BackgroundClock,
  type BackgroundPreparationItem,
  type BackgroundPreparationStatus,
  type BackgroundReasonCode,
  type EnqueueInput,
  type IdempotencyInputs,
  type PublicBackgroundItem,
  defaultReasonForStatus,
  systemBackgroundClock,
} from "./types.js";

/** Internal, on-disk record. May contain absolute paths (INTERNAL ONLY). */
export interface BackgroundRecord {
  item: BackgroundPreparationItem;
  idempotencyKey: string;
  idempotency: IdempotencyInputs;
  status: BackgroundPreparationStatus;
  reasonCode?: BackgroundReasonCode;
  /** Repo-relative path of the published artifact, when published (public-safe). */
  preparedRelpath?: string;
  elapsedMs: number;
  /** Schema marker so future migrations can detect old files. */
  schema: 1;
}

/** Result of an enqueue: the live record and whether it deduped to an existing one. */
export interface EnqueueOutcome {
  record: BackgroundRecord;
  deduped: boolean;
}

const STORE_SCHEMA = 1 as const;

/** Compute the stable idempotency key for a piece of work. */
export function idempotencyKey(
  contextId: string,
  relpath: string,
  kind: string,
  inputs: IdempotencyInputs,
): string {
  const material = JSON.stringify([
    contextId,
    relpath,
    inputs.sourceContentHash,
    kind,
    inputs.processorVersion,
    inputs.policyHash,
  ]);
  return createHash("sha256").update(material).digest("hex");
}

/** A short, filesystem-safe id derived from a seed (used when itemId is omitted). */
function deriveItemId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

/** Statuses that represent "still live" work an incoming duplicate should dedupe to. */
const LIVE_STATUSES: ReadonlySet<BackgroundPreparationStatus> = new Set([
  "pending",
  "processing",
  "completed",
]);

export class BackgroundStateStore {
  private readonly itemsDir: string;
  private readonly clock: BackgroundClock;
  private readonly records = new Map<string, BackgroundRecord>();
  private readonly byKey = new Map<string, string>();

  private constructor(baseDir: string, clock: BackgroundClock) {
    this.itemsDir = path.join(baseDir, "items");
    this.clock = clock;
  }

  /**
   * Open (creating if needed) the store at `baseDir`, load existing records,
   * and perform restart recovery: `processing` → `pending`; corrupt files →
   * synthetic `kept-local` (reason `background-state-corrupt`). Never throws on
   * corrupt state.
   */
  static async load(
    baseDir: string,
    clock: BackgroundClock = systemBackgroundClock,
  ): Promise<BackgroundStateStore> {
    const store = new BackgroundStateStore(baseDir, clock);
    await fs.mkdir(store.itemsDir, { recursive: true });
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(store.itemsDir)).filter((f) => f.endsWith(".json"));
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const full = path.join(store.itemsDir, entry);
      const itemId = entry.slice(0, -".json".length);
      let record: BackgroundRecord | undefined;
      try {
        const raw = await fs.readFile(full, "utf8");
        record = normalizeRecord(JSON.parse(raw) as unknown, itemId);
      } catch {
        record = undefined;
      }
      if (!record) {
        // Corrupt/unparseable: fall back SAFELY. Treat as kept-local so the
        // original is never shared and the queue never throws on startup.
        record = {
          item: {
            itemId,
            runId: "",
            contextId: "",
            relpath: "",
            kind: "document-extraction",
            sourceArtifactPath: "",
            priority: 0,
            createdAt: clock.now(),
          },
          idempotencyKey: `corrupt:${itemId}`,
          idempotency: { sourceContentHash: "", processorVersion: "", policyHash: "" },
          status: "kept-local",
          reasonCode: "background-state-corrupt",
          elapsedMs: 0,
          schema: STORE_SCHEMA,
        };
        // Overwrite the corrupt file with the safe fallback so recovery is stable.
        try {
          await store.persist(record);
        } catch {
          /* best-effort: the in-memory fallback still governs behavior */
        }
      } else if (record.status === "processing") {
        // A crash left this mid-flight — reset so it is retried, not lost.
        record.status = "pending";
        record.reasonCode = "background-pending";
        try {
          await store.persist(record);
        } catch {
          /* best-effort */
        }
      }
      store.index(record);
    }
    return store;
  }

  private index(record: BackgroundRecord): void {
    this.records.set(record.item.itemId, record);
    // The first live/completed record wins the key; corrupt records don't claim keys.
    if (record.reasonCode !== "background-state-corrupt") {
      const existing = this.byKey.get(record.idempotencyKey);
      if (!existing || !this.records.has(existing)) {
        this.byKey.set(record.idempotencyKey, record.item.itemId);
      }
    }
  }

  /**
   * Enqueue a piece of work. If a record with the same idempotency key already
   * exists in a live/completed state, dedupe to it (no new item, no re-run).
   */
  async enqueue(input: EnqueueInput): Promise<EnqueueOutcome> {
    const inputs: IdempotencyInputs = {
      sourceContentHash: input.sourceContentHash,
      processorVersion: input.processorVersion,
      policyHash: input.policyHash,
    };
    const key = idempotencyKey(input.contextId, input.relpath, input.kind, inputs);

    const existingId = this.byKey.get(key);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing && LIVE_STATUSES.has(existing.status)) {
        return { record: existing, deduped: true };
      }
    }

    const itemId = input.itemId ?? deriveItemId(key);
    const record: BackgroundRecord = {
      item: {
        itemId,
        runId: input.runId,
        contextId: input.contextId,
        relpath: input.relpath,
        ...(input.publicRelpath ? { publicRelpath: input.publicRelpath } : {}),
        ...(input.documentId ? { documentId: input.documentId } : {}),
        kind: input.kind,
        sourceArtifactPath: input.sourceArtifactPath,
        priority: input.priority ?? 0,
        createdAt: input.createdAt ?? this.clock.now(),
        ...(input.originalSharedWithWarning ? { originalSharedWithWarning: true } : {}),
      },
      idempotencyKey: key,
      idempotency: inputs,
      status: "pending",
      reasonCode: "background-pending",
      elapsedMs: 0,
      schema: STORE_SCHEMA,
    };
    this.index(record);
    await this.persist(record);
    return { record, deduped: false };
  }

  /** Atomically update an item's status/outcome and persist it. */
  async update(
    itemId: string,
    patch: Partial<Pick<BackgroundRecord, "status" | "reasonCode" | "preparedRelpath" | "elapsedMs">>,
  ): Promise<BackgroundRecord | undefined> {
    const record = this.records.get(itemId);
    if (!record) return undefined;
    if (patch.status !== undefined) record.status = patch.status;
    if (patch.reasonCode !== undefined) record.reasonCode = patch.reasonCode;
    if (patch.preparedRelpath !== undefined) record.preparedRelpath = patch.preparedRelpath;
    if (patch.elapsedMs !== undefined) record.elapsedMs = patch.elapsedMs;
    await this.persist(record);
    return record;
  }

  get(itemId: string): BackgroundRecord | undefined {
    return this.records.get(itemId);
  }

  all(): BackgroundRecord[] {
    return [...this.records.values()];
  }

  /** Pending items for a run (all runs when `runId` omitted), priority-ordered. */
  pending(runId?: string): BackgroundRecord[] {
    return this.all()
      .filter((r) => r.status === "pending" && (runId === undefined || r.item.runId === runId))
      .sort(
        (a, b) => b.item.priority - a.item.priority || a.item.createdAt - b.item.createdAt,
      );
  }

  /** Public, path-safe projection of one record. Never includes absolute paths. */
  projectItem(record: BackgroundRecord): PublicBackgroundItem {
    return {
      itemId: record.item.itemId,
      runId: record.item.runId,
      contextId: record.item.contextId,
      relpath: record.item.relpath,
      ...(record.item.publicRelpath ? { publicRelpath: record.item.publicRelpath } : {}),
      ...(record.item.documentId ? { documentId: record.item.documentId } : {}),
      kind: record.item.kind,
      priority: record.item.priority,
      createdAt: record.item.createdAt,
      status: record.status,
      reasonCode: record.reasonCode ?? defaultReasonForStatus(record.status),
      preparedRelpath: record.preparedRelpath,
      ...(record.item.originalSharedWithWarning ? { originalSharedWithWarning: true } : {}),
    };
  }

  /** Public, path-safe projection of the whole store (optionally one run). */
  publicProjection(runId?: string): PublicBackgroundItem[] {
    return this.all()
      .filter((r) => runId === undefined || r.item.runId === runId)
      .map((r) => this.projectItem(r));
  }

  /** Atomic per-item persist: write temp + rename. */
  private async persist(record: BackgroundRecord): Promise<void> {
    const target = path.join(this.itemsDir, `${record.item.itemId}.json`);
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.mkdir(this.itemsDir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await fs.rename(tmp, target);
  }
}

/**
 * Validate + normalize a parsed JSON blob into a record. Returns `undefined`
 * when the shape is not a usable record (caller treats that as corruption).
 */
function normalizeRecord(value: unknown, itemId: string): BackgroundRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const item = v.item as Record<string, unknown> | undefined;
  const idem = v.idempotency as Record<string, unknown> | undefined;
  if (!item || typeof item !== "object") return undefined;
  if (typeof item.relpath !== "string" || typeof item.kind !== "string") return undefined;
  if (typeof v.idempotencyKey !== "string") return undefined;
  if (typeof v.status !== "string") return undefined;
  return {
    item: {
      itemId: typeof item.itemId === "string" ? item.itemId : itemId,
      runId: typeof item.runId === "string" ? item.runId : "",
      contextId: typeof item.contextId === "string" ? item.contextId : "",
      relpath: item.relpath,
      // Reloaded after a restart the metadata boundary still has to hold: without
      // `publicRelpath` the item is treated as having no agent-facing path, which is
      // the safe direction (public surfaces fall back to `documentId`).
      ...(typeof item.publicRelpath === "string" ? { publicRelpath: item.publicRelpath } : {}),
      ...(typeof item.documentId === "string" ? { documentId: item.documentId } : {}),
      kind: item.kind as BackgroundPreparationItem["kind"],
      sourceArtifactPath:
        typeof item.sourceArtifactPath === "string" ? item.sourceArtifactPath : "",
      priority: typeof item.priority === "number" ? item.priority : 0,
      createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
      ...(item.originalSharedWithWarning === true ? { originalSharedWithWarning: true } : {}),
    },
    idempotencyKey: v.idempotencyKey,
    idempotency: {
      sourceContentHash: typeof idem?.sourceContentHash === "string" ? idem.sourceContentHash : "",
      processorVersion: typeof idem?.processorVersion === "string" ? idem.processorVersion : "",
      policyHash: typeof idem?.policyHash === "string" ? idem.policyHash : "",
    },
    status: v.status as BackgroundPreparationStatus,
    reasonCode: typeof v.reasonCode === "string" ? (v.reasonCode as BackgroundReasonCode) : undefined,
    preparedRelpath: typeof v.preparedRelpath === "string" ? v.preparedRelpath : undefined,
    elapsedMs: typeof v.elapsedMs === "number" ? v.elapsedMs : 0,
    schema: STORE_SCHEMA,
  };
}
