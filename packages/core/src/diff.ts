import type { Action } from "@yuhi/shared";
import type { Plan } from "./plan.js";
import { snapshotFromPlan, loadSnapshot, type ContextSnapshot } from "./state.js";

export interface ContextChange {
  relpath: string;
  kind: "added" | "removed" | "action-changed" | "content-changed";
  before?: Action;
  after?: Action;
}

export interface ContextDiff {
  hasPrevious: boolean;
  previousAt: string | null;
  changes: ContextChange[];
  counts: { added: number; removed: number; actionChanged: number; contentChanged: number };
}

/** Compare the current plan against the last saved context snapshot. */
export function diffAgainstSnapshot(plan: Plan, previous: ContextSnapshot | null): ContextDiff {
  const current = snapshotFromPlan(plan);
  const changes: ContextChange[] = [];

  if (!previous) {
    return {
      hasPrevious: false,
      previousAt: null,
      changes: [],
      counts: { added: 0, removed: 0, actionChanged: 0, contentChanged: 0 },
    };
  }

  const prevFiles = previous.files;
  const curFiles = current.files;

  for (const [rel, cur] of Object.entries(curFiles)) {
    const prev = prevFiles[rel];
    if (!prev) {
      changes.push({ relpath: rel, kind: "added", after: cur.action });
    } else if (prev.action !== cur.action) {
      changes.push({ relpath: rel, kind: "action-changed", before: prev.action, after: cur.action });
    } else if (prev.hash !== cur.hash) {
      changes.push({ relpath: rel, kind: "content-changed", after: cur.action });
    }
  }
  for (const rel of Object.keys(prevFiles)) {
    if (!curFiles[rel]) {
      changes.push({ relpath: rel, kind: "removed", before: prevFiles[rel]!.action });
    }
  }

  changes.sort((a, b) => (a.relpath < b.relpath ? -1 : 1));
  return {
    hasPrevious: true,
    previousAt: previous.createdAt,
    changes,
    counts: {
      added: changes.filter((c) => c.kind === "added").length,
      removed: changes.filter((c) => c.kind === "removed").length,
      actionChanged: changes.filter((c) => c.kind === "action-changed").length,
      contentChanged: changes.filter((c) => c.kind === "content-changed").length,
    },
  };
}

/** Convenience: load the stored snapshot and diff against it. */
export function diffContext(plan: Plan): ContextDiff {
  return diffAgainstSnapshot(plan, loadSnapshot(plan.scan.root));
}
