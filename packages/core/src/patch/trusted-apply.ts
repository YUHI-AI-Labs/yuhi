import * as path from "node:path";
import { promises as fs } from "node:fs";

import { applyPatchAtomically, type PatchOperationResult } from "./apply.js";
import { computePatchId } from "./provenance.js";
import {
  loadPatchSession,
  materializePatchSelection,
  reviewPatchSession,
} from "./session.js";

/**
 * Narrow, session-scoped Source-write request. Callers provide identities and
 * user selections only. File content, destinations, hashes, risk and
 * eligibility are deliberately not part of this boundary.
 */
export interface ApplyPatchSessionInput {
  managedBase: string;
  runId: string;
  sessionId: string;
  selectedRelpaths: readonly string[];
  hunkSelections?: Readonly<Record<string, readonly string[]>>;
  expectedPatchId: string;
  expectedSnapshotId: string;
  expectedSourceBaselineId: string;
  expectedPreparedWorkingTreeId: string;
}

function reject(code: string): never {
  throw new Error(code);
}

function assertIdentity(actual: string, expected: string, code: string): void {
  if (actual !== expected) reject(code);
}

/**
 * Final trusted Apply boundary.
 *
 * It reloads private state, reconstructs the current review from filesystem
 * bytes, checks every review identity, materializes only the requested
 * files/hunks into private state, then confirms that the Prepared Working Tree
 * did not change during materialization. No caller-supplied PatchChange is ever
 * used for a Source mutation.
 */
export async function applyPatchSession(
  input: ApplyPatchSessionInput,
): Promise<PatchOperationResult> {
  if (input.selectedRelpaths.length === 0) reject("patch-selection-empty");
  const selected = new Set(input.selectedRelpaths);
  if (selected.size !== input.selectedRelpaths.length) reject("patch-selection-duplicate");

  const state = await loadPatchSession(input.managedBase, input.runId, input.sessionId);
  const review = await reviewPatchSession(state);
  assertIdentity(state.snapshotId, input.expectedSnapshotId, "patch-snapshot-stale");
  assertIdentity(state.sourceBaselineId, input.expectedSourceBaselineId, "patch-source-baseline-stale");
  assertIdentity(review.preparedWorkingTreeId, input.expectedPreparedWorkingTreeId, "patch-working-tree-stale");
  assertIdentity(review.patch.patchId, input.expectedPatchId, "patch-review-stale");

  const byRelpath = new Map(review.changes.map((change) => [change.relpath, change]));
  for (const relpath of selected) {
    const change = byRelpath.get(relpath);
    if (!change) reject("patch-selection-stale");
    if (change.applyEligibility === "blocked") reject("patch-selection-ineligible");
  }
  for (const [relpath, hunkIds] of Object.entries(input.hunkSelections ?? {})) {
    if (!selected.has(relpath)) reject("patch-hunk-selection-stale");
    const known = new Set((review.hunksByRelpath[relpath] ?? []).map((hunk) => hunk.hunkId));
    if (hunkIds.some((hunkId) => !known.has(hunkId))) reject("patch-hunk-stale");
  }

  const materialized = await materializePatchSelection(
    state,
    review,
    input.selectedRelpaths,
    input.hunkSelections,
  );
  try {
    // Close the review-to-materialization race. Atomic Apply independently
    // repeats Source/path/hash/policy checks immediately before each mutation.
    const finalReview = await reviewPatchSession(state);
    assertIdentity(finalReview.preparedWorkingTreeId, review.preparedWorkingTreeId, "patch-working-tree-stale");
    assertIdentity(finalReview.patch.patchId, review.patch.patchId, "patch-review-stale");

    const patchId = computePatchId(
      review.patch.contextId,
      review.patch.revisionId,
      materialized.changes,
    );
    return await applyPatchAtomically({
      patchId,
      sourceRoot: state.sourceRoot,
      preparedRoot: materialized.preparedRoot,
      privateRoot: path.join(path.resolve(input.managedBase), ".internal"),
      changes: materialized.changes,
    });
  } finally {
    await fs.rm(materialized.preparedRoot, { recursive: true, force: true });
  }
}
