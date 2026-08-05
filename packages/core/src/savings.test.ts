import { describe, expect, it } from "vitest";

import { contextSavings } from "./savings.js";
import type { Plan } from "./plan.js";

/** Minimal fixture: `contextSavings` only reads `scan.files` and
 *  `evaluation.decisions`, so the rest of `Plan` is irrelevant to this unit. */
function planFixture(input: {
  files: { relpath: string; size: number; isSymlink?: boolean }[];
  decisions: { relpath: string; action: string; findings?: unknown[] }[];
}): Plan {
  return {
    scan: {
      root: "/repo",
      filesInspected: input.files.length,
      files: input.files.map((f) => ({
        relpath: f.relpath,
        absPath: `/repo/${f.relpath}`,
        size: f.size,
        flags: { isBinary: false, isSymlink: f.isSymlink ?? false, isLarge: false },
        findings: [],
        inspection: { inspectionAttempted: false, inspectionSucceeded: false, contentVerified: false },
      })),
      findings: [],
      riskSummary: { critical: 0, high: 0, medium: 0, low: 0 },
      warnings: [],
    },
    evaluation: {
      decisions: input.decisions.map((d) => ({
        relpath: d.relpath,
        action: d.action,
        ruleName: "default",
        reason: "test",
        destinations: [],
        findings: d.findings ?? [],
      })),
      byAction: {},
    },
    agentId: "claude",
    isGitRepo: false,
  } as unknown as Plan;
}

describe("contextSavings", () => {
  it("computes a straightforward before/after with nothing excluded (0%, not a floored positive number)", () => {
    const plan = planFixture({
      files: [
        { relpath: "a.ts", size: 100 },
        { relpath: "b.ts", size: 400 },
      ],
      decisions: [
        { relpath: "a.ts", action: "allow" },
        { relpath: "b.ts", action: "allow" },
      ],
    });
    const savings = contextSavings(plan);
    expect(savings.before.bytes).toBe(500);
    expect(savings.after.bytes).toBe(500);
    expect(savings.tokenReductionPct).toBe(0);
  });

  it("reports a NEGATIVE percentage honestly rather than clamping to 0 (v0.4.8 Phase 5)", () => {
    // The 'before' baseline excludes symlinks (savings.ts skips them when summing
    // beforeBytes), but a decision can still mark a symlinked path visible -- its size
    // then counts toward 'after' without ever having counted toward 'before', making
    // after > before. docs/HANDOFF.md's "reduction is not clamped" rule applies here:
    // this must render as negative, not silently floor to 0% like it did previously.
    const plan = planFixture({
      files: [
        { relpath: "a.ts", size: 100 },
        { relpath: "link", size: 900, isSymlink: true },
      ],
      decisions: [
        { relpath: "a.ts", action: "allow" },
        { relpath: "link", action: "allow" },
      ],
    });
    const savings = contextSavings(plan);
    expect(savings.before.bytes).toBe(100);
    expect(savings.after.bytes).toBe(1000);
    expect(savings.tokenReductionPct).toBeLessThan(0);
  });

  it("reports a real, honest reduction when files are excluded", () => {
    const plan = planFixture({
      files: [
        { relpath: "a.ts", size: 100 },
        { relpath: "secret.env", size: 900 },
      ],
      decisions: [
        { relpath: "a.ts", action: "allow" },
        { relpath: "secret.env", action: "block", findings: [{ detector: "aws-key" }] },
      ],
    });
    const savings = contextSavings(plan);
    expect(savings.before.bytes).toBe(1000);
    expect(savings.after.bytes).toBe(100);
    expect(savings.tokenReductionPct).toBe(90);
    expect(savings.secretsRemoved).toBe(1);
  });

  it("excludes symlinked files from the 'before' baseline", () => {
    const plan = planFixture({
      files: [
        { relpath: "a.ts", size: 100 },
        { relpath: "link", size: 5000, isSymlink: true },
      ],
      decisions: [{ relpath: "a.ts", action: "allow" }],
    });
    const savings = contextSavings(plan);
    expect(savings.before.bytes).toBe(100);
    expect(savings.before.files).toBe(1);
  });

  it("counts local-only bytes and reports zero reduction (not NaN) with an empty plan", () => {
    const plan = planFixture({ files: [], decisions: [] });
    const savings = contextSavings(plan);
    expect(savings.tokenReductionPct).toBe(0);
    expect(savings.before.bytes).toBe(0);
    expect(savings.after.bytes).toBe(0);
  });
});
