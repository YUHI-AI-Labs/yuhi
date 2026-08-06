/**
 * Generation Cache (planner_contract.md §5). Distinct from the Prior Delivery
 * Ledger (types.ts's `PriorDelivery`, used by Rule 2): the ledger answers "was
 * this exact (object, revision) already delivered THIS session"; the cache
 * additionally encodes privacy mode, secret delivery mode, and intent as part of
 * the LOOKUP identity, so the invariant "privacy mode differs -> miss" is a
 * property of the key itself, not an accident of one runtime instance never
 * changing mode mid-life.
 *
 * `planKind`/`strategyVersion` are stored on the ENTRY, not hashed into the
 * lookup key: a plan's kind/strategy is the OUTPUT of planning, so a key that
 * required them as input would be circular for a Rule-2-style lookup that runs
 * BEFORE Rule 4 decides a strategy. A caller that already knows the strategy it
 * intends to reuse validates it against the entry after `get()` returns.
 */

import type { PrivacyMode, SecretDeliveryMode } from "@yuhi/shared";
import type { ContextIntent, ContextPlanKind } from "./types.js";

export interface GenerationCacheIdentity {
  readonly objectId: string;
  readonly revision: number;
  readonly privacyMode: PrivacyMode;
  readonly secretDeliveryMode: SecretDeliveryMode;
  readonly intent: ContextIntent;
}

export interface GenerationCacheEntry {
  readonly planKind: ContextPlanKind;
  readonly strategyVersion: string;
  readonly deliveredHash: string;
  readonly estimatedTokens: number;
  readonly exactCharacters: number;
}

export interface GenerationCacheStats {
  readonly hits: number;
  readonly misses: number;
}

function identityKey(id: GenerationCacheIdentity): string {
  return JSON.stringify([id.objectId, id.revision, id.privacyMode, id.secretDeliveryMode, id.intent]);
}

export class GenerationCache {
  private readonly entries = new Map<string, GenerationCacheEntry>();
  private hits = 0;
  private misses = 0;

  /** Looks up by identity only. Caller validates `strategyVersion` if it cares (a
   *  compressor version bump must invalidate its own cache entries — rule 5). */
  get(id: GenerationCacheIdentity): GenerationCacheEntry | undefined {
    const hit = this.entries.get(identityKey(id));
    if (hit) this.hits += 1;
    else this.misses += 1;
    return hit;
  }

  /** Looks up AND validates the strategy version in one call — the common case. */
  getValid(id: GenerationCacheIdentity, currentStrategyVersion: string): GenerationCacheEntry | undefined {
    const entry = this.entries.get(identityKey(id));
    if (!entry || entry.strategyVersion !== currentStrategyVersion) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry;
  }

  set(id: GenerationCacheIdentity, entry: GenerationCacheEntry): void {
    this.entries.set(identityKey(id), entry);
  }

  stats(): GenerationCacheStats {
    return { hits: this.hits, misses: this.misses };
  }
}
