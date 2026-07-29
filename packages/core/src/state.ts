import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateDir, sha256, type Action } from "@yuhi/shared";
import type { Plan } from "./plan.js";

export interface ContextSnapshotEntry {
  action: Action;
  /** Source content hash (or "size:N" fallback for unread files). */
  hash: string;
}

export interface ContextSnapshot {
  root: string;
  createdAt: string;
  agent: string;
  files: Record<string, ContextSnapshotEntry>;
}

function snapshotPath(root: string): string {
  return path.join(stateDir(), sha256(path.resolve(root)).slice(0, 16) + ".json");
}

/** Build the per-file signature (action + content hash) from a resolved plan. */
export function snapshotFromPlan(plan: Plan): ContextSnapshot {
  const sizeByPath = new Map(plan.scan.files.map((f) => [f.relpath, f]));
  const files: Record<string, ContextSnapshotEntry> = {};
  for (const d of plan.evaluation.decisions) {
    const f = sizeByPath.get(d.relpath);
    files[d.relpath] = {
      action: d.action,
      hash: f?.sha256 ?? `size:${f?.size ?? 0}`,
    };
  }
  return {
    root: plan.scan.root,
    createdAt: new Date().toISOString(),
    agent: plan.agentId,
    files,
  };
}

export function saveSnapshot(snapshot: ContextSnapshot): void {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(snapshotPath(snapshot.root), JSON.stringify(snapshot), { mode: 0o600 });
}

export function loadSnapshot(root: string): ContextSnapshot | null {
  const p = snapshotPath(root);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ContextSnapshot;
  } catch {
    return null;
  }
}
