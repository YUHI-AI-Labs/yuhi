/**
 * Planner Rules v1 (planner_contract.md §3) — a literal top-to-bottom if/else
 * chain, not a scoring system, so "why did the planner pick this" is always "the
 * first rule that matched," readable directly from `ContextPlan.rule`.
 *
 * Rule 9 is not a new behavior: it is calling the SAME compressor registry
 * `ContextRuntime.deliver()` already calls in v0.4.8. A test
 * (`rules.test.ts` — "Rule 9 fallback is byte-identical to v0.4") pins this.
 */

import type { PlannerInput, ContextPlan, PlanConfidence } from "./types.js";

/**
 * "Small" absent an explicit budget target. Used ONLY as Rule 3's cutoff when no
 * `RuntimeBudgetState` is configured — never exposed as a public default (the
 * directive explicitly says not to fix 8,000/16,000 as defaults yet; this is a
 * much smaller, internal "trivially fits" threshold, unrelated to that decision).
 */
const RULE3_SMALL_TOKENS_UNBUDGETED = 2_000;

function fitsSmall(input: PlannerInput): boolean {
  const target = input.budget?.target;
  if (target !== undefined) return input.measurement.estimatedTokens <= target;
  return input.measurement.estimatedTokens <= RULE3_SMALL_TOKENS_UNBUDGETED;
}

function fitsMaximum(input: PlannerInput): boolean {
  const maximum = input.budget?.maximum;
  if (maximum === undefined) return true;
  return input.measurement.estimatedTokens <= maximum;
}

function structuredCompressorAvailable(input: PlannerInput): boolean {
  return input.compressors.some(
    (c) => c.id !== "text-window" && c.id !== "generic-text" && c.supportsKind(input.contentType),
  );
}

function findPriorDelivery(input: PlannerInput): PlannerInput["priorDeliveries"][number] | undefined {
  return input.priorDeliveries.find(
    (d) => d.objectId === input.objectId && d.revision === input.revision,
  );
}

export function planWithRules(input: PlannerInput): ContextPlan {
  const measurement = input.measurement;

  // Rule 1 — privacy/security failure → withhold. Computed upstream (the runtime's
  // own scan/residue-rescan verdict); the planner never re-derives it.
  if (input.privacyOrSecurityFailure) {
    return {
      kind: "withhold",
      reason: "privacy-failure",
      estimatedBefore: measurement,
      confidence: "high",
      rule: "rule-1-privacy-failure",
    };
  }

  // Rule 2 — same object/revision/representation already delivered → reuse.
  const prior = findPriorDelivery(input);
  if (prior) {
    return {
      kind: "reuse",
      reason: "already-delivered",
      reuseObjectId: prior.objectId,
      estimatedBefore: measurement,
      estimatedAfter: { estimatedTokens: prior.estimatedTokens, exactCharacters: prior.exactCharacters },
      confidence: "high",
      rule: "rule-2-reuse",
    };
  }

  // Rule 3 — small + load-bearing → full.
  if (input.role === "load-bearing" && fitsSmall(input)) {
    return {
      kind: "full",
      reason: "load-bearing",
      estimatedBefore: measurement,
      estimatedAfter: measurement,
      confidence: "high",
      rule: "rule-3-small-load-bearing",
    };
  }

  // Rule 4 — a verified structured compressor is available → structured.
  // ("Verified" here means the compressor DECLARES support for this content type;
  // the actual verify() postcondition still runs downstream at execution time —
  // the planner picking `structured` is a routing decision, not a guarantee that
  // compression will succeed. A failure at execution falls through to Rule 9's
  // exact v0.4 behavior, which already handles compressor failure safely.)
  if (structuredCompressorAvailable(input)) {
    return {
      kind: "structured",
      reason: "structured-representation",
      estimatedBefore: measurement,
      confidence: confidenceFor(input),
      rule: "rule-4-structured",
    };
  }

  // Rule 5 — large + retrieval available + reference role → reference.
  if (input.role === "reference" && input.retrievalAvailable && !fitsSmall(input)) {
    return {
      kind: "reference",
      reason: "retrievable-later",
      estimatedBefore: measurement,
      confidence: confidenceFor(input),
      rule: "rule-5-reference",
    };
  }

  // Rule 6 — large prose/source → window.
  if (
    (input.contentType === "text" || input.contentType === "markdown" || input.contentType === "log" || input.contentType === "source") &&
    !fitsSmall(input)
  ) {
    return {
      kind: "window",
      reason: input.budget ? "budget-pressure" : "fits-budget",
      estimatedBefore: measurement,
      confidence: confidenceFor(input),
      rule: "rule-6-window",
    };
  }

  // Rule 7 — fits maximum → full.
  if (fitsMaximum(input)) {
    return {
      kind: "full",
      reason: "fits-budget",
      estimatedBefore: measurement,
      estimatedAfter: measurement,
      confidence: confidenceFor(input),
      rule: "rule-7-fits-maximum",
    };
  }

  // Rule 8 — UNKNOWN intent/role AND exceeds the configured maximum → the safest
  // way to shrink WITHOUT dropping load-bearing content silently: prefer reference
  // when retrieval is available (fully recoverable), else a window (still recoverable
  // via the omission's locator). The "unknown" qualifier is load-bearing: a
  // CLASSIFIED delivery that exceeds maximum but matched none of Rules 3-6 falls
  // through to Rule 9 instead, deliberately — see that rule's comment.
  if ((input.intent === "unknown" || input.role === "unknown") && !fitsMaximum(input)) {
    return {
      kind: input.retrievalAvailable ? "reference" : "window",
      reason: "budget-pressure",
      estimatedBefore: measurement,
      confidence: "low",
      rule: "rule-8-safe-fallback",
    };
  }

  // Rule 9 — fallback to existing v0.4 behavior. This is not a distinct code path:
  // the caller (ContextRuntime.deliver) executes the SAME compressWithFallback()
  // call it always has when it sees this rule. Recorded so evidence can show that
  // no earlier rule applied, not silently defaulting. Reachable for a CLASSIFIED
  // delivery that exceeds the maximum (so Rule 7 does not apply) but matched none
  // of Rules 2-6 (so there is no more specific plan) — e.g. a large, classified,
  // non-prose/non-structured/non-reference content type. Deliberately narrow: most
  // deliveries resolve well before this line.
  return {
    kind: "structured",
    reason: "unknown",
    estimatedBefore: measurement,
    confidence: "low",
    rule: "rule-9-v0.4-fallback",
  };
}

function confidenceFor(input: PlannerInput): PlanConfidence {
  if (input.intent === "unknown" && input.role === "unknown") return "low";
  if (input.intent === "unknown" || input.role === "unknown") return "medium";
  return "high";
}
