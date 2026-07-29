import { describe, it, expect } from "vitest";
import { normalizeModelResponse } from "./normalize.js";

describe("normalizeModelResponse", () => {
  it("complete think block + final answer → keeps only the answer", () => {
    expect(normalizeModelResponse("<think>\nreasoning here\n</think>\n\nThe summary.")).toBe("The summary.");
  });

  it("no think block → returned as-is (trimmed)", () => {
    expect(normalizeModelResponse("Just a plain summary.")).toBe("Just a plain summary.");
  });

  it("unclosed leading think block → MALFORMED_RESPONSE", () => {
    expect(() => normalizeModelResponse("<think>\nreasoning with no close...")).toThrowError(
      /unclosed|never closed|<think>/i,
    );
    try {
      normalizeModelResponse("<think>still thinking");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("MALFORMED_RESPONSE");
    }
  });

  it("think block then empty answer → EMPTY_RESPONSE", () => {
    try {
      normalizeModelResponse("<think>only thinking</think>   \n  ");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("EMPTY_RESPONSE");
    }
  });

  it("think-like strings NOT at the start are ordinary content", () => {
    const t = "Use the <think> tag carefully; </think> closes it. See docs.";
    expect(normalizeModelResponse(t)).toBe(t);
  });

  it("whitespace around the final answer is trimmed", () => {
    expect(normalizeModelResponse("<think>x</think>\n\n   Final.   \n")).toBe("Final.");
  });

  it("Japanese final answer survives", () => {
    expect(normalizeModelResponse("<think>推論...</think>\n\n生徒3名の成績の要約。")).toBe(
      "生徒3名の成績の要約。",
    );
  });

  it("Simplified Chinese final answer survives", () => {
    expect(normalizeModelResponse("<think>推理</think>\n\n三名学生成绩的摘要。")).toBe(
      "三名学生成绩的摘要。",
    );
  });

  it("multiple consecutive leading think blocks are all stripped", () => {
    expect(normalizeModelResponse("<think>a</think>\n<think>b</think>\n\nThe answer.")).toBe("The answer.");
  });

  it("CRLF line endings around the block", () => {
    expect(normalizeModelResponse("<think>\r\nreason\r\n</think>\r\n\r\nAnswer.")).toBe("Answer.");
  });

  it("uppercase/mixed-case tags are handled", () => {
    expect(normalizeModelResponse("<THINK>x</Think>\n\nDone.")).toBe("Done.");
  });

  it("dangling </think> without a leading block is ordinary content", () => {
    const t = "See the </think> tag in the docs for details.";
    expect(normalizeModelResponse(t)).toBe(t);
  });

  it("response containing only a thinking block → EMPTY_RESPONSE", () => {
    try {
      normalizeModelResponse("<think>only reasoning, no answer</think>");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("EMPTY_RESPONSE");
    }
  });

  it("empty raw → EMPTY_RESPONSE", () => {
    try {
      normalizeModelResponse("   ");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("EMPTY_RESPONSE");
    }
  });
});
