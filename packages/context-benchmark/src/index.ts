/**
 * Benchmark contract for v0.4.0 (spec §16–§18). Benchmark first; never optimize blindly.
 *
 * This module deliberately encodes the MEASUREMENT RULES as code, because §17's central
 * prohibition is easy to violate in a report and impossible to detect afterwards:
 *
 *   Repository reduction is NEVER reported as actual provider token reduction.
 *
 * `assertCostClaim` and `formatReduction` exist so that a reporting surface cannot
 * label a repository-level estimate as a token or cost saving without failing a test.
 */

export type Condition = "baseline" | "static-yuhi" | "dynamic-yuhi";

export const CONDITIONS: readonly Condition[] = ["baseline", "static-yuhi", "dynamic-yuhi"];

/** The §16 task suite. Minimum three runs each. */
export const TASKS = [
  "small-bug-fix",
  "refactor",
  "repository-exploration",
  "test-failure",
  "large-json",
  "large-html",
  "large-logs",
  "secret-fixture",
  "long-session-repeated-reads",
  "multi-file-edit",
] as const;

export type TaskId = (typeof TASKS)[number];

export const MIN_RUNS = 3;

/**
 * Measured provider usage. Cache columns are MANDATORY, not optional: a run whose raw
 * input tokens fall while cache-creation tokens rise can cost MORE. Without these two
 * fields the §18 "provider input 20–40% lower" criterion is unfalsifiable.
 */
export interface ProviderUsage {
  readonly inputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
  /** Only when the provider actually reports it. Never modelled from a price table. */
  readonly billedCost?: { readonly amount: number; readonly currency: string };
}

export interface SecurityOutcome {
  readonly secretExposure: number;
  readonly piiExposure: number;
  readonly metadataExposure: number;
  readonly brokenEditAnchors: number;
  readonly safeApplyRegressions: number;
  readonly sourceModifiedBeforeApply: number;
}

export interface DevelopmentOutcome {
  readonly taskSuccess: boolean;
  readonly testsPassed: boolean;
  readonly patchCorrect: boolean;
  readonly retrievalCount: number;
  readonly repeatedReads: number;
  readonly latencyOverheadMs: number;
}

export interface RunMetrics {
  readonly task: TaskId;
  readonly condition: Condition;
  readonly run: number;
  readonly provider: ProviderUsage;
  /** Estimate produced by `prepare`. NOT a provider measurement. */
  readonly repositoryStaticReduction?: number;
  /** Fraction of tool-output tokens the runtime withheld before delivery. Ours to claim. */
  readonly dynamicToolOutputReduction?: number;
  readonly development: DevelopmentOutcome;
  readonly security: SecurityOutcome;
}

export type ReductionKind = "repository-static" | "dynamic-tool-output" | "provider-input";

/** The only labels permitted for each measurement (§17, CLAUDE.md). */
export const REDUCTION_LABELS: Record<ReductionKind, string> = {
  "repository-static": "Estimated context reduction",
  "dynamic-tool-output": "Dynamic tool-output reduction",
  "provider-input": "Measured provider input tokens",
};

export function formatReduction(kind: ReductionKind, fraction: number): string {
  return `${REDUCTION_LABELS[kind]}: ${(fraction * 100).toFixed(1)}%`;
}

export class DishonestClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DishonestClaimError";
  }
}

/**
 * Guard for any surface about to say "cost", "savings" or "billing". Only a measured
 * provider figure with a real billed cost may back such a claim.
 */
export function assertCostClaim(kind: ReductionKind, usage: ProviderUsage | undefined): void {
  if (kind !== "provider-input") {
    throw new DishonestClaimError(
      `${REDUCTION_LABELS[kind]} is an estimate of repository or tool-output size; it must not be presented as a token or cost saving`,
    );
  }
  if (!usage?.billedCost) {
    throw new DishonestClaimError("A cost claim requires a provider-reported billed cost");
  }
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export interface ConditionSummary {
  readonly condition: Condition;
  readonly runs: number;
  readonly medianInputTokens: number;
  readonly medianCacheCreationTokens: number;
  readonly medianCacheReadTokens: number;
  readonly medianBilledCost?: number;
  readonly taskSuccessRate: number;
  readonly medianDynamicReduction: number;
  readonly medianLatencyOverheadMs: number;
  readonly security: SecurityOutcome;
}

export function summarizeCondition(condition: Condition, runs: readonly RunMetrics[]): ConditionSummary {
  const mine = runs.filter((r) => r.condition === condition);
  const costs = mine.map((r) => r.provider.billedCost?.amount).filter((c): c is number => c !== undefined);
  return {
    condition,
    runs: mine.length,
    medianInputTokens: median(mine.map((r) => r.provider.inputTokens)),
    medianCacheCreationTokens: median(mine.map((r) => r.provider.cacheCreationTokens)),
    medianCacheReadTokens: median(mine.map((r) => r.provider.cacheReadTokens)),
    ...(costs.length === mine.length && costs.length > 0 ? { medianBilledCost: median(costs) } : {}),
    taskSuccessRate: mine.length === 0 ? 0 : mine.filter((r) => r.development.taskSuccess).length / mine.length,
    medianDynamicReduction: median(mine.map((r) => r.dynamicToolOutputReduction ?? 0)),
    medianLatencyOverheadMs: median(mine.map((r) => r.development.latencyOverheadMs)),
    security: sumSecurity(mine),
  };
}

function sumSecurity(runs: readonly RunMetrics[]): SecurityOutcome {
  return runs.reduce<SecurityOutcome>(
    (acc, r) => ({
      secretExposure: acc.secretExposure + r.security.secretExposure,
      piiExposure: acc.piiExposure + r.security.piiExposure,
      metadataExposure: acc.metadataExposure + r.security.metadataExposure,
      brokenEditAnchors: acc.brokenEditAnchors + r.security.brokenEditAnchors,
      safeApplyRegressions: acc.safeApplyRegressions + r.security.safeApplyRegressions,
      sourceModifiedBeforeApply: acc.sourceModifiedBeforeApply + r.security.sourceModifiedBeforeApply,
    }),
    {
      secretExposure: 0,
      piiExposure: 0,
      metadataExposure: 0,
      brokenEditAnchors: 0,
      safeApplyRegressions: 0,
      sourceModifiedBeforeApply: 0,
    },
  );
}

export interface Criterion {
  readonly id: string;
  readonly target: string;
  readonly actual: string;
  readonly pass: boolean;
}

/**
 * Evaluate the §18 success criteria. A cost regression is reported as a FAILURE even
 * when raw input tokens fell — that is the CacheAligner failure mode, and hiding it
 * would let v0.4.0 ship a feature that raises the user's bill.
 */
export function evaluateSuccessCriteria(runs: readonly RunMetrics[]): Criterion[] {
  const baseline = summarizeCondition("baseline", runs);
  const dynamic = summarizeCondition("dynamic-yuhi", runs);
  const out: Criterion[] = [];

  const enoughRuns = CONDITIONS.every((c) => summarizeCondition(c, runs).runs >= MIN_RUNS);
  out.push({
    id: "minimum-runs",
    target: `>= ${MIN_RUNS} runs per condition`,
    actual: CONDITIONS.map((c) => `${c}=${summarizeCondition(c, runs).runs}`).join(", "),
    pass: enoughRuns,
  });

  const successDelta = dynamic.taskSuccessRate - baseline.taskSuccessRate;
  out.push({
    id: "task-success",
    target: ">= baseline - 2%",
    actual: `${(successDelta * 100).toFixed(1)}pp`,
    pass: successDelta >= -0.02,
  });

  const inputReduction =
    baseline.medianInputTokens === 0 ? 0 : 1 - dynamic.medianInputTokens / baseline.medianInputTokens;
  out.push({
    id: "provider-input-reduction",
    target: "20-40% lower (median)",
    actual: `${(inputReduction * 100).toFixed(1)}%`,
    pass: inputReduction >= 0.2,
  });

  out.push({
    id: "dynamic-tool-output-reduction",
    target: ">= 50%",
    actual: `${(dynamic.medianDynamicReduction * 100).toFixed(1)}%`,
    pass: dynamic.medianDynamicReduction >= 0.5,
  });

  const costRegression =
    baseline.medianBilledCost !== undefined &&
    dynamic.medianBilledCost !== undefined &&
    dynamic.medianBilledCost > baseline.medianBilledCost;
  out.push({
    id: "no-cost-regression",
    target: "billed cost not higher than baseline",
    actual: costRegression
      ? `${dynamic.medianBilledCost} > ${baseline.medianBilledCost} (REGRESSION)`
      : "no measured regression",
    pass: !costRegression,
  });

  const s = dynamic.security;
  out.push({
    id: "security-zeros",
    target: "0 secret / PII / metadata exposure, 0 broken anchors, 0 Safe Apply regressions, 0 source modified",
    actual: JSON.stringify(s),
    pass:
      s.secretExposure === 0 &&
      s.piiExposure === 0 &&
      s.metadataExposure === 0 &&
      s.brokenEditAnchors === 0 &&
      s.safeApplyRegressions === 0 &&
      s.sourceModifiedBeforeApply === 0,
  });

  out.push({
    id: "latency-overhead",
    target: "median <= 500 ms",
    actual: `${dynamic.medianLatencyOverheadMs} ms`,
    pass: dynamic.medianLatencyOverheadMs <= 500,
  });

  return out;
}
