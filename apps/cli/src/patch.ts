import * as path from "node:path";

import {
  applyPatchSession,
  discardPreparedChanges,
  loadPatchSession,
  managedWorkspaceBaseDir,
  patchHistory,
  privatePatchSessionDir,
  reviewPatchSession,
  undoPatch,
  type PatchChange,
  type PatchReviewResult,
} from "@yuhi/core";
import { resolveRunForLaunch, type RunResolution } from "./launch.js";

export interface PatchCommandOptions {
  runRef?: string;
  json?: boolean;
  files?: readonly string[];
  patchId?: string;
  confirmApply?: (count: number) => Promise<boolean>;
  resolveRun?: (ref: string | undefined) => Promise<RunResolution>;
  managedBase?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

interface ResolvedReview {
  managedBase: string;
  privateRoot: string;
  runId: string;
  preparedRoot: string;
  state: Awaited<ReturnType<typeof loadPatchSession>>;
  review: PatchReviewResult;
}

function safeChange(change: PatchChange): object {
  return {
    relpath: change.relpath,
    kind: change.kind,
    ...(change.previousRelpath ? { previousRelpath: change.previousRelpath } : {}),
    representation: change.representation,
    applyEligibility: change.applyEligibility,
    risk: change.risk ?? "blocked",
    sourceChanged: change.sourceChanged === true,
    beforeSizeBytes: change.beforeSizeBytes ?? 0,
    afterSizeBytes: change.afterSizeBytes ?? 0,
    reasonCodes: change.reasonCodes,
  };
}

function safeReview(review: PatchReviewResult): object {
  return {
    schemaVersion: 1,
    preparedWorkingTreeId: review.preparedWorkingTreeId,
    snapshotId: review.snapshotId,
    patchId: review.patch.patchId,
    contextId: review.patch.contextId,
    revisionId: review.patch.revisionId,
    changedFileCount: review.changes.length,
    counts: review.counts,
    applyAllowed: review.applyAllowed,
    changes: review.changes.map(safeChange),
  };
}

async function resolveReview(opts: PatchCommandOptions): Promise<ResolvedReview | undefined> {
  const resolve = opts.resolveRun ?? resolveRunForLaunch;
  const resolution = await resolve(opts.runRef);
  if (!resolution.ok) return undefined;
  const managedBase = opts.managedBase ?? managedWorkspaceBaseDir();
  const state = await loadPatchSession(managedBase, resolution.run.session.runId);
  return {
    managedBase,
    privateRoot: path.join(managedBase, ".internal"),
    runId: resolution.run.session.runId,
    preparedRoot: resolution.run.workspace,
    state,
    review: await reviewPatchSession(state),
  };
}

function print(opts: PatchCommandOptions, value: unknown, text: string): void {
  (opts.out ?? console.log)(opts.json ? JSON.stringify(value, null, 2) : text);
}

function fail(
  opts: PatchCommandOptions,
  command: string,
  category: string,
  text: string,
  exitCode = 3,
): number {
  const value = { schemaVersion: 1, command, status: "failed", errorCategory: category };
  (opts.err ?? console.error)(opts.json ? JSON.stringify(value, null, 2) : text);
  return exitCode;
}

export async function patchStatus(opts: PatchCommandOptions): Promise<number> {
  const resolved = await resolveReview(opts).catch(() => undefined);
  if (!resolved) {
    return fail(
      opts,
      "patch-status",
      "patch-session-not-found",
      "Patch review unavailable\n\nSafe error category: patch-session-not-found",
    );
  }
  const value = { command: "patch-status", ...safeReview(resolved.review) };
  print(
    opts,
    value,
    [
      "AI changes detected",
      `${resolved.review.changes.length} files changed`,
      `Low ${resolved.review.counts.low} · Review ${resolved.review.counts.review} · High ${resolved.review.counts.high} · Blocked ${resolved.review.counts.blocked}`,
    ].join("\n"),
  );
  return 0;
}

export async function patchDiff(opts: PatchCommandOptions): Promise<number> {
  const resolved = await resolveReview(opts).catch(() => undefined);
  if (!resolved) return fail(opts, "patch-diff", "patch-session-not-found", "Patch diff unavailable.");
  const selected = opts.files?.length
    ? resolved.review.changes.filter((change) => opts.files!.includes(change.relpath))
    : resolved.review.changes;
  const diffs = selected.flatMap((change) => {
    const diff = resolved.review.diffsByRelpath[change.relpath];
    return diff ? [diff] : [];
  });
  // Core produced this representation after masking. Raw filesystem bytes never
  // cross the CLI review boundary, including for blocked changes.
  const value = {
    command: "patch-diff",
    patchId: resolved.review.patch.patchId,
    preparedWorkingTreeId: resolved.review.preparedWorkingTreeId,
    changes: selected.map(safeChange),
    diffs,
  };
  print(
    opts,
    value,
    diffs.map((diff) => [
      `--- baseline/${diff.relpath}`,
      `+++ agent/${diff.relpath}`,
      ...diff.before.split("\n").map((line) => `- ${line}`),
      ...diff.after.split("\n").map((line) => `+ ${line}`),
    ].join("\n")).join("\n") || "No changes.",
  );
  return 0;
}

export async function patchValidate(opts: PatchCommandOptions): Promise<number> {
  const resolved = await resolveReview(opts).catch(() => undefined);
  if (!resolved) return fail(opts, "patch-validate", "patch-session-not-found", "Patch validation unavailable.");
  const value = { command: "patch-validate", ...safeReview(resolved.review) };
  print(opts, value, resolved.review.applyAllowed ? "Validation passed." : "Some changes are blocked.");
  return resolved.review.counts.blocked > 0 ? 2 : 0;
}

export async function patchApply(opts: PatchCommandOptions): Promise<number> {
  const resolved = await resolveReview(opts).catch(() => undefined);
  if (!resolved) return fail(opts, "patch-apply", "patch-session-not-found", "Patch Apply unavailable.");
  const requested = new Set(opts.files ?? []);
  const selected = resolved.review.changes.filter(
    (change) =>
      (requested.size === 0 || requested.has(change.relpath)) &&
      change.applyEligibility !== "blocked",
  );
  if (selected.length === 0) {
    return fail(opts, "patch-apply", "patch-selection-ineligible", "No eligible reviewed changes selected.", 2);
  }
  if (!(await opts.confirmApply?.(selected.length))) {
    print(opts, { command: "patch-apply", status: "cancelled" }, "Apply cancelled.");
    return 2;
  }
  const result = await applyPatchSession({
    managedBase: resolved.managedBase,
    runId: resolved.runId,
    sessionId: resolved.state.sessionId,
    selectedRelpaths: selected.map((change) => change.relpath),
    expectedPatchId: resolved.review.patch.patchId,
    expectedSnapshotId: resolved.review.snapshotId,
    expectedSourceBaselineId: resolved.review.patch.sourceBaselineId,
    expectedPreparedWorkingTreeId: resolved.review.preparedWorkingTreeId,
  }).catch(() => undefined);
  if (!result) {
    return fail(
      opts,
      "patch-apply",
      "patch-review-stale-or-unsafe",
      "Apply blocked because the reviewed session became stale or unsafe.",
    );
  }
  print(opts, { command: "patch-apply", ...result }, result.status === "applied"
    ? `${result.applied.length} files applied safely.`
    : "Apply failed. No success was recorded.");
  return result.status === "applied" ? 0 : 3;
}

export async function patchDiscard(opts: PatchCommandOptions): Promise<number> {
  const resolved = await resolveReview(opts).catch(() => undefined);
  if (!resolved) return fail(opts, "patch-discard", "patch-session-not-found", "Patch discard unavailable.");
  const baselineRoot = path.join(
    privatePatchSessionDir(resolved.managedBase, resolved.runId, resolved.state.sessionId),
    "prepared-baseline",
  );
  const discarded = await discardPreparedChanges(
    resolved.preparedRoot,
    baselineRoot,
    resolved.review.changes,
  );
  print(opts, { command: "patch-discard", status: "discarded", files: discarded }, `${discarded.length} agent changes discarded.`);
  return 0;
}

export async function patchUndoCommand(opts: PatchCommandOptions): Promise<number> {
  if (!opts.patchId) return fail(opts, "patch-undo", "patch-id-required", "Patch ID is required.");
  const managedBase = opts.managedBase ?? managedWorkspaceBaseDir();
  const result = await undoPatch(path.join(managedBase, ".internal"), opts.patchId).catch(() => undefined);
  if (!result) return fail(opts, "patch-undo", "patch-history-not-found", "Patch history unavailable.");
  const message = result.status === "undone"
    ? "Patch undone."
    : result.status === "undo-rolled-back"
      ? "Undo failed, and Yuhi restored the pre-undo Source state."
      : result.status === "undo-rollback-failed"
        ? "Undo recovery required. Yuhi retained private recovery material."
        : "Undo blocked by a source conflict.";
  print(opts, { command: "patch-undo", ...result }, message);
  return result.status === "undone" ? 0 : 3;
}

export async function patchHistoryCommand(opts: PatchCommandOptions): Promise<number> {
  const managedBase = opts.managedBase ?? managedWorkspaceBaseDir();
  const entries = await patchHistory(path.join(managedBase, ".internal"));
  print(opts, { command: "patch-history", entries }, entries.map((entry) => `${entry.patchId} ${entry.status} ${entry.files.length}`).join("\n") || "No patch history.");
  return 0;
}
