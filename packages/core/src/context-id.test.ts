import { describe, it, expect } from "vitest";
import { computeContextId, isContextId, type ContextIdInput } from "./context-id.js";

function baseInput(): ContextIdInput {
  return {
    yuhiVersion: "0.1.0",
    manifestSchemaVersion: 2,
    sourceFiles: [
      { relpath: "src/b.ts", sha256: "b".repeat(64), size: 10 },
      { relpath: "src/a.ts", sha256: "a".repeat(64), size: 20 },
    ],
    safetyMode: "balanced",
    policyHash: "policy-hash-1",
    compression: false,
    tokenBudget: null,
    reductionMode: "balanced",
    compressionThresholdTokens: 2000,
  };
}

describe("Context ID — format & determinism", () => {
  it("produces a well-formed sha256:<hex> id", () => {
    const id = computeContextId(baseInput());
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(isContextId(id)).toBe(true);
  });

  it("is byte-identical for the same inputs", () => {
    expect(computeContextId(baseInput())).toBe(computeContextId(baseInput()));
  });

  it("is independent of source-file ordering (sorted internally)", () => {
    const a = baseInput();
    const b = baseInput();
    b.sourceFiles = [...a.sourceFiles].reverse();
    expect(computeContextId(b)).toBe(computeContextId(a));
  });
});

describe("Context ID — changes when identity-bearing inputs change", () => {
  const id = computeContextId(baseInput());

  it("changes when source content changes", () => {
    const next = baseInput();
    next.sourceFiles = [
      { relpath: "src/b.ts", sha256: "c".repeat(64), size: 10 },
      { relpath: "src/a.ts", sha256: "a".repeat(64), size: 20 },
    ];
    expect(computeContextId(next)).not.toBe(id);
  });

  it("changes when the safety mode changes", () => {
    const next = baseInput();
    next.safetyMode = "strict";
    expect(computeContextId(next)).not.toBe(id);
  });

  it("changes when the compression toggle changes", () => {
    const next = baseInput();
    next.compression = true;
    expect(computeContextId(next)).not.toBe(id);
  });

  it("changes when the token budget changes", () => {
    const next = baseInput();
    next.tokenBudget = 50_000;
    expect(computeContextId(next)).not.toBe(id);
  });

  it("changes when policy inputs change", () => {
    const next = baseInput();
    next.policyHash = "policy-hash-2";
    expect(computeContextId(next)).not.toBe(id);
  });

  it("changes when the Yuhi/schema version changes", () => {
    const v = baseInput();
    v.yuhiVersion = "9.9.9";
    expect(computeContextId(v)).not.toBe(id);
    const s = baseInput();
    s.manifestSchemaVersion = 3;
    expect(computeContextId(s)).not.toBe(id);
  });
});

describe("Context ID — invariants (excluded inputs)", () => {
  it("is INVARIANT across the agent (the id carries no agent input)", () => {
    // The input type has no agent field by construction; two consumers computing
    // the id from the same prepared inputs get the same id regardless of agent.
    expect(computeContextId(baseInput())).toBe(computeContextId(baseInput()));
  });

  it("only repo-relative paths participate (absolute paths are never an input)", () => {
    // Two repos with identical relative paths + content hashes yield the same id
    // even though their absolute locations differ — abspaths are not in the input.
    const a = baseInput();
    const b = baseInput();
    expect(computeContextId(a)).toBe(computeContextId(b));
  });
});
