import { describe, expect, it } from "vitest";

import { asObjectId, parseJsonPath } from "@yuhi/context-store";

import { defaultCompressContext, sampleOf, type CompressInput } from "./contract.js";
import { jsonCompressor } from "./json.js";
import { compressWithFallback } from "./registry.js";
import { textCompressor } from "./text.js";

const OBJECT_ID = asObjectId("obj_0123456789abcdef0123456789abcdef");
const ctx = defaultCompressContext({ now: () => "2026-08-03T00:00:00.000Z" });

function input(content: string, kind: CompressInput["kind"] = "json", tokenBudget?: number): CompressInput {
  return { objectId: OBJECT_ID, revision: 0, kind, content, ...(tokenBudget === undefined ? {} : { tokenBudget }) };
}

function largeJson(rows = 2000): string {
  return JSON.stringify({
    meta: { version: "2", generated: "2026-08-03" },
    users: Array.from({ length: rows }, (_, i) => ({
      id: i + 1,
      name: `user-${i}`,
      email: `user-${i}@example.com`,
      note: "x".repeat(200),
    })),
  });
}

describe("json compressor", () => {
  it("delivers schema, statistics and samples instead of every row", async () => {
    const content = largeJson();
    const result = await jsonCompressor.compress(input(content), ctx);

    expect(result.text).toContain("array(2000)");
    expect(result.text).toContain("email:string");
    expect(result.text).toContain("[0]:");
    expect(result.text).toContain("retrieve $.users[2:1998]");
    // §18: large JSON must lose at least 70% of delivered tokens.
    expect(1 - result.tokensAfter / result.tokensBefore).toBeGreaterThan(0.7);
    expect(jsonCompressor.verify(input(content), result)).toEqual({ ok: true });
  });

  it("makes every omission retrievable — nothing is destroyed", async () => {
    const result = await jsonCompressor.compress(input(largeJson()), ctx);
    expect(result.omissions.length).toBeGreaterThan(0);
    for (const omission of result.omissions) {
      expect(omission.objectId).toBe(OBJECT_ID);
      // The locator grammar the store can actually resolve.
      expect(() => parseJsonPath(omission.locator)).not.toThrow();
      expect(omission.tokensOmitted).toBeGreaterThanOrEqual(0);
    }
  });

  it("is deterministic: identical bytes produce identical views", async () => {
    const content = largeJson(500);
    const a = await jsonCompressor.compress(input(content), ctx);
    const b = await jsonCompressor.compress(input(content), ctx);
    expect(b.text).toBe(a.text);
    expect(b.omissions).toEqual(a.omissions);
  });

  it("surfaces an interesting row that head/tail sampling would collapse", async () => {
    const rows: unknown[] = Array.from({ length: 300 }, (_, i) => ({ id: i, status: "ok" }));
    rows[214] = { id: 214, status: "fail", error: "connection reset by peer" };
    const result = await jsonCompressor.compress(input(JSON.stringify({ rows })), ctx);
    expect(result.text).toContain("interesting [214]");
    expect(result.text).toContain("connection reset by peer");
  });

  it("tightens the view when a token budget is set", async () => {
    const content = largeJson();
    const loose = await jsonCompressor.compress(input(content), ctx);
    const tight = await jsonCompressor.compress(input(content, "json", 60), ctx);
    expect(tight.tokensAfter).toBeLessThan(loose.tokensAfter);
  });

  it("truncates long strings reversibly rather than dropping them", async () => {
    const content = JSON.stringify({ blob: "y".repeat(5000) });
    const result = await jsonCompressor.compress(input(content), ctx);
    expect(result.text).toContain("(truncated, 5000 chars)");
    expect(result.omissions.map((o) => o.locator)).toContain("$.blob");
  });

  it("refuses to claim a reduction it did not achieve", async () => {
    const content = JSON.stringify({ a: 1 });
    const result = await jsonCompressor.compress(input(content), ctx);
    expect(jsonCompressor.verify(input(content), result)).toEqual({ ok: false, reason: "no-reduction" });
  });

  it("supports JSON arriving as generic text but not unrelated kinds", () => {
    expect(jsonCompressor.supports("text", sampleOf('{"a":1}'))).toBe(true);
    expect(jsonCompressor.supports("text", sampleOf("plain prose"))).toBe(false);
    expect(jsonCompressor.supports("html", sampleOf("<html>"))).toBe(false);
  });
});

describe("text compressor", () => {
  it("keeps head and tail and records a retrievable line range", async () => {
    const content = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const result = await textCompressor.compress(input(content, "log"), ctx);
    expect(result.text).toContain("line 0");
    expect(result.text).toContain("line 399");
    expect(result.text).not.toContain("line 200");
    expect(result.omissions[0]?.locator).toBe("L61-L360");
    expect(textCompressor.verify(input(content, "log"), result)).toEqual({ ok: true });
  });
});

describe("fallback registry", () => {
  it("falls through to the next compressor when one fails its own verify", async () => {
    const content = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    // Not JSON, so the json compressor declines; the text window handles it.
    const outcome = await compressWithFallback(input(content, "log"), ctx);
    expect(outcome.status).toBe("compressed");
    if (outcome.status === "compressed") expect(outcome.result.compressorId).toBe("text-window");
  });

  it("reports failure rather than passing raw content through", async () => {
    const broken = {
      id: "broken",
      version: "1",
      supports: () => true,
      estimateTokens: (t: string) => t.length,
      compress: async () => {
        throw new Error("boom");
      },
      verify: () => ({ ok: true }) as const,
    };
    const outcome = await compressWithFallback(input("anything", "text"), ctx, [broken]);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toBe("all-compressors-failed");
      // The reason is compressor-authored, never content-derived.
      expect(outcome.attempts[0]?.reason).toBe("Error");
    }
  });

  it("aborts a hanging compressor instead of hanging the agent", async () => {
    const hanging = {
      id: "hanging",
      version: "1",
      supports: () => true,
      estimateTokens: (t: string) => t.length,
      compress: () => new Promise<never>(() => {}),
      verify: () => ({ ok: true }) as const,
    };
    const outcome = await compressWithFallback(
      input("anything", "text"),
      defaultCompressContext({ timeoutMs: 20 }),
      [hanging],
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.attempts[0]?.reason).toBe("CompressionAborted");
  });
});
