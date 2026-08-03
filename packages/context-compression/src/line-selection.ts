/**
 * Shared machinery for line-oriented compressors (slices 3A and 3B).
 *
 * These compressors do not window a contiguous middle: they drop scattered lines
 * (passing tests, duplicate warnings, repeated frames, duplicate grep hits). Every
 * dropped line must still be retrievable, so consecutive dropped lines are coalesced
 * into `L<from>-L<to>` ranges — the same locator grammar the store already resolves.
 *
 * The result is deterministic: identical input lines always produce identical output.
 */

import type { ObjectId } from "@yuhi/context-store";

import type { Omission, RemovedSummary } from "./contract.js";

export type LineDecision = { readonly keep: true } | { readonly keep: false; readonly reason: string };

export const KEEP: LineDecision = { keep: true };

export function drop(reason: string): LineDecision {
  return { keep: false, reason };
}

export interface CoalesceInput {
  readonly lines: readonly string[];
  /** 1-indexed line numbers that were NOT delivered. */
  readonly droppedLines: readonly number[];
  readonly objectId: ObjectId;
  readonly estimateTokens: (text: string) => number;
  /** Dropped-line reasons keyed by 1-indexed line number, for the removed summary. */
  readonly reasons?: ReadonlyMap<number, string>;
}

export interface CoalesceResult {
  readonly omissions: Omission[];
  readonly removed: RemovedSummary[];
  /** Rendered `… n lines omitted …` markers keyed by the line they replace. */
  readonly markers: Map<number, string>;
}

/**
 * Turn a set of dropped line numbers into retrievable ranges plus the markers that
 * stand in for them. A marker is emitted at the FIRST line of each run, so the view
 * keeps the original ordering of what remains.
 */
export function coalesceDroppedLines(input: CoalesceInput): CoalesceResult {
  const dropped = [...new Set(input.droppedLines)].sort((a, b) => a - b);
  const omissions: Omission[] = [];
  const markers = new Map<number, string>();
  const removedCounts = new Map<string, number>();

  let runStart: number | undefined;
  let previous: number | undefined;

  const flush = (): void => {
    if (runStart === undefined || previous === undefined) return;
    const from = runStart;
    const to = previous;
    const count = to - from + 1;
    const text = input.lines.slice(from - 1, to).join("\n");
    const reasons = summarizeReasons(input.reasons, from, to);
    const locator = `L${from}-L${to}`;
    omissions.push({
      objectId: input.objectId,
      locator,
      kind: "omitted-lines",
      tokensOmitted: input.estimateTokens(text),
      items: count,
    });
    markers.set(from, `… ${count} line${count === 1 ? "" : "s"} omitted (${reasons}) → retrieve ${locator} …`);
    for (const reason of reasons.split(", ")) {
      removedCounts.set(reason, (removedCounts.get(reason) ?? 0) + count);
    }
    runStart = undefined;
    previous = undefined;
  };

  for (const line of dropped) {
    if (previous !== undefined && line === previous + 1) {
      previous = line;
      continue;
    }
    flush();
    runStart = line;
    previous = line;
  }
  flush();

  return {
    omissions,
    removed: [...removedCounts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),
    markers,
  };
}

function summarizeReasons(
  reasons: ReadonlyMap<number, string> | undefined,
  from: number,
  to: number,
): string {
  if (!reasons) return "omitted";
  const seen = new Set<string>();
  for (let line = from; line <= to; line++) {
    const reason = reasons.get(line);
    if (reason) seen.add(reason);
  }
  if (seen.size === 0) return "omitted";
  return [...seen].sort().join(", ");
}

/** Render the kept lines with markers substituted for each dropped run. */
export function renderSelection(
  lines: readonly string[],
  droppedSet: ReadonlySet<number>,
  markers: ReadonlyMap<number, string>,
): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    if (droppedSet.has(lineNumber)) {
      const marker = markers.get(lineNumber);
      if (marker) out.push(marker);
      continue;
    }
    out.push(lines[i] ?? "");
  }
  return out.join("\n");
}

/** Normalize a line for duplicate detection: digits, hex and timings collapse. */
export function normalizeForDuplicates(line: string): string {
  return line
    .replace(/0x[0-9a-f]+/gi, "0xHEX")
    .replace(/\b\d+(\.\d+)?(ms|s|m)\b/gi, "NUMt")
    .replace(/\b\d[\d_,.]*\b/g, "NUM")
    .replace(/\s+/g, " ")
    .trim();
}
