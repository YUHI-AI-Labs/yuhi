/**
 * Fail-safe test for the lazy `typescript` runtime loader (v0.3.3 dependency isolation).
 *
 * When `typescript` is not installed, the compressor's dynamic `import("typescript")`
 * rejects. `compress()` must catch that and keep the file FULL with a
 * `compressor-unavailable` warning (distinct from `parse-failed`, which is reserved for
 * a loaded parser meeting genuinely broken source) — never throw, never lose the file.
 * We simulate the missing dependency by mocking `typescript` to throw on import. This
 * lives in its own file so the mock does not affect the real compression tests.
 */
import { describe, expect, it, vi } from "vitest";

// Simulate `typescript` being absent: the dynamic import inside loadTs() rejects.
vi.mock("typescript", () => {
  throw new Error("Cannot find module 'typescript'");
});

import { JavaScriptCompressor, TypeScriptCompressor } from "./typescript-compressor.js";

describe("typescript loader unavailable", () => {
  it("keeps a TS file FULL (with a parse-failed warning) when typescript cannot be loaded", async () => {
    const ts = new TypeScriptCompressor();
    const content = ["export function add(a: number, b: number): number {", "  return a + b;", "}"].join(
      "\n",
    );
    const result = await ts.compress({ relpath: "add.ts", content });

    expect(result.representation).toBe("full");
    expect(result.content).toBe(content);
    expect(result.originalTokens).toBe(result.compressedTokens);
    expect(result.symbols).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toContain("compressor-unavailable");
    expect(result.warnings.map((w) => w.code)).not.toContain("parse-failed");
  });

  it("keeps a JS file FULL when typescript cannot be loaded", async () => {
    const js = new JavaScriptCompressor();
    const content = "export const answer = 42;\n";
    const result = await js.compress({ relpath: "a.js", content });

    expect(result.representation).toBe("full");
    expect(result.content).toBe(content);
    expect(result.warnings.map((w) => w.code)).toContain("compressor-unavailable");
    expect(result.warnings.map((w) => w.code)).not.toContain("parse-failed");
  });
});
