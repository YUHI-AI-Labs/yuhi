/**
 * v0.3.3 Importance ranking + token-budget selection.
 *
 * Given a token budget and a set of source files (each already carrying deterministic
 * importance signals and pre-computed full/compressed token estimates), decide which
 * `ContextRepresentation` every file gets: kept FULL, COMPRESSED, or EXCLUDED to fit.
 *
 * This module is purely arithmetic and DETERMINISTIC:
 *   - it never parses code (that is the SourceCompressors' job),
 *   - it never decides that a file is junk (that happens upstream; junk arrives already
 *     flagged via `alreadyExcluded`),
 *   - the same inputs — in ANY order — always yield the same decisions.
 *
 * The token budget is BEST-EFFORT. Essential (forced-FULL) files are never dropped to
 * fit a budget; if the essentials alone exceed the budget we keep them and warn.
 */

import type { ContextRepresentation } from "./types.js";

export interface BudgetFileInput {
  relpath: string;
  /** Estimated tokens of the full file. */
  fullTokens: number;
  /** Estimated tokens if compressed (absent = not compressible). */
  compressedTokens?: number;
  // deterministic importance signals (all optional booleans):
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
  /** Short deterministic reason for the decision. */
  reason: string;
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
  };
}

/**
 * Importance rank, high number = more important (kept longest, dropped last).
 *
 *   6  userIncluded / openOrSpecified   (user intent — never sacrificed for budget)
 *   5  entryPoint
 *   4  packageManifest / agentInstruction / configFile
 *   3  importantTestFixture
 *   2  compressible source
 *   1  other (plain full source, too-small, parse-failed, un-shrinkable)
 *
 * The value is used both to name the winning "essential" reason and, for the
 * non-essential files, to decide drop order when trimming to a budget.
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
  rank: number;
  /** Forced FULL — an essential file that is never excluded to fit a budget. */
  essential: boolean;
  /** Excluded upstream as junk — not counted toward originalTokens. */
  junk: boolean;
}

/** The first matching signal names the essential reason, in importance order. */
function essentialReason(f: BudgetFileInput, threshold: number): string | null {
  if (f.userIncluded) return "user-included";
  if (f.openOrSpecified) return "open-or-specified";
  if (f.entryPoint) return "entry-point";
  if (f.packageManifest) return "package-manifest";
  if (f.agentInstruction) return "agent-instruction";
  if (f.configFile) return "config-file";
  if (f.importantTestFixture) return "test-fixture";
  if (f.parseFailed) return "parse-failed";
  if (f.fullTokens <= threshold) return "too-small";
  return null;
}

/** Importance rank derived purely from signals + compressibility. */
function importanceRank(f: BudgetFileInput, compressible: boolean): number {
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
    // 1. Junk excluded upstream — always excluded, contributes 0, uncounted.
    if (input.alreadyExcluded) {
      return {
        input,
        relpath: input.relpath,
        fullTokens: input.fullTokens,
        representation: "excluded",
        reason: "excluded-upstream",
        finalTokens: 0,
        rank: IMPORTANCE_RANK.other,
        essential: false,
        junk: true,
      };
    }

    // 2. Classify: essential (forced FULL), compressible, or plain full.
    const forcedReason = essentialReason(input, threshold);
    const canCompress =
      input.compressedTokens !== undefined &&
      input.compressedTokens < input.fullTokens &&
      input.fullTokens > threshold;
    const compressible = forcedReason === null && canCompress;
    const rank = importanceRank(input, compressible);

    if (forcedReason !== null) {
      return {
        input,
        relpath: input.relpath,
        fullTokens: input.fullTokens,
        representation: "full",
        reason: forcedReason,
        finalTokens: input.fullTokens,
        rank,
        essential: true,
        junk: false,
      };
    }

    if (compressible) {
      return {
        input,
        relpath: input.relpath,
        fullTokens: input.fullTokens,
        representation: "compressed",
        reason: "compressed",
        finalTokens: input.compressedTokens as number,
        rank,
        essential: false,
        junk: false,
      };
    }

    // Full because it cannot be usefully compressed, but not essential.
    const reason =
      input.compressedTokens === undefined ? "not-compressible" : "compression-not-smaller";
    return {
      input,
      relpath: input.relpath,
      fullTokens: input.fullTokens,
      representation: "full",
      reason,
      finalTokens: input.fullTokens,
      rank,
      essential: false,
      junk: false,
    };
  });

  // 3. Everything is reserved: essentials full, compressibles compressed. Compute total.
  let preparedTokens = items.reduce((sum, it) => sum + it.finalTokens, 0);

  const warnings: string[] = [];

  // 4. Trim to the budget by dropping the lowest-importance non-essential files first.
  if (hasBudget && budget !== null && preparedTokens > budget) {
    const candidates = items
      .filter((it) => !it.essential && !it.junk && it.representation !== "excluded")
      .sort(
        (a, b) =>
          a.rank - b.rank || // lowest importance first
          b.fullTokens - a.fullTokens || // then largest full size first
          compareRelpath(a.relpath, b.relpath),
      );

    for (const it of candidates) {
      if (preparedTokens <= budget) break;
      preparedTokens -= it.finalTokens;
      it.representation = "excluded";
      it.reason = "budget";
      it.finalTokens = 0;
    }

    // 5. Best-effort: essentials alone may still exceed the budget — keep them, warn.
    if (preparedTokens > budget) {
      const essentialTokens = items
        .filter((it) => it.essential)
        .reduce((sum, it) => sum + it.finalTokens, 0);
      warnings.push(
        `Essential files require ${essentialTokens} tokens, which exceeds the token budget of ${budget}. Keeping essential files; budget is best-effort.`,
      );
    }
  }

  // Deterministic output order — independent of input order.
  const decisions: RepresentationDecision[] = items
    .map((it) => ({
      relpath: it.relpath,
      representation: it.representation,
      reason: it.reason,
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
    originalTokens === 0 ? 0 : ((originalTokens - preparedTokens) / originalTokens) * 100;

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
    },
  };
}
