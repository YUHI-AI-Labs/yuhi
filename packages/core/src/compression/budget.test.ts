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

describe("selectRepresentations — importance ranking", () => {
  it("keeps essentials full, compresses the rest, within budget", () => {
    const files: BudgetFileInput[] = [
      { relpath: "package.json", fullTokens: 300, packageManifest: true },
      { relpath: "src/index.ts", fullTokens: 400, entryPoint: true, compressedTokens: 120 },
      { relpath: "src/util.ts", fullTokens: 500, compressedTokens: 150 },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 2000 });

    expect(decisionFor(result, "package.json").representation).toBe("full");
    expect(decisionFor(result, "package.json").reason).toBe("package-manifest");
    // entryPoint is forced FULL even though compressedTokens is present
    expect(decisionFor(result, "src/index.ts").representation).toBe("full");
    expect(decisionFor(result, "src/index.ts").reason).toBe("entry-point");
    expect(decisionFor(result, "src/util.ts").representation).toBe("compressed");
    expect(decisionFor(result, "src/util.ts").finalTokens).toBe(150);

    expect(result.summary.status).toBe("within-budget");
    expect(result.summary.withinBudget).toBe(true);
    expect(result.summary.preparedTokens).toBe(300 + 400 + 150);
    expect(result.summary.originalTokens).toBe(300 + 400 + 500);
    assertReductionBalances(result);
  });

  it("over budget: drops lowest-importance non-essentials, keeps essentials", () => {
    const files: BudgetFileInput[] = [
      { relpath: "package.json", fullTokens: 200, packageManifest: true },
      { relpath: "src/big.ts", fullTokens: 800, compressedTokens: 300 },
      // un-shrinkable plain full source → rank "other", dropped first
      { relpath: "assets/notes.txt", fullTokens: 400 },
    ];
    // Budget forces dropping. Essentials(200) + compressible(300) = 500 fits; the
    // 400-token "other" file must go.
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 500 });

    expect(decisionFor(result, "package.json").representation).toBe("full");
    expect(decisionFor(result, "src/big.ts").representation).toBe("compressed");
    const dropped = decisionFor(result, "assets/notes.txt");
    expect(dropped.representation).toBe("excluded");
    expect(dropped.reason).toBe("budget");
    expect(dropped.finalTokens).toBe(0);

    expect(result.summary.preparedTokens).toBe(500);
    expect(result.summary.status).toBe("within-budget");
    expect(result.summary.withinBudget).toBe(true);
    expect(result.summary.exclusionReductionTokens).toBe(400);
    expect(result.summary.compressionReductionTokens).toBe(800 - 300);
    assertReductionBalances(result);
  });

  it("drops non-essentials in strict importance order (other before compressible)", () => {
    const files: BudgetFileInput[] = [
      { relpath: "keep.ts", fullTokens: 100, entryPoint: true },
      { relpath: "compressible.ts", fullTokens: 300, compressedTokens: 120 },
      { relpath: "other.ts", fullTokens: 120 },
    ];
    // essentials 100. Need <= 150 → must drop until prepared <= 150.
    // prepared start = 100 + 120 + 120 = 340. Drop lowest rank first: "other.ts"
    // (rank 1) → 220, still over → drop "compressible.ts" (rank 2) → 100.
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 150 });
    expect(decisionFor(result, "other.ts").representation).toBe("excluded");
    expect(decisionFor(result, "compressible.ts").representation).toBe("excluded");
    expect(decisionFor(result, "keep.ts").representation).toBe("full");
    expect(result.summary.preparedTokens).toBe(100);
    assertReductionBalances(result);
  });

  it("best-effort: essentials alone exceed budget → keep them, warn, exclude nothing essential", () => {
    const files: BudgetFileInput[] = [
      { relpath: "a.ts", fullTokens: 400, entryPoint: true },
      { relpath: "b.ts", fullTokens: 400, userIncluded: true },
      { relpath: "c.ts", fullTokens: 300, compressedTokens: 100 },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 500 });

    // Non-essential c.ts is dropped, but essentials survive even over budget.
    expect(decisionFor(result, "a.ts").representation).toBe("full");
    expect(decisionFor(result, "b.ts").representation).toBe("full");
    expect(decisionFor(result, "c.ts").representation).toBe("excluded");

    expect(result.summary.preparedTokens).toBe(800);
    expect(result.summary.status).toBe("best-effort");
    expect(result.summary.withinBudget).toBe(false);
    expect(result.summary.warnings.length).toBe(1);
    expect(result.summary.warnings[0]).toContain("Essential files require 800");
    assertReductionBalances(result);
  });

  it("tokenBudget 0: only essentials survive, warns", () => {
    const files: BudgetFileInput[] = [
      { relpath: "manifest/pyproject.toml", fullTokens: 200, packageManifest: true },
      { relpath: "src/a.ts", fullTokens: 300, compressedTokens: 90 },
      { relpath: "src/b.ts", fullTokens: 150 },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 0 });

    expect(decisionFor(result, "manifest/pyproject.toml").representation).toBe("full");
    expect(decisionFor(result, "src/a.ts").representation).toBe("excluded");
    expect(decisionFor(result, "src/b.ts").representation).toBe("excluded");
    expect(result.summary.preparedTokens).toBe(200);
    expect(result.summary.status).toBe("best-effort");
    expect(result.summary.warnings.length).toBe(1);
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
    expect(junk.finalTokens).toBe(0);
    // Junk is NOT part of originalTokens.
    expect(result.summary.originalTokens).toBe(300);
    // Junk exclusion is NOT a reduction against the map.
    expect(result.summary.exclusionReductionTokens).toBe(0);
    assertReductionBalances(result);
  });

  it("a file exactly at the compression threshold stays full (too-small)", () => {
    const files: BudgetFileInput[] = [
      { relpath: "tiny.ts", fullTokens: 50, compressedTokens: 10 },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 5000 });
    const d = decisionFor(result, "tiny.ts");
    expect(d.representation).toBe("full");
    expect(d.reason).toBe("too-small");
    // one token over the threshold is compressible
    const over = selectRepresentations(
      [{ relpath: "tiny.ts", fullTokens: 51, compressedTokens: 10 }],
      { ...OPTS, tokenBudget: 5000 },
    );
    expect(decisionFor(over, "tiny.ts").representation).toBe("compressed");
  });

  it("parseFailed and un-shrinkable files stay full with distinct reasons", () => {
    const files: BudgetFileInput[] = [
      { relpath: "broken.ts", fullTokens: 400, compressedTokens: 100, parseFailed: true },
      { relpath: "dense.ts", fullTokens: 400, compressedTokens: 400 },
      { relpath: "plain.ts", fullTokens: 400 },
    ];
    const result = selectRepresentations(files, { ...OPTS, tokenBudget: 10000 });
    expect(decisionFor(result, "broken.ts").representation).toBe("full");
    expect(decisionFor(result, "broken.ts").reason).toBe("parse-failed");
    expect(decisionFor(result, "dense.ts").reason).toBe("compression-not-smaller");
    expect(decisionFor(result, "plain.ts").reason).toBe("not-compressible");
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
