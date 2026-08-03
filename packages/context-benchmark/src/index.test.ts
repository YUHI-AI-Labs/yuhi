import { describe, expect, it } from "vitest";

import {
  DishonestClaimError,
  assertCostClaim,
  evaluateSuccessCriteria,
  formatReduction,
  median,
  summarizeCondition,
  type Condition,
  type RunMetrics,
} from "./index.js";

function run(condition: Condition, overrides: Partial<RunMetrics> = {}, index = 0): RunMetrics {
  return {
    task: "large-json",
    condition,
    run: index,
    provider: { inputTokens: 10_000, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 500 },
    dynamicToolOutputReduction: 0,
    development: {
      taskSuccess: true,
      testsPassed: true,
      patchCorrect: true,
      retrievalCount: 0,
      repeatedReads: 0,
      latencyOverheadMs: 100,
    },
    security: {
      secretExposure: 0,
      piiExposure: 0,
      metadataExposure: 0,
      brokenEditAnchors: 0,
      safeApplyRegressions: 0,
      sourceModifiedBeforeApply: 0,
    },
    ...overrides,
  };
}

describe("measurement honesty (§17)", () => {
  it("refuses to let a repository estimate back a cost claim", () => {
    expect(() => assertCostClaim("repository-static", undefined)).toThrow(DishonestClaimError);
    expect(() => assertCostClaim("dynamic-tool-output", undefined)).toThrow(DishonestClaimError);
  });

  it("requires a provider-reported billed cost for a cost claim", () => {
    const usage = { inputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 1 };
    expect(() => assertCostClaim("provider-input", usage)).toThrow(DishonestClaimError);
    expect(() =>
      assertCostClaim("provider-input", { ...usage, billedCost: { amount: 0.12, currency: "USD" } }),
    ).not.toThrow();
  });

  it("labels a repository estimate as an estimate, never as token savings", () => {
    expect(formatReduction("repository-static", 0.45)).toBe("Estimated context reduction: 45.0%");
    expect(formatReduction("repository-static", 0.45)).not.toContain("token");
  });
});

describe("success criteria (§18)", () => {
  const baseline = [0, 1, 2].map((i) => run("baseline", {}, i));
  const staticYuhi = [0, 1, 2].map((i) => run("static-yuhi", {}, i));

  it("passes when dynamic Yuhi cuts provider input and tool output without regressions", () => {
    const dynamic = [0, 1, 2].map((i) =>
      run(
        "dynamic-yuhi",
        {
          provider: { inputTokens: 7_000, cacheCreationTokens: 500, cacheReadTokens: 4_000, outputTokens: 500 },
          dynamicToolOutputReduction: 0.72,
        },
        i,
      ),
    );
    const criteria = evaluateSuccessCriteria([...baseline, ...staticYuhi, ...dynamic]);
    expect(criteria.filter((c) => !c.pass)).toEqual([]);
  });

  it("fails a cost regression even when raw input tokens fell", () => {
    const withCost = (amount: number) => ({ amount, currency: "USD" });
    const base = [0, 1, 2].map((i) =>
      run("baseline", { provider: { ...run("baseline").provider, billedCost: withCost(0.1) } }, i),
    );
    const dynamic = [0, 1, 2].map((i) =>
      run(
        "dynamic-yuhi",
        {
          // Fewer input tokens, but the cache was busted and the bill went up.
          provider: {
            inputTokens: 7_000,
            cacheCreationTokens: 9_000,
            cacheReadTokens: 0,
            outputTokens: 500,
            billedCost: withCost(0.14),
          },
          dynamicToolOutputReduction: 0.8,
        },
        i,
      ),
    );
    const criteria = evaluateSuccessCriteria([...base, ...staticYuhi, ...dynamic]);
    const failed = criteria.filter((c) => !c.pass).map((c) => c.id);
    expect(failed).toContain("no-cost-regression");
  });

  it("fails any non-zero security count", () => {
    const dynamic = [0, 1, 2].map((i) =>
      run(
        "dynamic-yuhi",
        {
          provider: { inputTokens: 7_000, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 500 },
          dynamicToolOutputReduction: 0.6,
          security: { ...run("dynamic-yuhi").security, metadataExposure: 1 },
        },
        i,
      ),
    );
    const criteria = evaluateSuccessCriteria([...baseline, ...staticYuhi, ...dynamic]);
    expect(criteria.find((c) => c.id === "security-zeros")?.pass).toBe(false);
  });

  it("requires three runs per condition", () => {
    const criteria = evaluateSuccessCriteria([run("baseline"), run("static-yuhi"), run("dynamic-yuhi")]);
    expect(criteria.find((c) => c.id === "minimum-runs")?.pass).toBe(false);
  });

  it("summarizes cache columns separately from input tokens", () => {
    const summary = summarizeCondition("dynamic-yuhi", [
      run("dynamic-yuhi", {
        provider: { inputTokens: 100, cacheCreationTokens: 20, cacheReadTokens: 300, outputTokens: 10 },
      }),
    ]);
    expect(summary.medianCacheCreationTokens).toBe(20);
    expect(summary.medianCacheReadTokens).toBe(300);
    expect(median([3, 1, 2])).toBe(2);
  });
});
