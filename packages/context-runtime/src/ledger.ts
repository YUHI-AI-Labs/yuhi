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

export type DeliveryPath = "delivered" | "delivered-original" | "withheld";

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
  readonly secretRedactions: number;
  readonly metadataRedactions: number;
  readonly metadataLabels: readonly string[];
  readonly deliveryPath: DeliveryPath;
  readonly withheldReason?: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /** True when these bytes were replayed from an earlier identical delivery. */
  readonly prefixStable: boolean;
  /** True when recomputation diverged and the earlier bytes were kept (see §2). */
  readonly recomputeDiverged?: boolean;
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
}

export type LedgerRow = EvidenceRecord | RetrievalRecord;

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
