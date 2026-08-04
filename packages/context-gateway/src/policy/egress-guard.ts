/**
 * Egress guard (v0.4.0 — detect, warn, audit).
 *
 * Developer Mode lets a credential reach the agent on purpose. The risk that creates is not
 * the agent READING it, it is the value coming back out: pasted into an answer, a generated
 * patch, a commit or issue body, or an outbound request. This watches for exactly that.
 *
 * Design constraints:
 *  - **Never stores a value it was not already given.** Values live in memory for the life
 *    of the session because matching requires them; nothing is written anywhere. Evidence
 *    records fingerprints and counts only.
 *  - **Never blocks in v0.4.0.** It detects, warns, and audits. A future Enterprise Strict
 *    Mode turns the same signal into redaction or an approval prompt — which is why the
 *    verdict is a value the caller acts on, not a side effect performed here.
 *  - **Must not break local work.** Editing a file that legitimately contains the secret, or
 *    running a command that needs it, is the developer's intent; the guard records that the
 *    value crossed an outbound surface and leaves the action alone.
 */

import { createHash } from "node:crypto";

/** Fingerprint identical to the runtime's, so ledger rows correlate across packages. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

export type EgressDirection = "response" | "request";

export interface EgressHit {
  readonly fingerprint: string;
  readonly occurrences: number;
}

export interface EgressVerdict {
  readonly detected: boolean;
  readonly direction: EgressDirection;
  readonly surface: string;
  readonly hits: readonly EgressHit[];
  /** Total occurrences across all watched values. */
  readonly occurrences: number;
}

/** Shortest value worth watching: below this, false positives swamp the signal. */
const MIN_WATCHED_LENGTH = 12;

export class EgressGuard {
  /** value → fingerprint. In memory only, for the life of the session. */
  private readonly watched = new Map<string, string>();

  /**
   * Remember the secret values Yuhi delivered, so their reappearance on an outbound
   * surface is recognisable. Called with content the agent has ALREADY been given.
   */
  watch(values: readonly string[]): void {
    for (const value of values) {
      if (value.length < MIN_WATCHED_LENGTH) continue;
      if (!this.watched.has(value)) this.watched.set(value, fingerprint(value));
    }
  }

  get watchedCount(): number {
    return this.watched.size;
  }

  /**
   * Look for watched values in text about to leave. Returns fingerprints and counts — the
   * caller can log or evidence the verdict directly without risking a value.
   */
  scan(text: string, direction: EgressDirection, surface: string): EgressVerdict {
    const hits: EgressHit[] = [];
    let occurrences = 0;
    if (text.length > 0) {
      for (const [value, fp] of this.watched) {
        const count = countOccurrences(text, value);
        if (count === 0) continue;
        hits.push({ fingerprint: fp, occurrences: count });
        occurrences += count;
      }
    }
    return { detected: hits.length > 0, direction, surface, hits, occurrences };
  }

  /** The warning shown to the user. Names the surface and the count, never the value. */
  static warning(verdict: EgressVerdict): string {
    return [
      `Yuhi: a secret value delivered in this session appeared in an outbound ${verdict.direction} (${verdict.surface}),`,
      `${verdict.occurrences} time(s) across ${verdict.hits.length} distinct value(s).`,
      "Developer Mode detects and records this; it does not block it. Review before sharing or committing.",
    ].join(" ");
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
