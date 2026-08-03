/**
 * Slice 3 compressors: test/shell output (3A), search results (3B), tolerant JSON (3C).
 *
 * The acceptance criteria are not "smaller". They are: the anchors a follow-up patch
 * needs survive, recall survives, and everything removed is retrievable.
 */

import { asObjectId } from "@yuhi/context-store";
import { describe, expect, it } from "vitest";

import { defaultCompressContext, sampleOf, type CompressInput } from "./contract.js";
import { jsonTolerantCompressor } from "./json-tolerant.js";
import { coalesceDroppedLines, normalizeForDuplicates } from "./line-selection.js";
import { compressWithFallback } from "./registry.js";
import { searchResultsCompressor } from "./search-results.js";
import { testOutputCompressor } from "./test-output.js";

const OBJECT_ID = asObjectId("obj_0123456789abcdef0123456789abcdef");
const ctx = defaultCompressContext({ now: () => "2026-08-04T00:00:00.000Z" });

function input(content: string, kind: CompressInput["kind"]): CompressInput {
  return { objectId: OBJECT_ID, revision: 0, kind, content };
}

/** A vitest-shaped run: lots of passing noise around three real failures. */
function testRun(passing = 800): string {
  const lines: string[] = ["$ pnpm test", "", " RUN  v2.1.9 /repo", ""];
  for (let i = 0; i < passing; i++) {
    lines.push(` ✓ src/mod-${i % 40}.test.ts > case ${i} 2ms`);
    if (i % 50 === 0) lines.push(`  [${Math.floor((i / passing) * 100)}%] running…`);
    if (i % 90 === 0) lines.push("npm warn deprecated inflight@1.0.6: unmaintained");
  }
  lines.push(
    " ❯ src/checkout/total.test.ts (3 failed)",
    "   ✗ applies the loyalty discount",
    "     AssertionError: expected 1170 to be 1080",
    "     Expected: 1080",
    "     Received: 1170",
    "      at src/checkout/total.ts:42:11",
    "      at src/checkout/total.test.ts:88:5",
    "      at node_modules/vitest/dist/runner.js:120:9",
    "      at node_modules/vitest/dist/runner.js:121:9",
    "      at node_modules/vitest/dist/runner.js:122:9",
    "      at node_modules/vitest/dist/runner.js:123:9",
    "      at node_modules/vitest/dist/runner.js:124:9",
    "      at node_modules/vitest/dist/runner.js:125:9",
    "   ✗ rejects a negative quantity",
    "     Error: quantity must be positive",
    "      at src/checkout/total.ts:17:5",
    "   ✗ rounds to two decimals",
    "     AssertionError: expected 10.005 to be 10.01",
    "      at src/checkout/total.ts:63:20",
    "",
    " Test Files  1 failed | 40 passed (41)",
    `      Tests  3 failed | ${passing} passed (${passing + 3})`,
    "   Duration  12.34s",
    "exit code 1",
  );
  return lines.join("\n");
}

function grepOutput(): string {
  const lines: string[] = [];
  for (let f = 0; f < 40; f++) {
    for (let h = 0; h < 10; h++) {
      lines.push(`src/module-${f}/handler.ts:${100 + h}:  const result = computeTotal(order, options)`);
    }
    // A duplicate the tool emitted twice.
    lines.push(`src/module-${f}/handler.ts:100:  const result = computeTotal(order, options)`);
  }
  return lines.join("\n");
}

describe("3A — test/shell output compressor", () => {
  it("keeps every failure anchor and drops the passing noise", async () => {
    const content = testRun();
    const result = await testOutputCompressor.compress(input(content, "test-output"), ctx);

    // Anchors a patch is written against.
    expect(result.text).toContain("exit code 1");
    expect(result.text).toContain("Tests  3 failed | 800 passed (803)");
    expect(result.text).toContain("applies the loyalty discount");
    expect(result.text).toContain("AssertionError: expected 1170 to be 1080");
    expect(result.text).toContain("src/checkout/total.ts:42:11");
    expect(result.text).toContain("src/checkout/total.ts:17:5");
    expect(result.text).toContain("src/checkout/total.ts:63:20");
    expect(result.text).toContain("$ pnpm test");
    // The first deprecation warning survives, the repeats do not.
    expect(result.text).toContain("npm warn deprecated inflight");
    expect(result.text.match(/npm warn deprecated inflight/g)).toHaveLength(1);

    // Noise is gone.
    expect(result.text).not.toContain("case 400");
    expect(result.text).not.toContain("running…");
    // §3A acceptance: ≥50% fewer delivered tokens.
    expect(1 - result.tokensAfter / result.tokensBefore).toBeGreaterThan(0.5);
    expect(testOutputCompressor.verify(input(content, "test-output"), result)).toEqual({ ok: true });
  });

  it("caps repeated stack frames without losing the top of the trace", async () => {
    const content = testRun(200);
    const result = await testOutputCompressor.compress(input(content, "test-output"), ctx);
    expect(result.text).toContain("at src/checkout/total.test.ts:88:5");
    // Frames 7+ of the same trace are dropped; the framework tail is not interesting.
    expect(result.text).not.toContain("runner.js:125:9");
  });

  it("makes every dropped run retrievable as a line range", async () => {
    const content = testRun(300);
    const result = await testOutputCompressor.compress(input(content, "test-output"), ctx);
    expect(result.omissions.length).toBeGreaterThan(0);
    for (const omission of result.omissions) {
      expect(omission.locator).toMatch(/^L\d+-L\d+$/);
      expect(omission.objectId).toBe(OBJECT_ID);
    }
    // The marker tells the agent exactly what to ask for.
    expect(result.text).toMatch(/… \d+ lines omitted \([^)]+\) → retrieve L\d+-L\d+ …/);
    expect(result.removed.map((r) => r.kind)).toContain("passing test records");
  });

  it("fails its own verify rather than delivering a result that lost an anchor", async () => {
    const content = testRun(100);
    const result = await testOutputCompressor.compress(input(content, "test-output"), ctx);
    const mutilated = { ...result, text: result.text.replace("exit code 1", "") };
    expect(testOutputCompressor.verify(input(content, "test-output"), mutilated)).toEqual({
      ok: false,
      reason: "dropped-anchor",
    });
  });

  it("declines content it has no business restructuring", () => {
    expect(testOutputCompressor.supports("json", sampleOf(testRun(100)))).toBe(false);
    expect(testOutputCompressor.supports("test-output", sampleOf("short\noutput"))).toBe(false);
  });
});

describe("3B — search result compressor", () => {
  it("groups by file, preserves the true match count, and caps per file", async () => {
    const content = grepOutput();
    const result = await searchResultsCompressor.compress(input(content, "text"), ctx);

    // 40 files × 11 lines = 440 parsed hits; the header states the truth.
    expect(result.text).toMatch(/^\[search\] 440 matches in 40 files · showing 25 files, up to 5 per file/);
    expect(result.text).toContain("src/module-0/handler.ts: 11 matches");
    // Recall of file identity is preserved for the capped files.
    expect(result.text).toContain("src/module-24/handler.ts");
    // §3B acceptance: ≥40% fewer delivered tokens.
    expect(1 - result.tokensAfter / result.tokensBefore).toBeGreaterThan(0.4);
    expect(searchResultsCompressor.verify(input(content, "text"), result)).toEqual({ ok: true });
  });

  it("keeps line anchors for the hits it shows and retrievable ranges for the rest", async () => {
    const result = await searchResultsCompressor.compress(input(grepOutput(), "text"), ctx);
    expect(result.anchors.some((a) => /^src\/module-0\/handler\.ts:\d+$/.test(a))).toBe(true);
    expect(result.omissions.length).toBeGreaterThan(0);
    for (const omission of result.omissions) expect(omission.locator).toMatch(/^L\d+-L\d+$/);
    expect(result.removed.map((r) => r.kind).sort()).toEqual([
      "duplicate hits",
      "files beyond the cap",
      "hits beyond the per-file cap",
    ]);
  });

  it("does not claim prose is a search result", () => {
    const prose = Array.from({ length: 40 }, (_, i) => `This is sentence ${i} of ordinary prose.`).join("\n");
    expect(searchResultsCompressor.supports("text", sampleOf(prose))).toBe(false);
    expect(searchResultsCompressor.supports("text", sampleOf(grepOutput()))).toBe(true);
  });
});

describe("3C — tolerant JSON scanner", () => {
  const truncated = `{"generated":"2026-08-04","records":[${Array.from(
    { length: 400 },
    (_, i) => `{"id":${i},"name":"record-${i}","status":"${i === 219 ? "failed" : "ok"}"${i === 219 ? ',"error":"disk quota exceeded"' : ""},"payload":"${"x".repeat(60)}"}`,
  ).join(",")}`;

  it("reports structure for JSON that no parser can accept", async () => {
    const result = await jsonTolerantCompressor.compress(input(truncated, "json"), ctx);

    expect(result.text).toContain("TRUNCATED / not parseable as a complete document");
    expect(result.text).toContain("Keys at depth 1");
    expect(result.text).toContain("records");
    expect(result.text).toContain("Repeated record shape");
    // The error field is exactly what the agent is looking for.
    expect(result.text).toContain('"error": "disk quota exceeded"');
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore * 0.4);
    expect(jsonTolerantCompressor.verify(input(truncated, "json"), result)).toEqual({ ok: true });
  });

  it("hands back a byte-range locator for the part it did not deliver", async () => {
    const result = await jsonTolerantCompressor.compress(input(truncated, "json"), ctx);
    expect(result.omissions).toHaveLength(1);
    expect(result.omissions[0]?.locator).toMatch(/^B900-B\d+$/);
    expect(result.text).toMatch(/→ retrieve B900-B\d+ …/);
  });

  it("recognises NDJSON and keeps head, tail and interesting records", async () => {
    const ndjson = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ ts: `2026-08-04T00:00:${String(i % 60).padStart(2, "0")}Z`, level: i === 143 ? "error" : "info", msg: `event ${i}`, ...(i === 143 ? { error: "upstream timeout" } : {}) }),
    ).join("\n");

    const result = await jsonTolerantCompressor.compress(input(ndjson, "log"), ctx);
    expect(result.text).toContain("NDJSON · 200 records");
    expect(result.text).toContain("shape {");
    expect(result.text).toContain("event 0");
    expect(result.text).toContain("event 199");
    expect(result.text).toContain("upstream timeout");
    expect(result.text).not.toContain("event 100");
    expect(result.omissions.every((o) => /^L\d+-L\d+$/.test(o.locator))).toBe(true);
  });

  it("runs only after strict parsing has failed", async () => {
    const valid = JSON.stringify({ rows: Array.from({ length: 300 }, (_, i) => ({ i, v: "y".repeat(40) })) });
    const strict = await compressWithFallback(input(valid, "json"), ctx);
    if (strict.status !== "compressed") throw new Error("expected strict success");
    expect(strict.result.compressorId).toBe("json-outline");

    const tolerant = await compressWithFallback(input(truncated, "json"), ctx);
    if (tolerant.status !== "compressed") throw new Error("expected tolerant success");
    expect(tolerant.result.compressorId).toBe("json-tolerant-scan");
    // The strict attempt is recorded as tried-and-failed, not silently skipped.
    expect(tolerant.attempts[0]).toMatchObject({ compressorId: "json-outline", ok: false });
  });
});

describe("line-selection primitives", () => {
  it("coalesces scattered dropped lines into contiguous retrievable ranges", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const result = coalesceDroppedLines({
      lines,
      droppedLines: [3, 4, 5, 9, 15, 16],
      objectId: OBJECT_ID,
      estimateTokens: (t) => t.length,
      reasons: new Map([
        [3, "noise"],
        [4, "noise"],
        [5, "noise"],
        [9, "duplicate"],
        [15, "noise"],
        [16, "noise"],
      ]),
    });
    expect(result.omissions.map((o) => o.locator)).toEqual(["L3-L5", "L9-L9", "L15-L16"]);
    expect(result.markers.get(3)).toContain("3 lines omitted (noise)");
    expect(result.markers.get(9)).toContain("1 line omitted (duplicate)");
  });

  it("normalizes volatile values so duplicates are detectable", () => {
    expect(normalizeForDuplicates("done in 12.5ms at 0xAB12")).toBe(normalizeForDuplicates("done in 99.1ms at 0xFF99"));
    expect(normalizeForDuplicates("compiled module a")).not.toBe(normalizeForDuplicates("compiled module b"));
  });
});
