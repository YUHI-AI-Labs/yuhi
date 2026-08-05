/**
 * v0.4.8 Phase 5 — `defaultCompressContext` must track the CURRENT
 * `activeTokenEstimator` (`@yuhi/shared`) rather than a snapshot of the raw chars/4
 * heuristic captured once at import time. Before this fix, Dynamic Context
 * (`ContextRuntime`, via `defaultCompressContext`) never picked up `setTokenEstimator`
 * at all, while Static Prepare (`tokenEstimate()`) always did -- the two surfaces'
 * "reduction" numbers could silently diverge for a reason that had nothing to do with
 * content, only with which surface asked.
 */
import { afterEach, describe, expect, it } from "vitest";

import { estimateTokensCjkWeighted, setTokenEstimator } from "@yuhi/shared";

import { defaultCompressContext } from "./contract.js";

describe("defaultCompressContext — token estimator seam", () => {
  afterEach(() => {
    setTokenEstimator(estimateTokensCjkWeighted, "cjk-weighted-heuristic");
  });

  it("delegates to the CURRENT activeTokenEstimator, not a fixed snapshot", () => {
    const ctx = defaultCompressContext();
    const before = ctx.estimateTokens("山田太郎");

    const exactTokenizer = (text: string) => text.length * 100;
    setTokenEstimator(exactTokenizer);

    // The SAME context object, built before the swap, must reflect the new estimator.
    const after = ctx.estimateTokens("山田太郎");
    expect(after).toBe(exactTokenizer("山田太郎"));
    expect(after).not.toBe(before);
  });

  it("an explicit override still wins over the active estimator", () => {
    const ctx = defaultCompressContext({ estimateTokens: () => 42 });
    setTokenEstimator((text) => text.length * 1000);
    expect(ctx.estimateTokens("anything")).toBe(42);
  });
});
