/**
 * v0.3.3 Three-tier token-budget selection.
 *
 * Given a token budget and a set of source files (each carrying deterministic
 * signals and pre-computed full/compressed token estimates), decide which
 * `ContextRepresentation` every file gets: kept FULL, COMPRESSED, or EXCLUDED to fit.
 *
 * The decision uses THREE explicit, independent tiers:
 *
 *   1. MustKeep      — files the budget must NEVER touch. Always FULL; never excluded
 *                      and never force-compressed. (user intent, entry points, manifests,
 *                      config, agent instructions, important fixtures, un-parseable files,
 *                      and files too small to bother compressing.)
 *   2. Importance    — a numeric rank used ONLY to decide DROP ORDER among the
 *                      NON-MustKeep files when over budget (lowest dropped first).
 *   3. Compressibility — whether a non-MustKeep file has a genuinely smaller compressed
 *                      form (`compressedTokens < fullTokens` and `fullTokens > threshold`).
 *
 * This module is purely arithmetic and DETERMINISTIC:
 *   - it never parses code (that is the SourceCompressors' job),
 *   - it never decides that a file is junk (that happens upstream; junk arrives already
 *     flagged via `alreadyExcluded`),
 *   - the same inputs — in ANY order — always yield the same decisions.
 *
 * The token budget is BEST-EFFORT. MustKeep files are never dropped and never broken to
 * fit a budget; if the MustKeep set alone exceeds the budget we keep it all and warn.
 */

import type { ContextRepresentation } from "./types.js";

export interface BudgetFileInput {
  relpath: string;
  /** Estimated tokens of the full file. */
  fullTokens: number;
  /** Estimated tokens if compressed (absent = not compressible). */
  compressedTokens?: number;
  // deterministic signals (all optional booleans):
  /** User explicitly kept this file full. */
  userIncluded?: boolean;
  /** Currently open in the editor / named on the CLI. */
  openOrSpecified?: boolean;
  entryPoint?: boolean;
  /** package.json, pyproject.toml, Cargo.toml, go.mod ... */
  packageManifest?: boolean;
  configFile?: boolean;
  /** CLAUDE.md, AGENTS.md, .cursorrules ... */
  agentInstruction?: boolean;
  /** Non-generated fixture worth keeping full. */
  importantTestFixture?: boolean;
  /** Compressor could not safely parse the file → must stay full. */
  parseFailed?: boolean;
  /** Junk excluded upstream (dependency dir, build output, binary ...). */
  alreadyExcluded?: boolean;
}

export interface BudgetOptions {
  /** Target budget; null/undefined = no budget (best effort, no exclusion for budget). */
  tokenBudget?: number | null;
  /** Files at/under this size stay full (too small to be worth compressing). */
  compressionThresholdTokens: number;
}

export interface RepresentationDecision {
  relpath: string;
  representation: ContextRepresentation;
  /** Report-ready deterministic reason (see the reason vocabulary below). */
  reason: string;
  /** Tier 1: this file is MustKeep — the budget never excludes or compresses it. */
  mustKeep: boolean;
  /** Tier 2: numeric importance rank (drop order among non-MustKeep files). */
  importanceRank: number;
  fullTokens: number;
  /** Tokens actually contributed (0 if excluded). */
  finalTokens: number;
}

export interface BudgetResult {
  decisions: RepresentationDecision[];
  summary: {
    fullFiles: number;
    compressedFiles: number;
    excludedFiles: number;
    /** Sum of fullTokens over inputs NOT excluded upstream as junk. */
    originalTokens: number;
    /** Sum of finalTokens actually delivered. */
    preparedTokens: number;
    /** Tokens saved by excluding files to fit the budget. */
    exclusionReductionTokens: number;
    /** Tokens saved by compressing files. */
    compressionReductionTokens: number;
    /** (original - prepared) / original * 100, 0 when original is 0. */
    reductionPercent: number;
    tokenBudget: number | null;
    /** preparedTokens <= budget (always true when there is no budget). */
    withinBudget: boolean;
    status: "within-budget" | "best-effort" | "no-budget";
    warnings: string[];
    // --- Report layer (Target / Actual / Reason) ---
    /** The budget we aimed at (= tokenBudget). null when there is no budget. */
    targetBudget: number | null;
    /** The tokens we actually delivered (= preparedTokens). */
    actualTokens: number;
    /** Short reason shown when the budget could not be met; omitted otherwise. */
    budgetReason?: string;
  };
}

/**
 * Importance rank, high number = more important (kept longest, dropped last).
 *
 * MustKeep files (see below) are NEVER dropped, so their rank is informational only.
 * Ranking decides drop order strictly among the NON-MustKeep files, where in practice
 * only two ranks occur:
 *
 *   2  compressible source
 *   1  other (plain full source that cannot be usefully compressed)
 *
 * The higher ranks are retained so a decision's `importanceRank` still reflects why a
 * MustKeep file is important, and so the ordering constant stays stable.
 */
export const IMPORTANCE_RANK = {
  userOrOpen: 6,
  entryPoint: 5,
  manifestOrInstructionOrConfig: 4,
  testFixture: 3,
  compressibleSource: 2,
  other: 1,
} as const;

type Representation = ContextRepresentation;

interface WorkItem {
  input: BudgetFileInput;
  relpath: string;
  fullTokens: number;
  representation: Representation;
  reason: string;
  finalTokens: number;
  importanceRank: number;
  /** Tier 1 — MustKeep: the budget never excludes or compresses this file. */
  mustKeep: boolean;
  /** Excluded upstream as junk — not counted toward originalTokens. */
  junk: boolean;
}

/**
 * Tier 1 — MustKeep detection. The first matching signal names the reason, in the
 * canonical MustKeep order. Returns null when the file is not MustKeep.
 */
function mustKeepReason(f: BudgetFileInput, threshold: number): string | null {
  if (f.userIncluded) return "user-included";
  if (f.openOrSpecified) return "open-or-specified";
  if (f.entryPoint) return "entry-point";
  if (f.packageManifest) return "package-manifest";
  if (f.configFile) return "config";
  if (f.agentInstruction) return "agent-instruction";
  if (f.importantTestFixture) return "test-fixture";
  if (f.parseFailed) return "parse-failed";
  if (f.fullTokens <= threshold) return "too-small";
  return null;
}

/** Tier 2 — importance rank derived purely from signals + compressibility. */
function importanceRankFor(f: BudgetFileInput, compressible: boolean): number {
  if (f.userIncluded || f.openOrSpecified) return IMPORTANCE_RANK.userOrOpen;
  if (f.entryPoint) return IMPORTANCE_RANK.entryPoint;
  if (f.packageManifest || f.agentInstruction || f.configFile)
    return IMPORTANCE_RANK.manifestOrInstructionOrConfig;
  if (f.importantTestFixture) return IMPORTANCE_RANK.testFixture;
  if (compressible) return IMPORTANCE_RANK.compressibleSource;
  return IMPORTANCE_RANK.other;
}

function compareRelpath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function selectRepresentations(
  files: readonly BudgetFileInput[],
  opts: BudgetOptions,
): BudgetResult {
  const threshold = opts.compressionThresholdTokens;
  const hasBudget = opts.tokenBudget !== null && opts.tokenBudget !== undefined;
  const budget = hasBudget ? (opts.tokenBudget as number) : null;

  const items: WorkItem[] = files.map((input) => {
    // (a) Junk excluded upstream — always excluded, contributes 0, uncounted.
    if (input.alreadyExcluded) {
      return {
        input,
        relpath: input.relpath,
        fullTokens: input.fullTokens,
        representation: "excluded",
        reason: "excluded-upstream",
        finalTokens: 0,
        importanceRank: IMPORTANCE_RANK.other,
        mustKeep: false,
        junk: true,
      };
    }

    // Tier 3 — compressibility (genuinely smaller compressed form).
    const canCompress =
      input.compressedTokens !== undefined &&
      input.compressedTokens < input.fullTokens &&
      input.fullTokens > threshold;

    // (b) Tier 1 — MustKeep: always FULL, never a drop candidate.
    const keepReason = mustKeepReason(input, threshold);
    if (keepReason !== null) {
      return {
        input,
        relpath: input.relpath,
        fullTokens: input.fullTokens,
        representation: "full",
        reason: keepReason,
        finalTokens: input.fullTokens,
        importanceRank: importanceRankFor(input, canCompress),
        mustKeep: true,
        junk: false,
      };
    }

    // (c) Non-MustKeep: compressible → compressed; otherwise full (not compressible).
    const importanceRank = importanceRankFor(input, canCompress);
    if (canCompress) {
      return {
        input,
        relpath: input.relpath,
        fullTokens: input.fullTokens,
        representation: "compressed",
        reason: "structural-compression",
        finalTokens: input.compressedTokens as number,
        importanceRank,
        mustKeep: false,
        junk: false,
      };
    }

    return {
      input,
      relpath: input.relpath,
      fullTokens: input.fullTokens,
      representation: "full",
      reason: "not-compressible",
      finalTokens: input.fullTokens,
      importanceRank,
      mustKeep: false,
      junk: false,
    };
  });

  // Everything is reserved: MustKeep full, compressibles compressed. Compute total.
  let preparedTokens = items.reduce((sum, it) => sum + it.finalTokens, 0);

  const warnings: string[] = [];
  let budgetReason: string | undefined;

  // (d) Trim to the budget by dropping the lowest-importance NON-MustKeep files first.
  if (hasBudget && budget !== null && preparedTokens > budget) {
    const candidates = items
      .filter((it) => !it.mustKeep && !it.junk && it.representation !== "excluded")
      .sort(
        (a, b) =>
          a.importanceRank - b.importanceRank || // lowest importance first
          b.fullTokens - a.fullTokens || // then largest full size first
          compareRelpath(a.relpath, b.relpath),
      );

    for (const it of candidates) {
      if (preparedTokens <= budget) break;
      preparedTokens -= it.finalTokens;
      it.representation = "excluded";
      it.reason = "token-budget";
      it.finalTokens = 0;
    }

    // (e) Best-effort: MustKeep files alone may still exceed the budget — keep them, warn.
    if (preparedTokens > budget) {
      const mustKeepTokens = items
        .filter((it) => it.mustKeep)
        .reduce((sum, it) => sum + it.finalTokens, 0);
      budgetReason = "Essential files exceed budget";
      warnings.push(
        `Essential (must-keep) files require ${mustKeepTokens} tokens, which exceeds the ` +
          `token budget of ${budget}. Keeping them full; budget is best-effort.`,
      );
    }
  }

  // Deterministic output order — independent of input order.
  const decisions: RepresentationDecision[] = items
    .map((it) => ({
      relpath: it.relpath,
      representation: it.representation,
      reason: it.reason,
      mustKeep: it.mustKeep,
      importanceRank: it.importanceRank,
      fullTokens: it.fullTokens,
      finalTokens: it.finalTokens,
    }))
    .sort((a, b) => compareRelpath(a.relpath, b.relpath));

  // Summary (junk is uncounted in originalTokens; it was never part of the map).
  const counted = items.filter((it) => !it.junk);
  const originalTokens = counted.reduce((sum, it) => sum + it.fullTokens, 0);

  let fullFiles = 0;
  let compressedFiles = 0;
  let excludedFiles = 0;
  let exclusionReductionTokens = 0;
  let compressionReductionTokens = 0;
  for (const it of items) {
    if (it.representation === "full") fullFiles += 1;
    else if (it.representation === "compressed") {
      compressedFiles += 1;
      compressionReductionTokens += it.fullTokens - it.finalTokens;
    } else {
      excludedFiles += 1;
      // Only budget-excluded files were counted in originalTokens, so only they
      // represent a reduction against it. Upstream junk was never counted.
      if (!it.junk) exclusionReductionTokens += it.fullTokens;
    }
  }

  const reductionPercent =
    originalTokens === 0
      ? 0
      : Math.round(((originalTokens - preparedTokens) / originalTokens) * 1000) / 10;

  const withinBudget = !hasBudget || budget === null ? true : preparedTokens <= budget;
  const status: BudgetResult["summary"]["status"] = !hasBudget
    ? "no-budget"
    : withinBudget
      ? "within-budget"
      : "best-effort";

  return {
    decisions,
    summary: {
      fullFiles,
      compressedFiles,
      excludedFiles,
      originalTokens,
      preparedTokens,
      exclusionReductionTokens,
      compressionReductionTokens,
      reductionPercent,
      tokenBudget: budget,
      withinBudget,
      status,
      warnings,
      targetBudget: budget,
      actualTokens: preparedTokens,
      ...(budgetReason !== undefined ? { budgetReason } : {}),
    },
  };
}
