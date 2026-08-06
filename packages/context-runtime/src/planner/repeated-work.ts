/**
 * Repeated Work Observation (planner_contract.md §6). Advisory only, per the
 * directive: events are recorded into stats/evidence unconditionally, but there
 * is no forced block and no injected hint text into delivered tool_result bytes
 * in this Release Candidate — see the scope note below.
 *
 * Reads the SAME Planner ledger `ContextRuntime` already maintains
 * (`priorDeliveries`) — no second bookkeeping structure for "was this object
 * already delivered."
 */

import { locatorWithin, parseLocator } from "../locator.js";
import type { ToolName } from "../event.js";

export type RepeatedWorkType =
  | "exact-read"
  | "contained-read"
  | "overlapping-read"
  | "exact-search"
  | "exact-command"
  | "premature-full-suite";

export interface RepeatedWorkEvent {
  readonly type: RepeatedWorkType;
  readonly count: number;
  readonly estimatedAvoidableTokens?: number;
}

export interface RepeatedWorkStats {
  readonly byType: Readonly<Record<RepeatedWorkType, number>>;
  readonly totalEstimatedAvoidableTokens: number;
  /** (objectId, type) pairs a high-confidence hint has already been emitted for. */
  readonly hintedPairs: number;
}

function toolToDeliveryType(tool: ToolName): RepeatedWorkType | undefined {
  if (tool === "read") return "exact-read";
  if (tool === "grep" || tool === "glob" || tool === "search") return "exact-search";
  if (tool === "bash") return "exact-command";
  return undefined;
}

/**
 * Session/runtime-scoped tracker. Deliberately NOT a singleton or module-level
 * state: one instance per `ContextRuntime`, matching `priorDeliveries`'s own
 * lifetime (planner_contract.md §6).
 */
export class RepeatedWorkTracker {
  private readonly counts = new Map<string, number>();
  private readonly hinted = new Set<string>();
  private totalAvoidableTokens = 0;

  /**
   * Called once per `deliver()` for content the caller already knows was
   * previously delivered this session (`priorDeliveries.has(key)`). Returns the
   * event to record in evidence, or `undefined` for a tool this observation
   * doesn't cover (e.g. `test`, `mcp`, `conversation`).
   */
  observeDelivery(tool: ToolName, objectId: string, estimatedTokens: number): RepeatedWorkEvent | undefined {
    const type = toolToDeliveryType(tool);
    if (!type) return undefined;
    const key = `${objectId}:${type}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    this.totalAvoidableTokens += estimatedTokens;
    return { type, count, estimatedAvoidableTokens: estimatedTokens };
  }

  /**
   * Called for a retrieval request, comparing the requested locator against
   * every locator already retrieved for the same object this session. Contained
   * (a strict subset of a prior retrieval) and overlapping (neither subset nor
   * disjoint) are both signals of re-fetching data the agent already has.
   */
  observeRetrieval(
    objectId: string,
    requestedLocator: string,
    priorRetrievedLocators: readonly string[],
  ): RepeatedWorkEvent | undefined {
    const requested = parseLocator(requestedLocator);
    if (!requested || requested.kind === "json") return undefined;
    let type: RepeatedWorkType | undefined;
    for (const raw of priorRetrievedLocators) {
      const prior = parseLocator(raw);
      if (!prior || prior.kind !== requested.kind) continue;
      if (raw === requestedLocator) {
        type = "contained-read"; // exact repeat of a prior retrieval range
        break;
      }
      if (locatorWithin(requested, prior)) {
        type = "contained-read";
        break;
      }
      if (
        requested.kind === "lines" &&
        prior.kind === "lines" &&
        requested.from <= prior.to &&
        requested.to >= prior.from
      ) {
        type = type ?? "overlapping-read";
      }
      if (
        requested.kind === "bytes" &&
        prior.kind === "bytes" &&
        requested.from <= prior.to &&
        requested.to >= prior.from
      ) {
        type = type ?? "overlapping-read";
      }
    }
    if (!type) return undefined;
    const key = `${objectId}:${type}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return { type, count };
  }

  /**
   * A high-confidence hint is offered at most once per (objectId, type) pair —
   * directive §11's "同じhintを繰り返さないでください". Threshold `count >= 2`:
   * a first occurrence is not yet "repeated."
   */
  shouldHint(objectId: string, type: RepeatedWorkType, count: number): boolean {
    if (count < 2) return false;
    const key = `${objectId}:${type}`;
    if (this.hinted.has(key)) return false;
    this.hinted.add(key);
    return true;
  }

  stats(): RepeatedWorkStats {
    const byType: Record<RepeatedWorkType, number> = {
      "exact-read": 0,
      "contained-read": 0,
      "overlapping-read": 0,
      "exact-search": 0,
      "exact-command": 0,
      "premature-full-suite": 0,
    };
    for (const [key, count] of this.counts) {
      const type = key.split(":").pop() as RepeatedWorkType;
      byType[type] = (byType[type] ?? 0) + count;
    }
    return {
      byType,
      totalEstimatedAvoidableTokens: this.totalAvoidableTokens,
      hintedPairs: this.hinted.size,
    };
  }
}

/** A short, non-repeating hint string (directive §11's own example). */
export function repeatedWorkHint(type: RepeatedWorkType): string {
  switch (type) {
    case "exact-read":
    case "contained-read":
      return "Yuhi note: this exact range was already delivered unchanged.";
    case "overlapping-read":
      return "Yuhi note: part of this range was already delivered unchanged.";
    case "exact-search":
      return "Yuhi note: this exact search was already run this session.";
    case "exact-command":
      return "Yuhi note: this exact command was already run this session with no state change since.";
    case "premature-full-suite":
      return "Yuhi note: consider a narrower test run before the full suite.";
  }
}
