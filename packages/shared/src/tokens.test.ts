import { afterEach, describe, expect, it } from "vitest";

import {
  byteCount,
  codePointCount,
  currentMeasurementMethod,
  estimateTokens,
  estimateTokensCjkWeighted,
  reductionReport,
  setTokenEstimator,
  tokenEstimate,
} from "./tokens.js";

describe("byteCount / codePointCount — exact, never estimated", () => {
  it("counts UTF-8 bytes exactly, distinct from UTF-16 code units for CJK text", () => {
    // 山田太郎 -- each character is 3 bytes in UTF-8, 1 UTF-16 code unit.
    expect(byteCount("山田太郎")).toBe(12);
    expect("山田太郎".length).toBe(4);
  });

  it("counts code points exactly, distinct from string.length for astral characters", () => {
    // A surrogate-pair emoji: 1 code point, 2 UTF-16 code units.
    const text = "a😀b";
    expect(text.length).toBe(4);
    expect(codePointCount(text)).toBe(3);
  });
});

describe("estimateTokensCjkWeighted", () => {
  it("is numerically identical to the flat heuristic for pure ASCII", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    expect(estimateTokensCjkWeighted(text)).toBe(estimateTokens(text));
  });

  it("weights CJK characters more densely than the flat chars/4 heuristic", () => {
    const cjk = "学籍番号氏名成績担当教員報告";
    const flat = estimateTokens(cjk);
    const weighted = estimateTokensCjkWeighted(cjk);
    // 14 CJK chars: flat = ceil(14/4) = 4; weighted = ceil(14/1.5) = 10.
    expect(weighted).toBeGreaterThan(flat);
  });

  it("handles mixed CJK and Latin text by weighting each script separately", () => {
    const mixed = "山田太郎さんのemailはtaro@example.comです";
    expect(estimateTokensCjkWeighted(mixed)).toBeGreaterThan(0);
  });

  it("returns 0 for empty input", () => {
    expect(estimateTokensCjkWeighted("")).toBe(0);
  });
});

describe("tokenEstimate", () => {
  afterEach(() => {
    setTokenEstimator(estimateTokensCjkWeighted, "cjk-weighted-heuristic");
  });

  it("reports method 'cjk-weighted-heuristic' by default (v0.4.8)", () => {
    const result = tokenEstimate("hello");
    expect(result.method).toBe("cjk-weighted-heuristic");
    expect(result.approx).toBe(true);
    expect(currentMeasurementMethod()).toBe("cjk-weighted-heuristic");
  });

  it("reports exact bytes/codePoints alongside the estimated token count", () => {
    const result = tokenEstimate("山田太郎");
    expect(result.bytes).toBe(12);
    expect(result.codePoints).toBe(4);
    expect(result.chars).toBe(4);
    expect(result.tokens).toBeGreaterThan(0);
  });

  it("setTokenEstimator swaps the active estimator and is reflected in method/approx", () => {
    const exactTokenizer = (text: string) => Math.ceil(text.length / 3.5);
    const prev = setTokenEstimator(exactTokenizer);
    try {
      const result = tokenEstimate("hello world");
      expect(result.method).toBe("exact-tokenizer");
      expect(result.approx).toBe(false);
      expect(result.tokens).toBe(exactTokenizer("hello world"));
    } finally {
      setTokenEstimator(prev, "cjk-weighted-heuristic");
    }
  });

  it("an explicitly-passed estimator identifies itself correctly even when not active", () => {
    expect(tokenEstimate("hello", estimateTokens).method).toBe("chars-per-token-heuristic");
    expect(tokenEstimate("hello", estimateTokensCjkWeighted).method).toBe("cjk-weighted-heuristic");
  });
});

describe("reductionReport", () => {
  it("is signed and unclamped: an increase renders as a negative percentReduction, never floored to 0", () => {
    const report = reductionReport({ beforeChars: 100, afterChars: 400, beforeTokens: 25, afterTokens: 100 });
    expect(report.tokensSaved).toBe(-75);
    expect(report.percentReduction).toBeLessThan(0);
  });

  it("records which method produced the token figures when the caller supplies one", () => {
    const report = reductionReport({
      beforeChars: 100,
      afterChars: 50,
      beforeTokens: 25,
      afterTokens: 12,
      method: "exact-tokenizer",
    });
    expect(report.method).toBe("exact-tokenizer");
    expect(report.approx).toBe(false);
  });

  it("falls back to a char-count-only estimate (never a stale hardcoded chars/4 disguised as CJK-aware) when tokens are omitted", () => {
    const report = reductionReport({ beforeChars: 400, afterChars: 100 });
    expect(report.beforeTokens).toBe(100); // ceil(400/4)
    expect(report.afterTokens).toBe(25); // ceil(100/4)
    expect(report.method).toBe("chars-per-token-heuristic");
    expect(report.approx).toBe(true);
  });

  it("hasData is false and percentReduction is 0 when there is nothing to estimate", () => {
    const report = reductionReport({ beforeChars: 0, afterChars: 0 });
    expect(report.hasData).toBe(false);
    expect(report.percentReduction).toBe(0);
  });
});
