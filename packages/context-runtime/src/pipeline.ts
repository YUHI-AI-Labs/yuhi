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
  BUILTIN_COMPRESSORS,
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
  byteCount,
  codePointCount,
  createStudentAliasContext,
  DEFAULT_PRIVACY_MODE,
  directPersonalValueTokens,
  modeTransformsDirectIdentifiers,
  scanTextForDirectPersonalIdentifiers,
  type PrivacyMode,
  type StudentAliasContext,
} from "@yuhi/shared";

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
import { classifyDeliveryContent, transformDirectPersonalIdentifiers } from "./privacy-pipeline.js";
import {
  DEFAULT_DETECTOR_OPTIONS,
  exactOutputScan,
  redactKeyMaterial,
  scanAndRedact,
  scanMetadata,
} from "./safety.js";
import { DEVELOPER_MODE_POLICY, type DeliveryPolicy } from "./delivery-policy.js";
import {
  classifyIntent,
  classifyRole,
  capabilitiesOf,
  defaultPlanner,
  hasTestFailureMarkers,
} from "./planner/index.js";
import type {
  ContextIntent,
  ContextPlan,
  ContextRole,
  DynamicContextPlanner,
  GenerationMode,
  PriorDelivery,
} from "./planner/index.js";

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
      /** v0.4.8 Phase 3A — kept separate from `secretRedactions`/compression stats
       *  (spec §11): a privacy transformation is not a secret redaction. */
      readonly privacyMode: string;
      readonly directIdentifiersTransformed: number;
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
  /**
   * What happens to DIRECT PERSONAL IDENTIFIERS (v0.4.8 Phase 3A). Defaults to
   * Balanced — the same default Static Prepare uses. A DIFFERENT axis from
   * `deliveryPolicy`, which governs SECRETS only (see `@yuhi/shared`'s privacy-mode.ts).
   */
  readonly privacyMode?: PrivacyMode;
  /**
   * The run/session-scoped de-identification registry. Shared with Static Prepare's
   * shape (`StudentAliasContext`) so a value pseudonymized in one surface reuses the
   * SAME token in another, when the caller passes the same context across surfaces.
   * Defaults to a fresh, empty registry (a new Dynamic session with no prior linkage).
   */
  readonly aliasContext?: StudentAliasContext;
  /**
   * v0.5.0 Task-Aware Dynamic Context Generation. Defaults to `"off"` — a
   * zero-overhead escape hatch, no `PlannerInput` is even constructed (see
   * docs/design/0.5.0_dynamic_generation.md §2). `"observe"` computes a
   * counterfactual `ContextPlan` and records it in evidence WITHOUT changing what
   * is actually delivered — this is the mechanism, not a promise: the executed
   * path in observe mode is byte-identical to `"off"`. `"active"` is not yet
   * wired to change delivery (see Phase 2+); it currently behaves like
   * `"observe"` and is reserved for incremental rollout.
   */
  readonly generationMode?: GenerationMode;
  /** Planner override, primarily for tests. Defaults to the v1 deterministic planner. */
  readonly planner?: DynamicContextPlanner;
  /**
   * Whether retrieval tools are registered for this session (Rule 5/8). Defaults
   * to false, matching v0.4.0's measured-cheapest default (retrieval is opt-in).
   */
  readonly retrievalAvailable?: boolean;
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
  private readonly privacyMode: PrivacyMode;
  private readonly aliasContext: StudentAliasContext;
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
  private readonly generationMode: GenerationMode;
  private readonly planner: DynamicContextPlanner;
  private readonly retrievalAvailable: boolean;
  /**
   * v0.5.0 Prior Delivery Ledger (planner_contract.md §4) — a superset of `delivered`
   * used for the PLANNER's own Rule 2 decision. Instance-scoped like `delivered`,
   * for the same reason: content is addressed by (objectId, revision), which is
   * already effectively content-identity, not session identity.
   */
  private readonly priorDeliveries = new Map<string, PriorDelivery>();

  constructor(opts: ContextRuntimeOptions) {
    this.store = opts.store;
    this.ledger = new EvidenceLedger(opts.store);
    this.now = opts.now ?? (() => new Date().toISOString());
    this.detectorOptions = opts.detectorOptions ?? DEFAULT_DETECTOR_OPTIONS;
    this.compressors = opts.compressors;
    this.tokenBudget = opts.tokenBudget;
    this.fallbackPolicy = opts.fallbackPolicy ?? DEFAULT_FALLBACK_POLICY;
    this.policy = opts.deliveryPolicy ?? DEVELOPER_MODE_POLICY;
    this.privacyMode = opts.privacyMode ?? DEFAULT_PRIVACY_MODE;
    this.aliasContext = opts.aliasContext ?? createStudentAliasContext();
    this.limits = opts.retrievalLimits ?? DEFAULT_RETRIEVAL_LIMITS;
    this.generationMode = opts.generationMode ?? "off";
    this.planner = opts.planner ?? defaultPlanner;
    this.retrievalAvailable = opts.retrievalAvailable ?? false;
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

  get currentPrivacyMode(): PrivacyMode {
    return this.privacyMode;
  }

  /** The run-scoped de-identification registry — exposed so a caller can persist it
   *  across process restarts (mirrors Static Prepare's alias-registry-store, Phase 3B). */
  get privacyAliasContext(): StudentAliasContext {
    return this.aliasContext;
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

    // 0. Direct-personal identifier transformation, BEFORE any secret scan or
    // compression — the SAME taxonomy/registry/verification Static Prepare uses
    // (v0.4.8 Phase 3A), routed by content shape so source code and command output are
    // not scanned for CJK name-shaped substrings (see `privacy-pipeline.ts`).
    let privacyText: string;
    let privacyDetected = 0;
    let privacyTransformed = 0;
    try {
      const contentType = classifyDeliveryContent(req.kind, req.content);
      const outcome = transformDirectPersonalIdentifiers(req.content, contentType, this.aliasContext, this.privacyMode);
      privacyText = outcome.text;
      privacyDetected = outcome.detected;
      privacyTransformed = outcome.transformed;
    } catch {
      const failScan = scanAndRedact(req.content, this.detectorOptions);
      const failMetadata = scanMetadata(failScan.text, req.privateMetadata);
      return this.withhold(event, failScan, failMetadata, "privacy-transformation-failed", "security", "privacy-transformation-failed");
    }

    // 1-3. Secret scan → PII scan → metadata scan, before anything is compressed.
    // Detection ALWAYS runs; the policy decides what a finding means for delivery.
    const scan = scanAndRedact(privacyText, this.detectorOptions);
    // Key material is masked in EVERY mode — the kind is recorded, the value never is.
    const keyMaterial = redactKeyMaterial(privacyText, this.policy, this.detectorOptions);
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

    // 5b. Direct-personal residue rescan — the same "verify the EXACT delivered bytes,
    // not the transform's self-report" discipline §5 applies to secrets. Balanced and
    // Strict fail closed on residue; Trusted Local never transformed anything, so
    // residue there is expected and is not a failure (spec §9).
    let directResidue = 0;
    if (modeTransformsDirectIdentifiers(this.privacyMode)) {
      const residueCheck = scanTextForDirectPersonalIdentifiers(
        candidate,
        directPersonalValueTokens(this.aliasContext).keys(),
      );
      directResidue = residueCheck.residual;
      if (directResidue > 0) {
        return this.withhold(
          event,
          scan,
          metadata,
          "direct-personal-identifier-in-output",
          "security",
          "direct-personal-identifier-in-output",
        );
      }
    }

    if (!pinned) this.delivered.set(key, { text: candidate, strategy });

    const deliveryPath: EvidenceRecord["deliveryPath"] = fallback
      ? "delivered-fallback"
      : strategy === "original"
        ? "delivered-original"
        : "delivered";

    // v0.5.0 Planner — OBSERVE ONLY (docs/design/0.5.0_dynamic_generation.md §2).
    // `"off"` never builds a PlannerInput: zero overhead, not a flag check in the
    // hot path. `"observe"`/`"active"` compute a counterfactual plan and record it
    // in evidence; the bytes already chosen above (`candidate`/`strategy`) are
    // NEVER changed by this block in Phase 1 — that is the guarantee, not a TODO.
    let plan: ContextPlan | undefined;
    let planIntent: ContextIntent | undefined;
    let planRole: ContextRole | undefined;
    if (this.generationMode !== "off") {
      const failureMarkers = hasTestFailureMarkers(req.kind, req.content);
      planIntent = classifyIntent({
        tool: req.tool,
        toolInput: req.privateMetadata.absolutePath ?? req.privateMetadata.command,
        kind: req.kind,
        hasFailureMarkers: failureMarkers,
      });
      planRole = classifyRole({
        tool: req.tool,
        toolInput: req.privateMetadata.absolutePath ?? req.privateMetadata.command,
        kind: req.kind,
        hasFailureMarkers: failureMarkers,
        activeEditTargets: [],
        isRepeatedContent: this.priorDeliveries.has(key),
        confidenceHint: req.privateMetadata.absolutePath ? "high" : "low",
      });
      plan = this.planner.plan({
        intent: planIntent,
        role: planRole,
        contentType: req.kind,
        objectId: stored.objectId,
        revision: stored.revision,
        measurement: { estimatedTokens: tokensBefore, exactCharacters: codePointCount(req.content) },
        priorDeliveries: [...this.priorDeliveries.values()],
        retrievalAvailable: this.retrievalAvailable,
        compressors: capabilitiesOf(this.compressors ? [...this.compressors] : [...BUILTIN_COMPRESSORS]),
        privacyMode: this.privacyMode,
        secretDeliveryMode: this.policy.redactSecretsBeforeDelivery ? "redact" : "developer-delivery",
        privacyOrSecurityFailure: false,
        tool: req.tool,
      });
      this.priorDeliveries.set(key, {
        objectId: stored.objectId,
        revision: stored.revision,
        representationId: strategy,
        deliveredHash: sha256(candidate),
        planKind: plan.kind,
        ...(plan.strategyId ? { strategyId: plan.strategyId } : {}),
        estimatedTokens: tokensAfter,
        exactCharacters: byteCount(candidate),
        deliveredAtTurn: seq,
      });
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
      // Metadata only: category, count, fingerprint, policy. Never a value.
      ...(scan.fingerprints.length > 0 ? { secretFingerprints: scan.fingerprints } : {}),
      deliveryPolicy: this.policy.mode,
      ...(keyMaterial.categories.length > 0 ? { keyMaterialMasked: keyMaterial.categories } : {}),
      privacyMode: this.privacyMode,
      secretDeliveryMode: this.policy.redactSecretsBeforeDelivery ? "redact" : "developer-delivery",
      directIdentifiersDetected: privacyDetected,
      directIdentifiersTransformed: privacyTransformed,
      directIdentifierResidue: directResidue,
      privacyTransformationApplied: privacyTransformed > 0,
      privacyVerificationPassed: true,
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
      ...(plan
        ? {
            plan: {
              // Phase 1 scope: "active" never drives delivery yet (see the block
              // above), so `executed` is unconditionally false until a later phase
              // wires Rule 2+ into the actual compression call.
              generationMode: this.generationMode === "active" ? "active" : "observe",
              intent: planIntent ?? "unknown",
              role: planRole ?? "unknown",
              kind: plan.kind,
              reason: plan.reason,
              rule: plan.rule,
              ...(plan.strategyId ? { strategyId: plan.strategyId } : {}),
              confidence: plan.confidence,
              executed: false,
            },
          }
        : {}),
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
      privacyMode: this.privacyMode,
      directIdentifiersTransformed: privacyTransformed,
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
    // Same content-type routing a delivery uses, so a retrieved range gets the SAME
    // precision (structured-table/JSON/prose/…) the original delivery would have.
    const contentKind = deliveries[deliveries.length - 1]?.kind ?? "text";
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

    // A retrieval is a delivery: it goes through the same gates, re-applying the
    // RUNTIME'S CURRENT privacy policy — never the raw bytes, and never a policy
    // pinned from when the range was first delivered (spec §7).
    let privacyRaw: string;
    try {
      const contentType = classifyDeliveryContent(contentKind, raw);
      privacyRaw = transformDirectPersonalIdentifiers(raw, contentType, this.aliasContext, this.privacyMode).text;
    } catch {
      return this.refuse(req, "privacy-transformation-failed", undefined, eventId);
    }

    const scan = scanAndRedact(privacyRaw, this.detectorOptions);
    const retrievedContent = this.policy.redactSecretsBeforeDelivery
      ? scan.text
      : redactKeyMaterial(privacyRaw, this.policy, this.detectorOptions).text;
    const metadata = scanMetadata(retrievedContent, { scope: "private" });
    const verdict = exactOutputScan(metadata.text, { scope: "private" }, this.detectorOptions, undefined, this.policy);
    if (!verdict.ok) return this.refuse(req, verdict.reason, undefined, eventId);

    if (modeTransformsDirectIdentifiers(this.privacyMode)) {
      const residueCheck = scanTextForDirectPersonalIdentifiers(
        metadata.text,
        directPersonalValueTokens(this.aliasContext).keys(),
      );
      if (residueCheck.residual > 0) {
        return this.refuse(req, "direct-personal-identifier-in-output", undefined, eventId);
      }
    }

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
    privacyFailure?: "privacy-transformation-failed" | "direct-personal-identifier-in-output",
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
      privacyMode: this.privacyMode,
      secretDeliveryMode: this.policy.redactSecretsBeforeDelivery ? "redact" : "developer-delivery",
      ...(privacyFailure
        ? { privacyVerificationPassed: false, privacyFallback: privacyFailure }
        : { privacyVerificationPassed: true }),
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
