import { describe, expect, it } from "vitest";
import {
  IMPORTANCE_RANK,
  selectRepresentations,
  type BudgetFileInput,
  type BudgetOptions,
} from "./budget.js";

const OPTS: BudgetOptions = { compressionThresholdTokens: 50 };

function decisionFor(
  result: ReturnType<typeof selectRepresentations>,
  relpath: string,
) {
  const d = result.decisions.find((x) => x.relpath === relpath);
  if (!d) throw new Error(`no decision for ${relpath}`);
  return d;
}

/** Every reduction number must reconcile with original - prepared for the counted set. */
function assertReductionBalances(result: ReturnType<typeof selectRepresentations>) {
  const s = result.summary;
  expect(s.exclusionReductionTokens + s.compressionReductionTokens).toBe(
    s.originalTokens - s.preparedTokens,
  );
}

/** The stable, report-ready reason vocabulary. Every decision must use one of these. */
const REASON_VOCABULARY = new Set([
  "user-included",
  "open-or-specified",
  "entry-point",
  "package-manifest",
  "config",
  "agent-instruction",
  "test-fixture",
  "parse-failed",
  "compressor-unavailable",
  "too-small",
  "structural-compression",
  "not-compressible",
  "compression-not-smaller",
  "token-budget",
  "excluded-upstream",
  "safety-policy",
]);

describe("selectRepresentations — three-tier budget selection", () => {
  it("keeps MustKeep full, compresses the rest, within budget", () => {
    const files: BudgetFileInput[] = [
      { relpath: "package.json", fullTokens: 300, packageManifest: true },
      { relpath: "src/index.ts", fullTokens: 400, entryPoint: true, compressedTokens: 120 },
      { relpath: "src/util.ts", fullTokens: 500, compressedTokens: 150 },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 2000 });

    expect(decisionFor(result, "package.json").representation).toBe("full");
    expect(decisionFor(result, "package.json").reason).toBe("package-manifest");
    expect(decisionFor(result, "package.json").mustKeep).toBe(true);
    // entryPoint is MustKeep → forced FULL even though compressedTokens is present
    expect(decisionFor(result, "src/index.ts").representation).toBe("full");
    expect(decisionFor(result, "src/index.ts").reason).toBe("entry-point");
    expect(decisionFor(result, "src/index.ts").mustKeep).toBe(true);
    expect(decisionFor(result, "src/util.ts").representation).toBe("compressed");
    expect(decisionFor(result, "src/util.ts").mustKeep).toBe(false);
    expect(decisionFor(result, "src/util.ts").finalTokens).toBe(150);

    expect(result.summary.status).toBe("within-budget");
    expect(result.summary.withinBudget).toBe(true);
    expect(result.summary.preparedTokens).toBe(300 + 400 + 150);
    expect(result.summary.originalTokens).toBe(300 + 400 + 500);
    assertReductionBalances(result);
  });

  it("over budget: drops lowest-importance non-MustKeep first, keeps MustKeep", () => {
    const files: BudgetFileInput[] = [
      { relpath: "package.json", fullTokens: 200, packageManifest: true },
      { relpath: "src/big.ts", fullTokens: 800, compressedTokens: 300 },
      // un-shrinkable plain full source → rank "other", dropped first
      { relpath: "assets/notes.txt", fullTokens: 400 },
    ];
    // Budget forces dropping. MustKeep(200) + compressible(300) = 500 fits; the
    // 400-token "other" file must go.
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 500 });

    expect(decisionFor(result, "package.json").representation).toBe("full");
    expect(decisionFor(result, "src/big.ts").representation).toBe("compressed");
    const dropped = decisionFor(result, "assets/notes.txt");
    expect(dropped.representation).toBe("excluded");
    expect(dropped.reason).toBe("token-budget");
    expect(dropped.mustKeep).toBe(false);
    expect(dropped.finalTokens).toBe(0);

    expect(result.summary.preparedTokens).toBe(500);
    expect(result.summary.status).toBe("within-budget");
    expect(result.summary.withinBudget).toBe(true);
    expect(result.summary.exclusionReductionTokens).toBe(400);
    expect(result.summary.compressionReductionTokens).toBe(800 - 300);
    assertReductionBalances(result);
  });

  it("drops non-MustKeep in strict importance order (other before compressible)", () => {
    const files: BudgetFileInput[] = [
      { relpath: "keep.ts", fullTokens: 100, entryPoint: true },
      { relpath: "compressible.ts", fullTokens: 300, compressedTokens: 120 },
      { relpath: "other.ts", fullTokens: 120 },
    ];
    // MustKeep 100. Need <= 150 → must drop until prepared <= 150.
    // prepared start = 100 + 120 + 120 = 340. Drop lowest rank first: "other.ts"
    // (rank 1) → 220, still over → drop "compressible.ts" (rank 2) → 100.
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 150 });
    expect(decisionFor(result, "other.ts").representation).toBe("excluded");
    expect(decisionFor(result, "other.ts").importanceRank).toBe(IMPORTANCE_RANK.other);
    expect(decisionFor(result, "compressible.ts").representation).toBe("excluded");
    expect(decisionFor(result, "compressible.ts").importanceRank).toBe(
      IMPORTANCE_RANK.compressibleSource,
    );
    expect(decisionFor(result, "keep.ts").representation).toBe("full");
    expect(result.summary.preparedTokens).toBe(100);
    assertReductionBalances(result);
  });

  it("best-effort: MustKeep alone exceeds budget → keep them, warn, exclude nothing MustKeep", () => {
    const files: BudgetFileInput[] = [
      { relpath: "a.ts", fullTokens: 400, entryPoint: true },
      { relpath: "b.ts", fullTokens: 400, userIncluded: true },
      { relpath: "c.ts", fullTokens: 300, compressedTokens: 100 },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 500 });

    // Non-MustKeep c.ts is dropped, but MustKeep survive even over budget.
    expect(decisionFor(result, "a.ts").representation).toBe("full");
    expect(decisionFor(result, "a.ts").mustKeep).toBe(true);
    expect(decisionFor(result, "b.ts").representation).toBe("full");
    expect(decisionFor(result, "b.ts").mustKeep).toBe(true);
    expect(decisionFor(result, "c.ts").representation).toBe("excluded");

    expect(result.summary.preparedTokens).toBe(800);
    expect(result.summary.status).toBe("best-effort");
    expect(result.summary.withinBudget).toBe(false);
    expect(result.summary.warnings.length).toBe(1);
    expect(result.summary.warnings[0]).toContain("Essential (must-keep) files require 800");
    expect(result.summary.budgetReason).toBe("Essential files exceed budget");
    expect(result.summary.targetBudget).toBe(500);
    expect(result.summary.actualTokens).toBe(800);
    assertReductionBalances(result);
  });

  it("tokenBudget 0: all MustKeep survive as full, everything else excluded, best-effort + warning", () => {
    const files: BudgetFileInput[] = [
      { relpath: "manifest/pyproject.toml", fullTokens: 200, packageManifest: true },
      { relpath: "CLAUDE.md", fullTokens: 250, agentInstruction: true },
      { relpath: "src/a.ts", fullTokens: 300, compressedTokens: 90 },
      { relpath: "src/b.ts", fullTokens: 150 },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 0 });

    // Both MustKeep files survive as full.
    expect(decisionFor(result, "manifest/pyproject.toml").representation).toBe("full");
    expect(decisionFor(result, "manifest/pyproject.toml").mustKeep).toBe(true);
    expect(decisionFor(result, "CLAUDE.md").representation).toBe("full");
    expect(decisionFor(result, "CLAUDE.md").reason).toBe("agent-instruction");
    // Everything non-MustKeep is excluded for budget.
    expect(decisionFor(result, "src/a.ts").representation).toBe("excluded");
    expect(decisionFor(result, "src/a.ts").reason).toBe("token-budget");
    expect(decisionFor(result, "src/b.ts").representation).toBe("excluded");

    expect(result.summary.preparedTokens).toBe(200 + 250);
    expect(result.summary.status).toBe("best-effort");
    expect(result.summary.withinBudget).toBe(false);
    expect(result.summary.warnings.length).toBe(1);
    expect(result.summary.budgetReason).toBe("Essential files exceed budget");
    expect(result.summary.targetBudget).toBe(0);
    expect(result.summary.actualTokens).toBe(450);
    assertReductionBalances(result);
  });

  it("a large non-MustKeep source is compressed, and excluded before any MustKeep when still over budget", () => {
    const files: BudgetFileInput[] = [
      { relpath: "src/entry.ts", fullTokens: 300, entryPoint: true },
      // large, compressible, NOT MustKeep
      { relpath: "src/huge.ts", fullTokens: 5000, compressedTokens: 1200 },
    ];
    // Budget below MustKeep(300) + compressed huge(1200) → huge must be excluded,
    // even though compressed, before the entry point is ever touched.
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 400 });

    const huge = decisionFor(result, "src/huge.ts");
    // First it was prepared as compressed...
    expect(huge.representation).toBe("excluded");
    expect(huge.reason).toBe("token-budget");
    expect(huge.mustKeep).toBe(false);
    // MustKeep entry point is never touched.
    expect(decisionFor(result, "src/entry.ts").representation).toBe("full");
    expect(decisionFor(result, "src/entry.ts").mustKeep).toBe(true);

    expect(result.summary.preparedTokens).toBe(300);
    expect(result.summary.status).toBe("within-budget");
    // The excluded huge file was counted at its FULL size against original.
    expect(result.summary.exclusionReductionTokens).toBe(5000);
    assertReductionBalances(result);
  });

  it("MustKeep is never force-compressed even with a smaller compressed form", () => {
    const files: BudgetFileInput[] = [
      { relpath: "src/index.ts", fullTokens: 900, compressedTokens: 100, entryPoint: true },
      { relpath: "big.config.js", fullTokens: 900, compressedTokens: 100, configFile: true },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 1_000_000 });
    expect(decisionFor(result, "src/index.ts").representation).toBe("full");
    expect(decisionFor(result, "src/index.ts").finalTokens).toBe(900);
    expect(decisionFor(result, "big.config.js").representation).toBe("full");
    expect(decisionFor(result, "big.config.js").reason).toBe("config");
    expect(result.summary.compressedFiles).toBe(0);
    assertReductionBalances(result);
  });

  it("very large budget: nothing excluded for budget", () => {
    const files: BudgetFileInput[] = [
      { relpath: "a.ts", fullTokens: 400, compressedTokens: 100 },
      { relpath: "b.ts", fullTokens: 900 },
      { relpath: "c.ts", fullTokens: 60, entryPoint: true },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 1_000_000 });
    expect(result.summary.excludedFiles).toBe(0);
    expect(result.summary.status).toBe("within-budget");
    expect(result.summary.budgetReason).toBeUndefined();
    expect(decisionFor(result, "a.ts").representation).toBe("compressed");
    expect(decisionFor(result, "b.ts").representation).toBe("full");
    assertReductionBalances(result);
  });

  it("no budget: best effort, nothing excluded for budget, status no-budget", () => {
    const files: BudgetFileInput[] = [
      { relpath: "a.ts", fullTokens: 400, compressedTokens: 100 },
      { relpath: "b.ts", fullTokens: 900 },
    ];
    for (const tokenBudget of [null, undefined] as const) {
      const result = selectRepresentations(files, { ...OPTS, tokenBudget });
      expect(result.summary.status).toBe("no-budget");
      expect(result.summary.withinBudget).toBe(true);
      expect(result.summary.tokenBudget).toBeNull();
      expect(result.summary.targetBudget).toBeNull();
      expect(result.summary.actualTokens).toBe(result.summary.preparedTokens);
      expect(result.summary.budgetReason).toBeUndefined();
      expect(result.summary.excludedFiles).toBe(0);
      assertReductionBalances(result);
    }
  });

  it("compression disabled path: no compressedTokens anywhere → all full", () => {
    const files: BudgetFileInput[] = [
      { relpath: "a.ts", fullTokens: 400 },
      { relpath: "b.ts", fullTokens: 900 },
      { relpath: "c.ts", fullTokens: 200, configFile: true },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 5000 });
    expect(result.summary.compressedFiles).toBe(0);
    expect(result.summary.fullFiles).toBe(3);
    expect(result.summary.compressionReductionTokens).toBe(0);
    expect(result.summary.preparedTokens).toBe(1500);
    assertReductionBalances(result);
  });

  it("alreadyExcluded files are not counted and contribute 0", () => {
    const files: BudgetFileInput[] = [
      { relpath: "node_modules/x/index.js", fullTokens: 99999, alreadyExcluded: true },
      { relpath: "src/a.ts", fullTokens: 300, compressedTokens: 100 },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 5000 });
    const junk = decisionFor(result, "node_modules/x/index.js");
    expect(junk.representation).toBe("excluded");
    expect(junk.reason).toBe("excluded-upstream");
    expect(junk.mustKeep).toBe(false);
    expect(junk.finalTokens).toBe(0);
    // Junk is NOT part of originalTokens.
    expect(result.summary.originalTokens).toBe(300);
    // Junk exclusion is NOT a reduction against the map.
    expect(result.summary.exclusionReductionTokens).toBe(0);
    assertReductionBalances(result);
  });

  it("a file at/under the compression threshold is MustKeep (too-small)", () => {
    const files: BudgetFileInput[] = [
      { relpath: "tiny.ts", fullTokens: 50, compressedTokens: 10 },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 5000 });
    const d = decisionFor(result, "tiny.ts");
    expect(d.representation).toBe("full");
    expect(d.reason).toBe("too-small");
    expect(d.mustKeep).toBe(true);
    // one token over the threshold is compressible (and not MustKeep)
    const over = selectRepresentations(
      [{ relpath: "tiny.ts", fullTokens: 51, compressedTokens: 10 }],
      { ...OPTS, tokenBudget: 5000 },
    );
    expect(decisionFor(over, "tiny.ts").representation).toBe("compressed");
    expect(decisionFor(over, "tiny.ts").mustKeep).toBe(false);
  });

  it("parseFailed is MustKeep; un-shrinkable non-MustKeep stays full (not-compressible)", () => {
    const files: BudgetFileInput[] = [
      { relpath: "broken.ts", fullTokens: 400, compressedTokens: 100, parseFailed: true },
      { relpath: "dense.ts", fullTokens: 400, compressedTokens: 400 },
      { relpath: "plain.ts", fullTokens: 400 },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 10000 });
    expect(decisionFor(result, "broken.ts").representation).toBe("full");
    expect(decisionFor(result, "broken.ts").reason).toBe("parse-failed");
    expect(decisionFor(result, "broken.ts").mustKeep).toBe(true);
    // Both "no smaller form" and "no compressed form at all" collapse into one reason.
    expect(decisionFor(result, "dense.ts").reason).toBe("not-compressible");
    expect(decisionFor(result, "dense.ts").mustKeep).toBe(false);
    expect(decisionFor(result, "plain.ts").reason).toBe("not-compressible");
    expect(decisionFor(result, "plain.ts").mustKeep).toBe(false);
  });

  it("every decision uses a reason from the stable vocabulary", () => {
    const files: BudgetFileInput[] = [
      { relpath: "user.ts", fullTokens: 400, userIncluded: true },
      { relpath: "open.ts", fullTokens: 400, openOrSpecified: true },
      { relpath: "entry.ts", fullTokens: 400, entryPoint: true },
      { relpath: "package.json", fullTokens: 200, packageManifest: true },
      { relpath: "tsconfig.json", fullTokens: 200, configFile: true },
      { relpath: "AGENTS.md", fullTokens: 200, agentInstruction: true },
      { relpath: "fixtures/data.json", fullTokens: 300, importantTestFixture: true },
      { relpath: "broken.ts", fullTokens: 400, parseFailed: true },
      { relpath: "tiny.ts", fullTokens: 40 },
      { relpath: "small.ts", fullTokens: 900, compressedTokens: 200 },
      { relpath: "plain.ts", fullTokens: 900 },
      { relpath: "vendor/lib.js", fullTokens: 9000, alreadyExcluded: true },
      { relpath: "drop.ts", fullTokens: 900, compressedTokens: 700 },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 3000 });
    for (const d of result.decisions) {
      expect(REASON_VOCABULARY.has(d.reason)).toBe(true);
    }
    // Ensure the budget-drop reason is actually exercised here.
    expect(result.decisions.some((d) => d.reason === "token-budget")).toBe(true);
    assertReductionBalances(result);
  });

  it("deterministic: shuffling the input yields identical decisions", () => {
    const files: BudgetFileInput[] = [
      { relpath: "package.json", fullTokens: 200, packageManifest: true },
      { relpath: "src/index.ts", fullTokens: 400, entryPoint: true },
      { relpath: "src/a.ts", fullTokens: 500, compressedTokens: 150 },
      { relpath: "src/b.ts", fullTokens: 450, compressedTokens: 150 },
      { relpath: "assets/big.txt", fullTokens: 600 },
      { relpath: "assets/small.txt", fullTokens: 300 },
      { relpath: "CLAUDE.md", fullTokens: 250, agentInstruction: true },
      { relpath: "vendor/lib.js", fullTokens: 9000, alreadyExcluded: true },
    ];
    const opts = { ...OPTS, tokenBudget: 900 };
    const base = selectRepresentations(files, opts);

    const shuffled = [...files].reverse();
    const other = [files[3], files[0], files[6], files[1], files[7], files[2], files[5], files[4]]
      .filter((x): x is BudgetFileInput => x !== undefined);

    for (const variant of [shuffled, other]) {
      const r = selectRepresentations(variant, opts);
      expect(r.decisions).toEqual(base.decisions);
      expect(r.summary).toEqual(base.summary);
    }
    assertReductionBalances(base);
  });

  it("exposes an explicit numeric importance ranking (high → low)", () => {
    expect(IMPORTANCE_RANK.userOrOpen).toBeGreaterThan(IMPORTANCE_RANK.entryPoint);
    expect(IMPORTANCE_RANK.entryPoint).toBeGreaterThan(
      IMPORTANCE_RANK.manifestOrInstructionOrConfig,
    );
    expect(IMPORTANCE_RANK.manifestOrInstructionOrConfig).toBeGreaterThan(
      IMPORTANCE_RANK.testFixture,
    );
    expect(IMPORTANCE_RANK.testFixture).toBeGreaterThan(IMPORTANCE_RANK.compressibleSource);
    expect(IMPORTANCE_RANK.compressibleSource).toBeGreaterThan(IMPORTANCE_RANK.other);
  });
});
