/**
 * Live-zone bookkeeping (spec §5).
 *
 * Claude Code keeps its own transcript and re-sends every earlier tool_result on each
 * turn. Without state, Yuhi would recompress the same block every turn and could emit
 * different bytes — invalidating the provider's cached prefix and raising cost while
 * "reducing tokens". So each (tool_use_id, raw hash) is remembered with the EXACT bytes
 * delivered, and the compact bytes themselves are stored as an object so a gateway
 * restart reproduces them byte-identically.
 */

import { createHash } from "node:crypto";

import type { ContextStore, ObjectId, SessionId } from "@yuhi/context-store";
import { EvidenceLedger, type DeliveredBlockRecord } from "@yuhi/context-runtime";

export interface RememberInput {
  readonly toolUseId: string;
  readonly rawHash: string;
  readonly rawObjectId: ObjectId;
  readonly text: string;
  readonly strategy: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export class PrefixState {
  private readonly blocks = new Map<string, DeliveredBlockRecord>();
  private readonly texts = new Map<string, string>();

  private constructor(
    private readonly store: ContextStore,
    private readonly ledger: EvidenceLedger,
    private readonly sessionId: SessionId,
    private readonly now: () => string,
  ) {}

  static async load(store: ContextStore, sessionId: SessionId, now: () => string): Promise<PrefixState> {
    const state = new PrefixState(store, new EvidenceLedger(store), sessionId, now);
    for (const row of await state.ledger.rows(sessionId)) {
      if (row.type !== "delivered-block") continue;
      state.blocks.set(key(row.toolUseId, row.rawHash), row);
    }
    return state;
  }

  get knownBlocks(): number {
    return this.blocks.size;
  }

  /** The bytes previously delivered for this exact block, if any. */
  async lookup(toolUseId: string, rawHash: string): Promise<{ text: string; record: DeliveredBlockRecord } | undefined> {
    const k = key(toolUseId, rawHash);
    const record = this.blocks.get(k);
    if (!record) return undefined;
    const cached = this.texts.get(k);
    if (cached !== undefined) return { text: cached, record };
    try {
      const bytes = await this.store.get(this.sessionId, record.compactObjectId);
      const text = bytes.toString("utf8");
      this.texts.set(k, text);
      return { text, record };
    } catch {
      // The compact object was collected: treat the block as new rather than guessing.
      this.blocks.delete(k);
      return undefined;
    }
  }

  async remember(input: RememberInput): Promise<DeliveredBlockRecord> {
    const compact = await this.store.put(this.sessionId, input.text, "text");
    const record: DeliveredBlockRecord = {
      type: "delivered-block",
      sessionId: this.sessionId,
      timestamp: this.now(),
      toolUseId: input.toolUseId,
      rawHash: input.rawHash,
      rawObjectId: input.rawObjectId,
      compactObjectId: compact.objectId,
      strategy: input.strategy,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter,
    };
    await this.ledger.record(record);
    const k = key(input.toolUseId, input.rawHash);
    this.blocks.set(k, record);
    this.texts.set(k, input.text);
    return record;
  }
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function key(toolUseId: string, rawHash: string): string {
  return `${toolUseId}#${rawHash}`;
}
