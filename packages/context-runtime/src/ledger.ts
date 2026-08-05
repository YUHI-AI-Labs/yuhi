/**
 * Evidence ledger (spec §14). Every transformation records original hash, compressed
 * hash, strategy, preserved anchors, removed elements, retrieval count, safety
 * findings and delivery path — so every answer is explainable.
 *
 * Append-only JSONL inside the store, which also makes ledger references gc roots:
 * a delivered payload stays explainable after its session is dropped.
 */

import type { Omission, RemovedSummary } from "@yuhi/context-compression";
import type { ContentKind, ContextStore, ObjectId, SessionId } from "@yuhi/context-store";

import type { ContextEventId, ToolName } from "./event.js";
import type { PublicFinding } from "./safety.js";

export type DeliveryPath = "delivered" | "delivered-original" | "delivered-fallback" | "withheld";

/**
 * Availability failures (compressor error/timeout/absent) may degrade to a scanned
 * representation; SECURITY failures never may. Keeping the classes distinct is why
 * §7 forbids handling both with one fail-open path.
 */
export type FailureClass = "availability" | "security";

export interface EvidenceRecord {
  readonly type: "delivery";
  readonly eventId: ContextEventId;
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly tool: ToolName;
  readonly kind: ContentKind;
  readonly timestamp: string;
  readonly objectId: ObjectId;
  readonly revision: number;
  readonly originalHash: string;
  readonly deliveredHash: string;
  /** `compressorId@version`, `original`, or `withheld`. */
  readonly strategy: string;
  readonly anchors: readonly string[];
  readonly removed: readonly RemovedSummary[];
  readonly omissions: readonly LedgerOmission[];
  readonly safetyFindings: readonly PublicFinding[];
  /**
   * sha256 prefixes of detected secret values — NEVER the values. Lets the ledger show that
   * a finding recurred, and lets the egress guard correlate, without storing a credential.
   */
  readonly secretFingerprints?: readonly string[];
  /** Which delivery policy governed this delivery (`developer` | `strict`). */
  readonly deliveryPolicy?: string;
  /** Categories of key material masked before delivery, in any mode. Kinds only. */
  readonly keyMaterialMasked?: readonly string[];
  /** Privacy Mode governing this delivery (v0.4.8) — `balanced` | `strict` | `trusted-local`. */
  readonly privacyMode?: string;
  /** What a detected secret meant for THIS delivery — `redact` | `developer-delivery`. */
  readonly secretDeliveryMode?: string;
  /** Direct personal identifiers found by the pre-delivery transform. Never a value. */
  readonly directIdentifiersDetected?: number;
  /** Direct personal identifiers actually replaced (mask-on-detect: normally equal to
   *  `directIdentifiersDetected`; 0/0 in Trusted Local, where nothing is scanned). */
  readonly directIdentifiersTransformed?: number;
  /** Direct personal identifiers found by the POST-delivery residue rescan. */
  readonly directIdentifierResidue?: number;
  readonly privacyTransformationApplied?: boolean;
  readonly privacyVerificationPassed?: boolean;
  /** Set only when privacy verification failed and the delivery/retrieval was withheld. */
  readonly privacyFallback?: string;
  readonly secretRedactions: number;
  readonly metadataRedactions: number;
  readonly metadataLabels: readonly string[];
  readonly deliveryPath: DeliveryPath;
  readonly withheldReason?: string;
  readonly failureClass?: FailureClass;
  /** Which degraded representation was delivered, when the path was a fallback. */
  readonly fallback?: "safe-window" | "scanned-original";
  /** Correlates a delivery with the agent's `tool_use_id` (gateway live zone). */
  readonly toolUseId?: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /** True when these bytes were replayed from an earlier identical delivery. */
  readonly prefixStable: boolean;
  /** True when recomputation diverged and the earlier bytes were kept (see §2). */
  readonly recomputeDiverged?: boolean;
  /**
   * v0.5.0 Planner evidence (docs/design/0.5.0_planner_contract.md §7): a safe,
   * closed-enum summary of what the Planner decided and why. NEVER a reason to
   * distrust `strategy`/`deliveryPath` above — in `"observe"` mode `executed` is
   * always `false`, meaning this plan was computed for evidence only and did not
   * influence the bytes actually delivered.
   */
  readonly plan?: PlanEvidence;
  /**
   * v0.5.0 Repeated Work Observation (docs/design/0.5.0_planner_contract.md §6).
   * Recorded unconditionally when detected (advisory only — never a forced
   * block). `hint` is populated only when this specific (object, type) pair
   * crossed the one-hint-per-pair threshold for the first time.
   */
  readonly repeatedWork?: RepeatedWorkEvidence;
}

export interface RepeatedWorkEvidence {
  readonly type: string;
  readonly count: number;
  readonly estimatedAvoidableTokens?: number;
  readonly hint?: string;
}

export interface PlanEvidence {
  readonly generationMode: "observe" | "active";
  readonly intent: string;
  readonly role: string;
  readonly kind: string;
  readonly reason: string;
  readonly rule: string;
  readonly strategyId?: string;
  readonly confidence: "high" | "medium" | "low";
  /** True only when `generationMode` is `"active"` AND this plan drove delivery. */
  readonly executed: boolean;
}

export interface LedgerOmission {
  readonly locator: string;
  readonly kind: string;
  readonly tokensOmitted: number;
  readonly items?: number;
}

export interface RetrievalRecord {
  readonly type: "retrieval";
  readonly eventId: ContextEventId;
  readonly sessionId: SessionId;
  readonly timestamp: string;
  readonly locator: string;
  readonly outcome: "delivered" | "withheld";
  readonly reason?: string;
  readonly tokensDelivered: number;
  /** v0.5.0 Repeated Work Observation for this retrieval (contained/overlapping-read). */
  readonly repeatedWork?: RepeatedWorkEvidence;
}

/**
 * A tool_result block already delivered to the provider. Persisted so a gateway
 * restart reproduces the SAME compact bytes for the same block: the provider prefix
 * (and therefore its cache) must not change because Yuhi was restarted.
 */
export interface DeliveredBlockRecord {
  readonly type: "delivered-block";
  readonly sessionId: SessionId;
  readonly timestamp: string;
  readonly toolUseId: string;
  /** sha256 of the RAW tool_result text, so a changed block is treated as new. */
  readonly rawHash: string;
  readonly rawObjectId: ObjectId;
  /** The compact bytes, stored as an object (content-addressed, gc-rooted). */
  readonly compactObjectId: ObjectId;
  readonly strategy: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

/**
 * An observation that a secret Yuhi delivered appeared on an OUTBOUND path — an assistant
 * response, a generated patch, a commit or issue body, an external request. v0.4.0 detects,
 * warns and audits; a future Enterprise Strict Mode blocks or requires approval.
 *
 * Carries fingerprints and counts only, exactly like every other row.
 */
export interface EgressDetectionRecord {
  readonly type: "egress-detection";
  readonly sessionId: SessionId;
  readonly timestamp: string;
  /** `response` (model output) or `request` (something the agent is about to send/write). */
  readonly direction: "response" | "request";
  readonly surface: string;
  readonly fingerprints: readonly string[];
  readonly occurrences: number;
}

export type LedgerRow = EvidenceRecord | RetrievalRecord | DeliveredBlockRecord | EgressDetectionRecord;

export function toLedgerOmissions(omissions: readonly Omission[]): LedgerOmission[] {
  return omissions.map((o) => ({
    locator: o.locator,
    kind: o.kind,
    tokensOmitted: o.tokensOmitted,
    ...(o.items === undefined ? {} : { items: o.items }),
  }));
}

export interface Explanation {
  readonly record: EvidenceRecord;
  readonly retrievalCount: number;
  readonly retrievals: readonly RetrievalRecord[];
  /** What is retrievable and how — the user-facing half of `yuhi_explain`. */
  readonly retrievable: readonly LedgerOmission[];
}

export class EvidenceLedger {
  constructor(private readonly store: ContextStore) {}

  async record(row: LedgerRow): Promise<void> {
    await this.store.appendEvidence(row.sessionId, row);
  }

  async rows(session: SessionId): Promise<LedgerRow[]> {
    return (await this.store.readEvidence(session)) as LedgerRow[];
  }

  async find(session: SessionId, eventId: ContextEventId): Promise<EvidenceRecord | undefined> {
    const rows = await this.rows(session);
    // Last write wins: a re-delivery of the same event supersedes earlier rows.
    let found: EvidenceRecord | undefined;
    for (const row of rows) {
      if (row.type === "delivery" && row.eventId === eventId) found = row;
    }
    return found;
  }

  async explain(session: SessionId, eventId: ContextEventId): Promise<Explanation | undefined> {
    const record = await this.find(session, eventId);
    if (!record) return undefined;
    const retrievals = (await this.rows(session)).filter(
      (r): r is RetrievalRecord => r.type === "retrieval" && r.eventId === eventId,
    );
    return {
      record,
      retrievalCount: retrievals.length,
      retrievals,
      retrievable: record.omissions,
    };
  }
}

export interface RetrievalTally {
  readonly delivered: number;
  readonly withheld: number;
  readonly tokensDelivered: number;
  readonly locators: readonly string[];
}

/**
 * Count retrievals for a session from the ledger.
 *
 * The MCP retrieval server runs in its own process (the agent starts it), so an
 * in-process counter in the gateway would always report zero. The ledger is the shared
 * source of truth, which is exactly why retrievals are recorded there.
 */
export async function tallyRetrievals(store: ContextStore, session: SessionId): Promise<RetrievalTally> {
  const rows = (await store.readEvidence(session)) as LedgerRow[];
  let delivered = 0;
  let withheld = 0;
  let tokensDelivered = 0;
  const locators: string[] = [];
  for (const row of rows) {
    if (row.type !== "retrieval") continue;
    if (row.outcome === "delivered") {
      delivered++;
      tokensDelivered += row.tokensDelivered;
      locators.push(row.locator);
    } else {
      withheld++;
    }
  }
  return { delivered, withheld, tokensDelivered, locators };
}

export interface GenerationPlanTally {
  readonly total: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly executed: number;
  readonly repeatedWorkEvents: number;
  readonly repeatedWorkHints: number;
}

/**
 * v0.5.0 CLI stats (directive §19's "Generation plans: 18 / Reused: 7 /
 * Structured: 4 / ..." example). Reads plan/repeatedWork evidence directly from
 * the ledger — no separate live counter needed, matching `tallyRetrievals`'s own
 * pattern (evidence is already the durable source of truth; a gateway restart
 * must not lose these counts).
 */
export async function tallyGenerationPlans(store: ContextStore, session: SessionId): Promise<GenerationPlanTally> {
  const rows = (await store.readEvidence(session)) as LedgerRow[];
  let total = 0;
  let executed = 0;
  let repeatedWorkEvents = 0;
  let repeatedWorkHints = 0;
  const byKind: Record<string, number> = {};
  for (const row of rows) {
    if (row.type === "delivery" && row.plan) {
      total += 1;
      byKind[row.plan.kind] = (byKind[row.plan.kind] ?? 0) + 1;
      if (row.plan.executed) executed += 1;
    }
    if ((row.type === "delivery" || row.type === "retrieval") && row.repeatedWork) {
      repeatedWorkEvents += 1;
      if (row.repeatedWork.hint) repeatedWorkHints += 1;
    }
  }
  return { total, byKind, executed, repeatedWorkEvents, repeatedWorkHints };
}
