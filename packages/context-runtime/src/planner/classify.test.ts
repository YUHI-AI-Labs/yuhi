import { describe, expect, it } from "vitest";
import { classifyIntent, classifyRole, hasTestFailureMarkers } from "./classify.js";

describe("classifyIntent", () => {
  it("routes test-output content to test-failure", () => {
    expect(classifyIntent({ tool: "test", kind: "test-output" })).toBe("test-failure");
  });

  it("routes a PDF companion to document-analysis", () => {
    expect(classifyIntent({ tool: "read", kind: "pdf-companion" })).toBe("document-analysis");
  });

  it("routes grep/glob to search", () => {
    expect(classifyIntent({ tool: "grep", kind: "text" })).toBe("search");
    expect(classifyIntent({ tool: "glob", kind: "text" })).toBe("search");
  });

  it("routes a data-shaped extension to data-analysis", () => {
    expect(classifyIntent({ tool: "read", kind: "text", toolInput: "data/roster.csv" })).toBe("data-analysis");
  });

  it("routes csv/tsv/json content kind to data-analysis", () => {
    expect(classifyIntent({ tool: "read", kind: "csv" })).toBe("data-analysis");
    expect(classifyIntent({ tool: "read", kind: "tsv" })).toBe("data-analysis");
  });

  it("routes a debug-flavored user message to debug", () => {
    expect(
      classifyIntent({ tool: "bash", kind: "shell-output", recentUserMessage: "why is this crashing?" }),
    ).toBe("debug");
  });

  it("routes a refactor-flavored user message to refactor", () => {
    expect(
      classifyIntent({ tool: "read", kind: "source", recentUserMessage: "please refactor this module" }),
    ).toBe("refactor");
  });

  it("falls back to unknown for an unrecognized shape", () => {
    expect(classifyIntent({ tool: "mcp", kind: "xml" })).toBe("unknown");
  });
});

describe("classifyRole", () => {
  const base = {
    tool: "read" as const,
    kind: "source" as const,
    activeEditTargets: [] as readonly string[],
    isRepeatedContent: false,
    confidenceHint: "high" as const,
  };

  it("classifies repeated content as repeated regardless of other signals", () => {
    expect(classifyRole({ ...base, isRepeatedContent: true })).toBe("repeated");
  });

  it("classifies node_modules/dist/lockfile/minified paths as generated-noise", () => {
    expect(classifyRole({ ...base, toolInput: "node_modules/left-pad/index.js" })).toBe("generated-noise");
    expect(classifyRole({ ...base, toolInput: "dist/bundle.js" })).toBe("generated-noise");
    expect(classifyRole({ ...base, toolInput: "pnpm-lock.yaml" })).toBe("generated-noise");
    expect(classifyRole({ ...base, toolInput: "vendor.min.js" })).toBe("generated-noise");
  });

  it("classifies an active edit target as load-bearing", () => {
    expect(
      classifyRole({ ...base, toolInput: "src/index.ts", activeEditTargets: ["src/index.ts"] }),
    ).toBe("load-bearing");
  });

  it("classifies failing test output as load-bearing, passing as generated-noise", () => {
    expect(classifyRole({ ...base, kind: "test-output", hasFailureMarkers: true })).toBe("load-bearing");
    expect(classifyRole({ ...base, kind: "test-output", hasFailureMarkers: false })).toBe("generated-noise");
  });

  it("classifies README/docs paths as reference", () => {
    expect(classifyRole({ ...base, toolInput: "docs/design/foo.md" })).toBe("reference");
    expect(classifyRole({ ...base, toolInput: "README.md" })).toBe("reference");
  });

  it("never resolves a low-confidence signal to generated-noise or load-bearing", () => {
    const result = classifyRole({ ...base, toolInput: "some/ambiguous/path.ts", confidenceHint: "low" });
    expect(result).toBe("unknown");
  });

  it("falls back to unknown, never guessed toward a specific role", () => {
    expect(classifyRole({ ...base, tool: "mcp", kind: "xml" })).toBe("unknown");
  });
});

describe("hasTestFailureMarkers", () => {
  it("is undefined for content kinds that are not test/shell output", () => {
    expect(hasTestFailureMarkers("json", "FAIL")).toBeUndefined();
  });

  it("detects a failure marker in test-output", () => {
    expect(hasTestFailureMarkers("test-output", "3 passed, 1 FAILED")).toBe(true);
  });

  it("reports false for clean test-output", () => {
    expect(hasTestFailureMarkers("test-output", "PASS 5/5, 0 skipped")).toBe(false);
  });
});
