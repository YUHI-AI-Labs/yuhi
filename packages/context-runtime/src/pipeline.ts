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
  currentMeasurementMethod,
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
  GenerationCache,
  RepeatedWorkTracker,
  repeatedWorkHint,
  type RepeatedWorkStats,
} from "./planner/index.js";
import type {
  ContextIntent,
  ContextPlan,
  ContextRole,
  DynamicContextPlanner,
  GenerationMode,
  PriorDelivery,
  RuntimeBudgetState,
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
  /**
   * v0.5.0 Dynamic Context runtime budget (docs/design/0.5.0_dynamic_generation.md
   * §4). Both `target`/`maximum` optional; omitted entirely (the default) means
   * the Planner never sees a budget object at all -- Rule 7/9's behavior is then
   * identical to pre-0.5.0 `deliver()`. When present, the measurement METHOD is
   * captured once at construction and never re-read mid-session (switching
   * estimators mid-session would make "delivered so far" incomparable to
   * "target").
   */
  readonly runtimeBudget?: { readonly target?: number; readonly maximum?: number };
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
  /** v0.5.0 Generation Cache (planner_contract.md §5) — see the field's own doc
   *  comment in cache.ts for why `planKind`/`strategyVersion` live on the entry. */
  private readonly generationCache = new GenerationCache();
  /** v0.5.0 Dynamic Budget (Phase 4). `undefined` target/maximum -> pre-0.5.0
   *  compatible (see `runtimeBudget` on `ContextRuntimeOptions`). */
  private readonly runtimeBudgetConfig: { target?: number; maximum?: number } | undefined;
  /** Fixed once at construction — never re-read mid-session (design doc §4). */
  private readonly budgetMeasurementMethod: string;
  private cumulativeEstimatedTokens = 0;
  private cumulativeExactCharacters = 0;
  /** v0.5.0 Repeated Work Observation (Phase 5) — advisory only. */
  private readonly repeatedWork = new RepeatedWorkTracker();

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
    this.runtimeBudgetConfig = opts.runtimeBudget;
    this.budgetMeasurementMethod = currentMeasurementMethod();
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

  /** v0.5.0 Generation Cache hit/miss counts (planner_contract.md §5). */
  get generationCacheStats(): { hits: number; misses: number } {
    return this.generationCache.stats();
  }

  /** v0.5.0 Repeated Work Observation stats (planner_contract.md §6). */
  get repeatedWorkSessionStats(): RepeatedWorkStats {
    return this.repeatedWork.stats();
  }

  estimateTokens(text: string): number {
    return this.ctx.estimateTokens(text);
  }

  /** v0.5.0 Dynamic Budget state, built fresh per call from the session's
   *  cumulative counters (docs/design/0.5.0_dynamic_generation.md §4). Only
   *  called when `runtimeBudgetConfig` is set, so `target`/`maximum` are never
   *  both undefined here even though the type allows it (they came from
   *  `ContextRuntimeOptions.runtimeBudget`, which itself may set only one). */
  private currentBudgetState(): RuntimeBudgetState {
    const remaining =
      this.runtimeBudgetConfig?.maximum === undefined
        ? undefined
        : Math.max(0, this.runtimeBudgetConfig.maximum - this.cumulativeEstimatedTokens);
    return {
      ...(this.runtimeBudgetConfig?.target === undefined ? {} : { target: this.runtimeBudgetConfig.target }),
      ...(this.runtimeBudgetConfig?.maximum === undefined ? {} : { maximum: this.runtimeBudgetConfig.maximum }),
      unit: "tokens",
      method: this.budgetMeasurementMethod,
      estimatedDelivered: this.cumulativeEstimatedTokens,
      ...(remaining === undefined ? {} : { estimatedRemaining: remaining }),
      exactDeliveredCharacters: this.cumulativeExactCharacters,
    };
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

    // v0.5.0 Planner — computed BEFORE compression so "active" mode can steer
    // WHICH existing path executes (docs/design/0.5.0_dynamic_generation.md §2).
    // `"off"` never builds a PlannerInput (zero overhead). `"observe"` computes the
    // SAME plan but never branches on it below — the compression call a few lines
    // down is taken UNCONDITIONALLY for observe, exactly as before Phase 3, which
    // is what keeps observe byte-identical to off (see observe-mode.test.ts).
    let plan: ContextPlan | undefined;
    let planIntent: ContextIntent | undefined;
    let planRole: ContextRole | undefined;
    const key = `${stored.objectId}#${stored.revision}`;
    // Captured BEFORE this delivery's own write to `priorDeliveries` below, so
    // Phase 5's repeated-work observation asks "was this already delivered
    // EARLIER this session," not "does an entry exist now."
    const wasAlreadyDelivered = this.priorDeliveries.has(key);
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
        isRepeatedContent: wasAlreadyDelivered,
        confidenceHint: req.privateMetadata.absolutePath ? "high" : "low",
      });
      plan = this.planner.plan({
        intent: planIntent,
        role: planRole,
        contentType: req.kind,
        objectId: stored.objectId,
        revision: stored.revision,
        measurement: { estimatedTokens: this.ctx.estimateTokens(req.content), exactCharacters: codePointCount(req.content) },
        priorDeliveries: [...this.priorDeliveries.values()],
        retrievalAvailable: this.retrievalAvailable,
        compressors: capabilitiesOf(this.compressors ? [...this.compressors] : [...BUILTIN_COMPRESSORS]),
        privacyMode: this.privacyMode,
        secretDeliveryMode: this.policy.redactSecretsBeforeDelivery ? "redact" : "developer-delivery",
        ...(this.runtimeBudgetConfig ? { budget: this.currentBudgetState() } : {}),
        privacyOrSecurityFailure: false,
        tool: req.tool,
      });
    }
    const active = this.generationMode === "active" ? plan : undefined;

    // 4. Compression, over the already-safe text so the view carries placeholders.
    // Phase 3: an "active" plan of rule-4/5/6 steers this step (structured/
    // reference/window); every other rule (and observe/off) takes the pre-0.5.0
    // path unchanged. Whichever path runs, `candidate` still passes the SAME
    // exact-output rescan and residue rescan below — this block only chooses
    // which bytes are proposed, never what counts as safe to deliver.
    const budget = req.tokenBudget ?? this.tokenBudget;
    let outcome: CompressionOutcome;
    let plannerCandidate: { candidate: string; strategy: string; omissions: readonly Omission[]; removed: EvidenceRecord["removed"] } | undefined;
    if (req.compress === false) {
      // Skipping compression is not skipping safety: the exact-output scan below still runs
      // on these bytes, and the delivery is recorded as `delivered-original`.
      outcome = { status: "failed", reason: "compression-not-requested", attempts: [{ compressorId: "none", ok: false, reason: "no-reduction" }] };
    } else if (active?.rule === "rule-6-window") {
      const win = safeWindow(safeContent, this.fallbackPolicy.safeWindowLines);
      plannerCandidate = {
        candidate: win.text,
        strategy: "planner:window",
        omissions: win.omitted
          ? [
              {
                objectId: stored.objectId,
                locator: win.omitted.locator,
                kind: win.omitted.locator.startsWith("B") ? "text-bytes" : "text-lines",
                tokensOmitted: this.ctx.estimateTokens(win.omitted.text),
                items: win.omitted.lines,
              },
            ]
          : [],
        removed: win.omitted
          ? [{ kind: win.omitted.locator.startsWith("B") ? "text-bytes" : "text-lines", count: win.omitted.lines }]
          : [],
      };
      outcome = { status: "failed", reason: "planner-window", attempts: [] };
    } else if (active?.rule === "rule-5-reference") {
      const ref = referenceOnly(safeContent);
      plannerCandidate = {
        candidate: ref.text,
        strategy: "planner:reference",
        omissions: [
          {
            objectId: stored.objectId,
            locator: ref.omitted.locator,
            kind: ref.omitted.locator.startsWith("B") ? "text-bytes" : "text-lines",
            tokensOmitted: this.ctx.estimateTokens(ref.omitted.text),
            items: ref.omitted.lines,
          },
        ],
        removed: [{ kind: ref.omitted.locator.startsWith("B") ? "text-bytes" : "text-lines", count: ref.omitted.lines }],
      };
      outcome = { status: "failed", reason: "planner-reference", attempts: [] };
    } else {
    try {
      const registryOverride =
        active?.rule === "rule-4-structured"
          ? (this.compressors ? [...this.compressors] : [...BUILTIN_COMPRESSORS]).filter((c) => c.id !== "text-window")
          : this.compressors;
      outcome = await compressWithFallback(
        {
          objectId: stored.objectId,
          revision: stored.revision,
          kind: req.kind,
          content: safeContent,
          ...(budget === undefined ? {} : { tokenBudget: budget }),
        },
        this.ctx,
        registryOverride,
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

    if (plannerCandidate) {
      candidate = plannerCandidate.candidate;
      strategy = plannerCandidate.strategy;
      omissions = plannerCandidate.omissions;
      removed = plannerCandidate.removed;
      tokensAfter = this.ctx.estimateTokens(candidate);
      hintPolicy = "offer-retrieval";
    } else if (outcome.status === "compressed") {
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
    // `key` was already computed above, before compression, so the Planner could
    // consult `priorDeliveries` for this exact identity.
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

    // v0.5.0 Planner ledger/cache write-through. `plan`/`planIntent`/`planRole`
    // were already computed BEFORE compression (see above) so "active" mode could
    // steer execution; this only records the OUTCOME now that real delivered
    // bytes exist. Phase 3: rules 4/5/6 (structured/reference/window) execute for
    // real in "active" mode via `plannerCandidate` above; every other rule stays
    // observe-only (evidence-only) until a later phase.
    // v0.5.0 Repeated Work Observation (Phase 5) — advisory only, matching the
    // directive: recorded in evidence/stats unconditionally when `plan` exists
    // (i.e. generationMode !== "off"), but never a forced block, and a hint
    // string is only ever computed, never injected into `candidate` itself (see
    // planner_contract.md §6's scope note in repeated-work.ts for why: the
    // existing prefix-stability pin would either discard a hint added after
    // pinning or double-apply one added before, so hints stay evidence-only in
    // this Release Candidate — still fully explainable via `yuhi_explain`).
    let repeatedWorkEvidence: { type: string; count: number; estimatedAvoidableTokens?: number; hint?: string } | undefined;
    if (plan && wasAlreadyDelivered) {
      const repEvent = this.repeatedWork.observeDelivery(req.tool, stored.objectId, tokensAfter);
      if (repEvent) {
        const hint = this.repeatedWork.shouldHint(stored.objectId, repEvent.type, repEvent.count)
          ? repeatedWorkHint(repEvent.type)
          : undefined;
        repeatedWorkEvidence = {
          type: repEvent.type,
          count: repEvent.count,
          ...(repEvent.estimatedAvoidableTokens === undefined ? {} : { estimatedAvoidableTokens: repEvent.estimatedAvoidableTokens }),
          ...(hint ? { hint } : {}),
        };
      }
    }

    if (plan) {
      // v0.5.0 Dynamic Budget: cumulative counters feed the NEXT call's
      // `currentBudgetState()`. Tracked regardless of whether a budget is
      // configured (cheap; keeps the counters correct if budget is added
      // mid-session via a fresh runtime) but only ever READ when it is.
      this.cumulativeEstimatedTokens += tokensAfter;
      this.cumulativeExactCharacters += byteCount(candidate);
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
      // Generation Cache (planner_contract.md §5) — a richer-keyed, WRITE-THROUGH
      // record alongside `priorDeliveries`. Not yet consulted for lookups in
      // Phase 2 (Rule 2 reads `priorDeliveries` only); this populates the cache so
      // its hit/miss invariants are real and testable ahead of Phase 3+ wiring it
      // into the lookup path itself.
      this.generationCache.set(
        {
          objectId: stored.objectId,
          revision: stored.revision,
          privacyMode: this.privacyMode,
          secretDeliveryMode: this.policy.redactSecretsBeforeDelivery ? "redact" : "developer-delivery",
          intent: planIntent ?? "unknown",
        },
        {
          planKind: plan.kind,
          strategyVersion: strategy,
          deliveredHash: sha256(candidate),
          estimatedTokens: tokensAfter,
          exactCharacters: byteCount(candidate),
        },
      );
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
              // Phase 3 scope: rule-2 (reuse, Phase 2 — safe because it is already
              // the same decision `this.delivered` makes unconditionally), and
              // rule-4/5/6 (structured/reference/window, Phase 3 — executed via
              // `plannerCandidate` above) are "executed" in active mode. Rules 1
              // (withhold — already enforced upstream regardless of the planner),
              // 3/7 (full — the existing incompressible/original path already
              // delivers full content), 8/9 (fallback) stay observe-only: their
              // "execution" is already indistinguishable from existing behavior,
              // or deliberately deferred.
              generationMode: this.generationMode === "active" ? "active" : "observe",
              intent: planIntent ?? "unknown",
              role: planRole ?? "unknown",
              kind: plan.kind,
              reason: plan.reason,
              rule: plan.rule,
              ...(plan.strategyId ? { strategyId: plan.strategyId } : {}),
              confidence: plan.confidence,
              executed:
                this.generationMode === "active" &&
                (plan.rule === "rule-2-reuse" ||
                  plan.rule === "rule-4-structured" ||
                  plan.rule === "rule-5-reference" ||
                  plan.rule === "rule-6-window"),
            },
          }
        : {}),
      ...(repeatedWorkEvidence ? { repeatedWork: repeatedWorkEvidence } : {}),
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
      // This exact locator was already retrieved this session — the clearest
      // "contained-read" signal (Phase 5), computed BEFORE the generic
      // recordRetrieval call below so it lands in the same ledger row.
      const repeated = this.observeRetrievalRepeat(req.objectId, req.locator);
      await this.recordRetrieval(
        req.sessionId,
        eventId,
        req.locator,
        "delivered",
        req.reason,
        this.ctx.estimateTokens(cached),
        undefined,
        repeated,
      );
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

    // Computed BEFORE `this.retrieved.set()` below, so this locator is not
    // counted as its own "prior" retrieval (Phase 5 — contained/overlapping-read
    // against locators retrieved EARLIER this session, for the same object).
    const repeated = this.observeRetrievalRepeat(req.objectId, req.locator);
    const text = metadata.text;
    this.retrieved.set(cacheKey, text);
    const tokens = this.ctx.estimateTokens(text);
    await this.recordRetrieval(req.sessionId, eventId, req.locator, "delivered", req.reason, tokens, undefined, repeated);
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
    repeatedWork?: { type: string; count: number; estimatedAvoidableTokens?: number; hint?: string },
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
      ...(repeatedWork ? { repeatedWork } : {}),
    };
    await this.ledger.record(row);
  }

  /** v0.5.0 Repeated Work Observation for a successful retrieval (Phase 5). */
  private observeRetrievalRepeat(
    objectId: string,
    locator: string,
  ): { type: string; count: number; estimatedAvoidableTokens?: number; hint?: string } | undefined {
    if (this.generationMode === "off") return undefined;
    const prefix = `${objectId}#`;
    const priorLocators = [...this.retrieved.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
    const event = this.repeatedWork.observeRetrieval(objectId, locator, priorLocators);
    if (!event) return undefined;
    const hint = this.repeatedWork.shouldHint(objectId, event.type, event.count) ? repeatedWorkHint(event.type) : undefined;
    return {
      type: event.type,
      count: event.count,
      ...(event.estimatedAvoidableTokens === undefined ? {} : { estimatedAvoidableTokens: event.estimatedAvoidableTokens }),
      ...(hint ? { hint } : {}),
    };
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

/**
 * v0.5.0 Rule 5 (reference) executor: unlike `safeWindow`, keeps NO head/tail —
 * the whole content is one omission, retrievable via the existing bounded
 * retrieval path. Used only for content the Planner judged `reference`-role and
 * large (Rule 5 requires the content NOT be small); a genuinely small object
 * never reaches this function because Rule 3/7 would already have delivered it
 * in full. The short notice text still passes the exact-output rescan like any
 * other candidate; the omitted content is only ever revealed through
 * `retrieveByObject`, which re-applies the CURRENT privacy/secret policy.
 */
export function referenceOnly(text: string): { text: string; omitted: { locator: string; text: string; lines: number } } {
  const lines = text.split("\n");
  if (lines.length <= 1) {
    const bytes = Buffer.byteLength(text, "utf8");
    const locator = `B0-B${bytes}`;
    return {
      text: `… ${bytes} bytes available via retrieval → retrieve ${locator} …`,
      omitted: { locator, text, lines: 1 },
    };
  }
  const locator = `L1-L${lines.length}`;
  return {
    text: `… ${lines.length} lines available via retrieval → retrieve ${locator} …`,
    omitted: { locator, text, lines: lines.length },
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
