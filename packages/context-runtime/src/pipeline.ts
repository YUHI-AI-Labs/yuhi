/**
 * Yuhi Runtime — the only path between an AI agent and a repository (spec §11).
 *
 * Claude thinks `Read`. Yuhi executes: Read → safety → compression → exact-output
 * rescan → evidence → Claude. The same for Bash, Test, Grep, Glob and MCP. The agent
 * never receives original bytes; it receives a view plus opaque ids, and can ask for
 * any withheld region back through `retrieve()`.
 *
 * Failure policy — the distinction that matters:
 *  - Nothing to compress (every compressor honestly reports `no-reduction`) ⇒ deliver
 *    the SCANNED ORIGINAL. It already passed the safety pipeline; inflating a view to
 *    look busy would violate §18.
 *  - Error, timeout, cancellation, or a failed exact-output scan ⇒ `withheld`. Never a
 *    raw fallback: at this point the bytes are not known to be safe.
 */

import { createHash } from "node:crypto";

import {
  compressWithFallback,
  defaultCompressContext,
  type CompressContext,
  type CompressionOutcome,
  type Compressor,
  type Omission,
} from "@yuhi/context-compression";
import {
  ContextStoreError,
  type ContentKind,
  type ContextStore,
  type ObjectId,
  type SessionId,
} from "@yuhi/context-store";
import type { DetectorOptions } from "@yuhi/scanner";

import {
  contextEventId,
  publicMetadataOf,
  type ContextEvent,
  type ContextEventId,
  type PrivateMetadata,
  type PublicMetadata,
  type ToolName,
} from "./event.js";
import {
  EvidenceLedger,
  toLedgerOmissions,
  type EvidenceRecord,
  type Explanation,
  type RetrievalRecord,
} from "./ledger.js";
import { DEFAULT_DETECTOR_OPTIONS, exactOutputScan, scanAndRedact, scanMetadata } from "./safety.js";

export interface DeliverRequest {
  readonly sessionId: SessionId;
  readonly tool: ToolName;
  readonly kind: ContentKind;
  /** Raw tool output. Goes straight into the private store; never delivered as-is. */
  readonly content: string;
  readonly privateMetadata: PrivateMetadata;
  readonly tokenBudget?: number;
}

export type Delivery =
  | {
      readonly status: "delivered";
      readonly eventId: ContextEventId;
      /** The bytes the agent may see. Already scanned twice. */
      readonly text: string;
      readonly publicMetadata: PublicMetadata;
      readonly strategy: string;
      readonly retrievable: readonly { readonly locator: string; readonly kind: string; readonly items?: number }[];
      readonly tokensBefore: number;
      readonly tokensAfter: number;
    }
  | {
      readonly status: "withheld";
      readonly eventId: ContextEventId;
      readonly reason: string;
      readonly publicMetadata: PublicMetadata;
    };

export interface RetrieveRequest {
  readonly sessionId: SessionId;
  readonly eventId: ContextEventId;
  /** Must be a locator the ledger already recorded for this event. */
  readonly locator: string;
}

export type Retrieval =
  | { readonly status: "delivered"; readonly text: string; readonly locator: string; readonly tokens: number }
  | { readonly status: "withheld"; readonly reason: string; readonly locator: string };

export interface ContextRuntimeOptions {
  readonly store: ContextStore;
  readonly now?: () => string;
  readonly timeoutMs?: number;
  readonly detectorOptions?: DetectorOptions;
  readonly compressors?: readonly Compressor[];
  readonly tokenBudget?: number;
}

interface DeliveredBytes {
  readonly text: string;
  readonly hash: string;
  readonly strategy: string;
}

export class ContextRuntime {
  private readonly store: ContextStore;
  private readonly ledger: EvidenceLedger;
  private readonly now: () => string;
  private readonly detectorOptions: DetectorOptions;
  private readonly compressors: readonly Compressor[] | undefined;
  private readonly ctx: CompressContext;
  private readonly tokenBudget: number | undefined;
  private readonly seqs = new Map<string, number>();
  /**
   * Prefix stability (architecture §2): the bytes delivered for a given
   * (objectId, revision) must never change within a session. Re-emitting a changed
   * prefix invalidates the provider KV cache and can raise billed cost while lowering
   * raw token counts — the failure mode the competition review flagged as highest risk.
   */
  private readonly delivered = new Map<string, DeliveredBytes>();

  constructor(opts: ContextRuntimeOptions) {
    this.store = opts.store;
    this.ledger = new EvidenceLedger(opts.store);
    this.now = opts.now ?? (() => new Date().toISOString());
    this.detectorOptions = opts.detectorOptions ?? DEFAULT_DETECTOR_OPTIONS;
    this.compressors = opts.compressors;
    this.tokenBudget = opts.tokenBudget;
    this.ctx = defaultCompressContext({
      now: this.now,
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
  }

  /** True when these bytes were already delivered and are pinned for reuse. */
  stableFor(objectId: ObjectId, revision: number): boolean {
    return this.delivered.has(`${objectId}#${revision}`);
  }

  async deliver(req: DeliverRequest): Promise<Delivery> {
    const stored = await this.store.put(req.sessionId, req.content, req.kind);
    const publicMetadata = publicMetadataOf(stored, req.content);
    const seq = await this.nextSeq(req.sessionId);
    const eventId = contextEventId({
      sessionId: req.sessionId,
      seq,
      tool: req.tool,
      rawSha256: stored.sha256,
    });
    const event: ContextEvent = {
      id: eventId,
      sessionId: req.sessionId,
      seq,
      tool: req.tool,
      kind: req.kind,
      rawContent: stored,
      privateMetadata: req.privateMetadata,
      publicMetadata,
      timestamp: this.now(),
    };

    // 1-3. Secret scan → PII scan → metadata scan, before anything is compressed.
    const scan = scanAndRedact(req.content, this.detectorOptions);
    const metadata = scanMetadata(scan.text, req.privateMetadata);
    const safeContent = metadata.text;

    // 4. Compression, over the already-safe text so the view carries placeholders.
    const budget = req.tokenBudget ?? this.tokenBudget;
    let outcome: CompressionOutcome;
    try {
      outcome = await compressWithFallback(
        {
          objectId: stored.objectId,
          revision: stored.revision,
          kind: req.kind,
          content: safeContent,
          ...(budget === undefined ? {} : { tokenBudget: budget }),
        },
        this.ctx,
        this.compressors,
      );
    } catch {
      return this.withhold(event, scan, metadata, "compression-error");
    }

    let candidate: string;
    let strategy: string;
    let anchors: readonly string[] = [];
    let omissions: readonly Omission[] = [];
    let removed: EvidenceRecord["removed"] = [];
    let tokensBefore = this.ctx.estimateTokens(req.content);
    let tokensAfter = tokensBefore;

    if (outcome.status === "compressed") {
      candidate = outcome.result.text;
      strategy = `${outcome.result.compressorId}@${outcome.result.compressorVersion}`;
      anchors = outcome.result.anchors;
      omissions = outcome.result.omissions;
      removed = outcome.result.removed;
      tokensBefore = outcome.result.tokensBefore;
      tokensAfter = outcome.result.tokensAfter;
    } else if (outcome.attempts.length > 0 && outcome.attempts.every((a) => a.ok || a.reason === "no-reduction")) {
      // Incompressible content: deliver the scanned original, honestly labelled.
      candidate = safeContent;
      strategy = "original";
      tokensAfter = this.ctx.estimateTokens(safeContent);
    } else {
      return this.withhold(event, scan, metadata, outcome.reason);
    }

    // Prefix stability: identical (object, revision) always yields identical bytes.
    const key = `${stored.objectId}#${stored.revision}`;
    const pinned = this.delivered.get(key);
    let prefixStable = false;
    let recomputeDiverged = false;
    if (pinned) {
      prefixStable = true;
      recomputeDiverged = pinned.text !== candidate;
      candidate = pinned.text;
      strategy = pinned.strategy;
    }

    // 5. Exact output scan on the precise bytes about to leave the runtime.
    const verdict = exactOutputScan(candidate, req.privateMetadata, this.detectorOptions);
    if (!verdict.ok) {
      return this.withhold(event, scan, metadata, verdict.reason);
    }

    if (!pinned) {
      this.delivered.set(key, { text: candidate, hash: sha256(candidate), strategy });
    }

    // 6. Evidence, then delivery.
    const record: EvidenceRecord = {
      type: "delivery",
      eventId,
      sessionId: req.sessionId,
      seq,
      tool: req.tool,
      kind: req.kind,
      timestamp: event.timestamp,
      objectId: stored.objectId,
      revision: stored.revision,
      originalHash: stored.sha256,
      deliveredHash: sha256(candidate),
      strategy,
      anchors,
      removed,
      omissions: toLedgerOmissions(omissions),
      safetyFindings: verdict.findings,
      secretRedactions: scan.redactions,
      metadataRedactions: metadata.redactions,
      metadataLabels: metadata.labels,
      deliveryPath: strategy === "original" ? "delivered-original" : "delivered",
      tokensBefore,
      tokensAfter,
      prefixStable,
      ...(recomputeDiverged ? { recomputeDiverged: true } : {}),
    };
    await this.ledger.record(record);

    return {
      status: "delivered",
      eventId,
      text: candidate,
      publicMetadata,
      strategy,
      retrievable: omissions.map((o) => ({
        locator: o.locator,
        kind: o.kind,
        ...(o.items === undefined ? {} : { items: o.items }),
      })),
      tokensBefore,
      tokensAfter,
    };
  }

  /**
   * Reverse a specific omission. Authorization is the ledger: only a locator this
   * event actually withheld can be retrieved, so `retrieve` cannot be used as an
   * arbitrary read of the private object.
   */
  async retrieve(req: RetrieveRequest): Promise<Retrieval> {
    const record = await this.ledger.find(req.sessionId, req.eventId);
    if (!record) return this.refuseRetrieval(req, "unknown-event");
    if (!record.omissions.some((o) => o.locator === req.locator)) {
      return this.refuseRetrieval(req, "locator-not-withheld");
    }

    let raw: string;
    try {
      raw = await this.resolve(req.sessionId, record.objectId, req.locator);
    } catch (err) {
      return this.refuseRetrieval(req, err instanceof ContextStoreError ? err.code : "resolve-error");
    }

    // A retrieval is a delivery: it goes through the same gates.
    const scan = scanAndRedact(raw, this.detectorOptions);
    const metadata = scanMetadata(scan.text, { scope: "private" });
    const verdict = exactOutputScan(metadata.text, { scope: "private" }, this.detectorOptions);
    if (!verdict.ok) return this.refuseRetrieval(req, verdict.reason);

    const tokens = this.ctx.estimateTokens(metadata.text);
    const row: RetrievalRecord = {
      type: "retrieval",
      eventId: req.eventId,
      sessionId: req.sessionId,
      timestamp: this.now(),
      locator: req.locator,
      outcome: "delivered",
      tokensDelivered: tokens,
    };
    await this.ledger.record(row);
    return { status: "delivered", text: metadata.text, locator: req.locator, tokens };
  }

  async explain(sessionId: SessionId, eventId: ContextEventId): Promise<Explanation | undefined> {
    return this.ledger.explain(sessionId, eventId);
  }

  // ------------------------------------------------------------------ internals

  private async resolve(sessionId: SessionId, objectId: ObjectId, locator: string): Promise<string> {
    if (locator.startsWith("$")) {
      const value = await this.store.jsonPath(sessionId, objectId, locator);
      return value === undefined ? "" : JSON.stringify(value);
    }
    const lines = /^L(\d+)-L(\d+)$/.exec(locator);
    if (lines) {
      return this.store.getLines(sessionId, objectId, Number(lines[1]), Number(lines[2]));
    }
    throw new ContextStoreError("invalid-path", "Unsupported locator grammar");
  }

  private async refuseRetrieval(req: RetrieveRequest, reason: string): Promise<Retrieval> {
    await this.ledger.record({
      type: "retrieval",
      eventId: req.eventId,
      sessionId: req.sessionId,
      timestamp: this.now(),
      locator: req.locator,
      outcome: "withheld",
      reason,
      tokensDelivered: 0,
    });
    return { status: "withheld", reason, locator: req.locator };
  }

  private async withhold(
    event: ContextEvent,
    scan: ReturnType<typeof scanAndRedact>,
    metadata: ReturnType<typeof scanMetadata>,
    reason: string,
  ): Promise<Delivery> {
    const record: EvidenceRecord = {
      type: "delivery",
      eventId: event.id,
      sessionId: event.sessionId,
      seq: event.seq,
      tool: event.tool,
      kind: event.kind,
      timestamp: event.timestamp,
      objectId: event.rawContent.objectId,
      revision: event.rawContent.revision,
      originalHash: (event.rawContent as { sha256?: string }).sha256 ?? "",
      deliveredHash: "",
      strategy: "withheld",
      anchors: [],
      removed: [],
      omissions: [],
      safetyFindings: scan.findings,
      secretRedactions: scan.redactions,
      metadataRedactions: metadata.redactions,
      metadataLabels: metadata.labels,
      deliveryPath: "withheld",
      withheldReason: reason,
      tokensBefore: this.ctx.estimateTokens(""),
      tokensAfter: 0,
      prefixStable: false,
    };
    await this.ledger.record(record);
    return { status: "withheld", eventId: event.id, reason, publicMetadata: event.publicMetadata };
  }

  private async nextSeq(session: SessionId): Promise<number> {
    let current = this.seqs.get(session);
    if (current === undefined) {
      const rows = await this.ledger.rows(session);
      current = rows.filter((r) => r.type === "delivery").length;
    }
    this.seqs.set(session, current + 1);
    return current;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
