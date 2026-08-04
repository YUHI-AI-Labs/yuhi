/**
 * Yuhi Runtime — the only path between an AI agent and a repository (spec §11).
 *
 * Claude thinks `Read`. Yuhi executes: Read → safety → compression → exact-output
 * rescan → evidence → Claude. The same for Bash, Test, Grep, Glob and MCP.
 *
 * TWO FAILURE CLASSES, never one fail-open path (§7):
 *  - AVAILABILITY (compressor error, timeout, none applicable): the bytes already
 *    passed secret/PII/metadata scanning, so a degraded-but-scanned representation may
 *    be delivered under policy. Blocking the agent outright would make Yuhi the reason
 *    work stops — the opposite of `file blocked ≠ launch blocked`.
 *  - SECURITY (exact-output rescan fails, private metadata survives): withheld. There
 *    is no policy that permits a raw fallback here.
 *
 * Incompressible content is neither: it delivers the scanned original, honestly
 * labelled, because inflating a view to look busy would violate §18.
 */

import { createHash } from "node:crypto";

import {
  compressWithFallback,
  defaultCompressContext,
  type CompressContext,
  type CompressionOutcome,
  type Compressor,
  type HintPolicy,
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
  type FailureClass,
  type RetrievalRecord,
} from "./ledger.js";
import { locatorWithin, narrowSuggestion, parseLocator, type Locator } from "./locator.js";
import {
  DEFAULT_DETECTOR_OPTIONS,
  exactOutputScan,
  redactKeyMaterial,
  scanAndRedact,
  scanMetadata,
} from "./safety.js";
import { DEVELOPER_MODE_POLICY, type DeliveryPolicy } from "./delivery-policy.js";

export interface FallbackPolicy {
  /** Behaviour when compression is UNAVAILABLE. Security failures ignore this. */
  readonly onAvailabilityFailure: "safe-window" | "scanned-original" | "withhold";
  /** Head+tail lines kept by the deterministic safe window. */
  readonly safeWindowLines: number;
}

export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = {
  onAvailabilityFailure: "safe-window",
  safeWindowLines: 120,
};

/** Bounded retrieval (spec §10). Configurable; a full read needs explicit approval. */
export interface RetrievalLimits {
  readonly maxLines: number;
  readonly maxBytes: number;
  readonly maxTokens: number;
}

export const DEFAULT_RETRIEVAL_LIMITS: RetrievalLimits = {
  maxLines: 300,
  maxBytes: 32_768,
  maxTokens: 8_000,
};

export interface DeliverRequest {
  readonly sessionId: SessionId;
  readonly tool: ToolName;
  readonly kind: ContentKind;
  /** Raw tool output. Goes straight into the private store; never delivered as-is. */
  readonly content: string;
  readonly privateMetadata: PrivateMetadata;
  readonly tokenBudget?: number;
  /** The agent's tool_use_id, when the caller is the gateway. */
  readonly toolUseId?: string;
  /**
   * false = scan and deliver, do not compress. For content the agent is paging through,
   * where a restructured view costs more turns than it saves (gateway scan guard).
   */
  readonly compress?: boolean;
}

export interface RetrievableRegion {
  readonly locator: string;
  readonly kind: string;
  readonly items?: number;
}

export type Delivery =
  | {
      readonly status: "delivered";
      readonly eventId: ContextEventId;
      /** The bytes the agent may see. Already scanned twice. */
      readonly text: string;
      readonly publicMetadata: PublicMetadata;
      readonly strategy: string;
      readonly retrievable: readonly RetrievableRegion[];
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly fallback?: "safe-window" | "scanned-original";
      readonly prefixStable: boolean;
      readonly anchors: readonly string[];
      readonly removed: readonly EvidenceRecord["removed"][number][];
      readonly secretRedactions: number;
      readonly metadataRedactions: number;
      /** Whether to advertise retrieval for this delivery (compressor's declaration). */
      readonly hintPolicy: HintPolicy;
      /**
       * The safety-scanned ORIGINAL — same bytes minus masking, before compression.
       *
       * The delivery layer adds a marker envelope that the runtime cannot price, so only the
       * caller can tell whether the compressed view is still smaller once wrapped. When it is
       * not, this is what must be delivered: a weak view plus an envelope is strictly worse
       * than the scanned original.
       */
      readonly scannedText: string;
    }
  | {
      readonly status: "withheld";
      readonly eventId: ContextEventId;
      readonly reason: string;
      readonly failureClass: FailureClass;
      readonly publicMetadata: PublicMetadata;
    };

export interface RetrieveRequest {
  readonly sessionId: SessionId;
  readonly eventId: ContextEventId;
  readonly locator: string;
}

export interface RetrieveByObjectRequest {
  readonly sessionId: SessionId;
  readonly objectId: ObjectId;
  readonly locator: string;
  /** Required for a full/unexposed read; recorded in the ledger. */
  readonly reason?: string;
  /** Policy escalation: bypasses the exposed-locator check, never the size limits. */
  readonly allowUnexposed?: boolean;
}

export type Retrieval =
  | { readonly status: "delivered"; readonly text: string; readonly locator: string; readonly tokens: number }
  | {
      readonly status: "withheld";
      readonly reason: string;
      readonly locator: string;
      /** A deterministic narrower locator, when the request was merely too large. */
      readonly suggestion?: string;
    };

export interface ContextRuntimeOptions {
  readonly store: ContextStore;
  readonly now?: () => string;
  readonly timeoutMs?: number;
  readonly detectorOptions?: DetectorOptions;
  readonly compressors?: readonly Compressor[];
  readonly tokenBudget?: number;
  readonly fallbackPolicy?: FallbackPolicy;
  readonly retrievalLimits?: RetrievalLimits;
  /**
   * What a detected secret means for delivery. Defaults to Developer Mode (v0.4.0): the
   * agent can read project configuration, and no raw value ever reaches logs, evidence or UI.
   */
  readonly deliveryPolicy?: DeliveryPolicy;
}

interface DeliveredBytes {
  readonly text: string;
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
  private readonly fallbackPolicy: FallbackPolicy;
  private readonly policy: DeliveryPolicy;
  private readonly limits: RetrievalLimits;
  private readonly seqs = new Map<string, number>();
  /**
   * Prefix stability (architecture §2): the bytes delivered for a given
   * (objectId, revision) must never change. Re-emitting a changed prefix invalidates
   * the provider KV cache and can raise billed cost while lowering raw token counts.
   */
  private readonly delivered = new Map<string, DeliveredBytes>();
  /** Same guarantee for retrievals: the same range always returns the same bytes. */
  private readonly retrieved = new Map<string, string>();

  constructor(opts: ContextRuntimeOptions) {
    this.store = opts.store;
    this.ledger = new EvidenceLedger(opts.store);
    this.now = opts.now ?? (() => new Date().toISOString());
    this.detectorOptions = opts.detectorOptions ?? DEFAULT_DETECTOR_OPTIONS;
    this.compressors = opts.compressors;
    this.tokenBudget = opts.tokenBudget;
    this.fallbackPolicy = opts.fallbackPolicy ?? DEFAULT_FALLBACK_POLICY;
    this.policy = opts.deliveryPolicy ?? DEVELOPER_MODE_POLICY;
    this.limits = opts.retrievalLimits ?? DEFAULT_RETRIEVAL_LIMITS;
    this.ctx = defaultCompressContext({
      now: this.now,
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
  }

  get retrievalLimits(): RetrievalLimits {
    return this.limits;
  }

  get deliveryPolicy(): DeliveryPolicy {
    return this.policy;
  }

  estimateTokens(text: string): number {
    return this.ctx.estimateTokens(text);
  }

  /** True when these bytes were already delivered and are pinned for reuse. */
  stableFor(objectId: ObjectId, revision: number): boolean {
    return this.delivered.has(`${objectId}#${revision}`);
  }

  /** Pin bytes delivered by a previous process, so a restart reproduces them exactly. */
  restoreDelivered(objectId: ObjectId, revision: number, text: string, strategy: string): void {
    this.delivered.set(`${objectId}#${revision}`, { text, strategy });
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
    // Detection ALWAYS runs; the policy decides what a finding means for delivery.
    const scan = scanAndRedact(req.content, this.detectorOptions);
    // Key material is masked in EVERY mode — the kind is recorded, the value never is.
    const keyMaterial = redactKeyMaterial(req.content, this.policy, this.detectorOptions);
    const scannedContent = this.policy.redactSecretsBeforeDelivery ? scan.text : keyMaterial.text;
    const metadata = scanMetadata(scannedContent, req.privateMetadata);
    const safeContent = metadata.text;

    // 4. Compression, over the already-safe text so the view carries placeholders.
    const budget = req.tokenBudget ?? this.tokenBudget;
    let outcome: CompressionOutcome;
    if (req.compress === false) {
      // Skipping compression is not skipping safety: the exact-output scan below still runs
      // on these bytes, and the delivery is recorded as `delivered-original`.
      outcome = { status: "failed", reason: "compression-not-requested", attempts: [{ compressorId: "none", ok: false, reason: "no-reduction" }] };
    } else {
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
      outcome = { status: "failed", reason: "compression-error", attempts: [] };
    }
    }

    let candidate: string;
    let strategy: string;
    let anchors: readonly string[] = [];
    let omissions: readonly Omission[] = [];
    let removed: EvidenceRecord["removed"] = [];
    let tokensBefore = this.ctx.estimateTokens(req.content);
    let tokensAfter = tokensBefore;
    let fallback: "safe-window" | "scanned-original" | undefined;
    let hintPolicy: HintPolicy = "offer-retrieval";

    if (outcome.status === "compressed") {
      candidate = outcome.result.text;
      strategy = `${outcome.result.compressorId}@${outcome.result.compressorVersion}`;
      anchors = outcome.result.anchors;
      omissions = outcome.result.omissions;
      removed = outcome.result.removed;
      tokensBefore = outcome.result.tokensBefore;
      tokensAfter = outcome.result.tokensAfter;
      hintPolicy = outcome.result.hintPolicy ?? "offer-retrieval";
    } else if (outcome.attempts.length > 0 && outcome.attempts.every((a) => a.ok || a.reason === "no-reduction")) {
      // Incompressible content: deliver the scanned original, honestly labelled.
      candidate = safeContent;
      strategy = "original";
      tokensAfter = this.ctx.estimateTokens(safeContent);
    } else {
      // AVAILABILITY failure. The bytes are scanned; policy decides how to degrade.
      if (this.fallbackPolicy.onAvailabilityFailure === "withhold") {
        return this.withhold(event, scan, metadata, outcome.reason, "availability");
      }
      fallback =
        this.fallbackPolicy.onAvailabilityFailure === "safe-window" ? "safe-window" : "scanned-original";
      if (fallback === "safe-window") {
        const win = safeWindow(safeContent, this.fallbackPolicy.safeWindowLines);
        candidate = win.text;
        // The gap must be retrievable, or the fallback would destroy content: record
        // it as an omission so the ledger exposes the locator like any other.
        if (win.omitted) {
          omissions = [
            {
              objectId: stored.objectId,
              locator: win.omitted.locator,
              kind: win.omitted.locator.startsWith("B") ? "text-bytes" : "text-lines",
              tokensOmitted: this.ctx.estimateTokens(win.omitted.text),
              items: win.omitted.lines,
            },
          ];
          removed = [
            { kind: win.omitted.locator.startsWith("B") ? "text-bytes" : "text-lines", count: win.omitted.lines },
          ];
        }
      } else {
        candidate = safeContent;
      }
      strategy = `fallback:${fallback}`;
      tokensAfter = this.ctx.estimateTokens(candidate);
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
    const verdict = exactOutputScan(candidate, req.privateMetadata, this.detectorOptions, undefined, this.policy);
    if (!verdict.ok) {
      return this.withhold(event, scan, metadata, verdict.reason, "security");
    }

    if (!pinned) this.delivered.set(key, { text: candidate, strategy });

    const deliveryPath: EvidenceRecord["deliveryPath"] = fallback
      ? "delivered-fallback"
      : strategy === "original"
        ? "delivered-original"
        : "delivered";

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
      // Metadata only: category, count, fingerprint, policy. Never a value.
      ...(scan.fingerprints.length > 0 ? { secretFingerprints: scan.fingerprints } : {}),
      deliveryPolicy: this.policy.mode,
      ...(keyMaterial.categories.length > 0 ? { keyMaterialMasked: keyMaterial.categories } : {}),
      secretRedactions: this.policy.redactSecretsBeforeDelivery ? scan.redactions : keyMaterial.count,
      metadataRedactions: metadata.redactions,
      metadataLabels: metadata.labels,
      deliveryPath,
      tokensBefore,
      tokensAfter,
      prefixStable,
      ...(fallback ? { fallback, failureClass: "availability" as const } : {}),
      ...(recomputeDiverged ? { recomputeDiverged: true } : {}),
      ...(req.toolUseId ? { toolUseId: req.toolUseId } : {}),
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
      prefixStable,
      anchors,
      removed: [...removed],
      secretRedactions: this.policy.redactSecretsBeforeDelivery ? scan.redactions : keyMaterial.count,
      metadataRedactions: metadata.redactions,
      hintPolicy,
      scannedText: safeContent,
      ...(fallback ? { fallback } : {}),
    };
  }

  /** Retrieve by event id (kept for callers that hold one). */
  async retrieve(req: RetrieveRequest): Promise<Retrieval> {
    const record = await this.ledger.find(req.sessionId, req.eventId);
    if (!record) {
      await this.recordRetrieval(req.sessionId, req.eventId, req.locator, "withheld", "unknown-event", 0);
      return { status: "withheld", reason: "unknown-event", locator: req.locator };
    }
    return this.retrieveByObject({
      sessionId: req.sessionId,
      objectId: record.objectId,
      locator: req.locator,
    });
  }

  /**
   * Retrieve by object id — the path the gateway marker and the MCP tools use.
   *
   * Authorization is the ledger, not knowledge of the id: the locator must be one
   * Yuhi exposed for this object, or narrower than one it exposed.
   */
  async retrieveByObject(req: RetrieveByObjectRequest): Promise<Retrieval> {
    const requested = parseLocator(req.locator);
    if (!requested) {
      return this.refuse(req, "invalid-locator");
    }

    const deliveries = await this.deliveriesForObject(req.sessionId, req.objectId);
    // Correlate the retrieval with the delivery that exposed the region, so
    // `explain()` can report a complete retrieval count for that event.
    const eventId = deliveries[deliveries.length - 1]?.eventId;
    const exposed = locatorsOf(deliveries);
    if (exposed.length === 0 && !req.allowUnexposed) {
      return this.refuse(req, "object-not-delivered-in-session", undefined, eventId);
    }
    const authorized =
      exposed.some((e) => locatorWithin(requested, e)) || (req.allowUnexposed === true && !!req.reason);
    if (!authorized) {
      return this.refuse(req, "locator-not-withheld", undefined, eventId);
    }

    // Deterministic re-retrieval: the same range always returns the same bytes.
    const cacheKey = `${req.objectId}#${req.locator}`;
    const cached = this.retrieved.get(cacheKey);
    if (cached !== undefined) {
      await this.recordRetrieval(req.sessionId, eventId, req.locator, "delivered", req.reason, this.ctx.estimateTokens(cached));
      return { status: "delivered", text: cached, locator: req.locator, tokens: this.ctx.estimateTokens(cached) };
    }

    let raw: string;
    try {
      raw = await this.resolve(req.sessionId, req.objectId, requested);
    } catch (err) {
      return this.refuse(req, err instanceof ContextStoreError ? err.code : "resolve-error", undefined, eventId);
    }

    // Bounded: an exposed locator is not permission to pull an unbounded range.
    const bound = this.checkBounds(raw, requested);
    if (bound) return this.refuse(req, bound.reason, bound.suggestion, eventId);

    // A retrieval is a delivery: it goes through the same gates.
    const scan = scanAndRedact(raw, this.detectorOptions);
    const retrievedContent = this.policy.redactSecretsBeforeDelivery
      ? scan.text
      : redactKeyMaterial(raw, this.policy, this.detectorOptions).text;
    const metadata = scanMetadata(retrievedContent, { scope: "private" });
    const verdict = exactOutputScan(metadata.text, { scope: "private" }, this.detectorOptions, undefined, this.policy);
    if (!verdict.ok) return this.refuse(req, verdict.reason, undefined, eventId);

    const text = metadata.text;
    this.retrieved.set(cacheKey, text);
    const tokens = this.ctx.estimateTokens(text);
    await this.recordRetrieval(req.sessionId, eventId, req.locator, "delivered", req.reason, tokens);
    return { status: "delivered", text, locator: req.locator, tokens };
  }

  async explain(sessionId: SessionId, eventId: ContextEventId): Promise<Explanation | undefined> {
    return this.ledger.explain(sessionId, eventId);
  }

  /** All deliveries recorded for one object, newest last. Used by `yuhi_explain_context`. */
  async deliveriesForObject(sessionId: SessionId, objectId: ObjectId): Promise<EvidenceRecord[]> {
    const rows = await this.ledger.rows(sessionId);
    return rows.filter((r): r is EvidenceRecord => r.type === "delivery" && r.objectId === objectId);
  }

  // ------------------------------------------------------------------ internals

  private checkBounds(text: string, locator: Locator): { reason: string; suggestion?: string } | undefined {
    const bytes = Buffer.byteLength(text, "utf8");
    const lines = text.length === 0 ? 0 : text.split("\n").length;
    const tokens = this.ctx.estimateTokens(text);
    if (bytes <= this.limits.maxBytes && lines <= this.limits.maxLines && tokens <= this.limits.maxTokens) {
      return undefined;
    }
    const suggestion = narrowSuggestion(locator, Math.min(this.limits.maxLines, 100));
    return { reason: "range-too-large", ...(suggestion ? { suggestion } : {}) };
  }

  private async resolve(sessionId: SessionId, objectId: ObjectId, locator: Locator): Promise<string> {
    if (locator.kind === "lines") {
      return this.store.getLines(sessionId, objectId, locator.from, locator.to);
    }
    if (locator.kind === "bytes") {
      return (await this.store.getRange(sessionId, objectId, locator.from, locator.to)).toString("utf8");
    }
    const value = await this.store.jsonPath(
      sessionId,
      objectId,
      `$${locator.segments.map((s) => (s.kind === "key" ? `.${s.key}` : s.kind === "index" ? `[${s.index}]` : s.kind === "wildcard" ? "[*]" : `[${s.start}:${s.end}]`)).join("")}`,
    );
    return value === undefined ? "" : JSON.stringify(value);
  }

  private async refuse(
    req: RetrieveByObjectRequest,
    reason: string,
    suggestion?: string,
    eventId?: ContextEventId,
  ): Promise<Retrieval> {
    await this.recordRetrieval(req.sessionId, eventId, req.locator, "withheld", req.reason, 0, reason);
    return { status: "withheld", reason, locator: req.locator, ...(suggestion ? { suggestion } : {}) };
  }

  private async recordRetrieval(
    sessionId: SessionId,
    eventId: ContextEventId | undefined,
    locator: string,
    outcome: "delivered" | "withheld",
    requestReason: string | undefined,
    tokens: number,
    refusalReason?: string,
  ): Promise<void> {
    const row: RetrievalRecord = {
      type: "retrieval",
      eventId: eventId ?? ("" as ContextEventId),
      sessionId,
      timestamp: this.now(),
      locator,
      outcome,
      tokensDelivered: tokens,
      ...(refusalReason ? { reason: refusalReason } : requestReason ? { reason: requestReason } : {}),
    };
    await this.ledger.record(row);
  }

  private async withhold(
    event: ContextEvent,
    scan: ReturnType<typeof scanAndRedact>,
    metadata: ReturnType<typeof scanMetadata>,
    reason: string,
    failureClass: FailureClass,
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
      ...(scan.fingerprints.length > 0 ? { secretFingerprints: scan.fingerprints } : {}),
      deliveryPolicy: this.policy.mode,
      secretRedactions: scan.redactions,
      metadataRedactions: metadata.redactions,
      metadataLabels: metadata.labels,
      deliveryPath: "withheld",
      withheldReason: reason,
      failureClass,
      tokensBefore: this.ctx.estimateTokens(""),
      tokensAfter: 0,
      prefixStable: false,
    };
    await this.ledger.record(record);
    return {
      status: "withheld",
      eventId: event.id,
      reason,
      failureClass,
      publicMetadata: event.publicMetadata,
    };
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

/**
 * Deterministic degraded representation: head and tail lines with an explicit,
 * retrievable gap marker. Used when compression is unavailable but the bytes are
 * scanned — never when safety is uncertain.
 */
export function safeWindow(
  text: string,
  windowLines: number,
): { text: string; omitted?: { locator: string; text: string; lines: number } } {
  const lines = text.split("\n");
  const keep = Math.max(1, Math.floor(windowLines / 2));
  // Long single-line content (a one-line JSON file, a minified bundle) cannot be
  // reduced by a line window; fall back to a byte window so the degraded path still
  // degrades. Learned from real Claude Code traffic.
  if (lines.length <= keep * 2 + 1) {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength < 6_000) return { text };
    const from = 2_400;
    const to = bytes.byteLength - 800;
    const locator = `B${from}-B${to}`;
    return {
      text: `${bytes.subarray(0, from).toString("utf8")}\n… ${to - from} bytes withheld (compression unavailable) → retrieve ${locator} …\n${bytes.subarray(bytes.byteLength - 800).toString("utf8")}`,
      omitted: { locator, text: bytes.subarray(from, to).toString("utf8"), lines: to - from },
    };
  }
  const from = keep + 1;
  const to = lines.length - keep;
  const omittedText = lines.slice(keep, lines.length - keep).join("\n");
  return {
    text: [
      ...lines.slice(0, keep),
      `… ${to - from + 1} lines withheld (compression unavailable) → retrieve L${from}-L${to} …`,
      ...lines.slice(lines.length - keep),
    ].join("\n"),
    omitted: { locator: `L${from}-L${to}`, text: omittedText, lines: to - from + 1 },
  };
}

/** Every region a set of deliveries exposed, as parsed locators. */
function locatorsOf(records: readonly EvidenceRecord[]): Locator[] {
  const out: Locator[] = [];
  for (const record of records) {
    for (const omission of record.omissions) {
      const parsed = parseLocator(omission.locator);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
