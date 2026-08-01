/**
 * v0.3.5 private/public boundary for background preparation state.
 *
 * There are two distinct locations, and the split is a SECURITY boundary:
 *
 *  - PRIVATE state — the queue's per-item records, the cancel flag, and the
 *    pre-inspection staging dir. These carry absolute `sourceArtifactPath`s,
 *    staging paths, provider details, and raw errors, so they MUST live OUTSIDE
 *    every agent-visible prepared root. They are stored under the managed base
 *    (`<managedBase>/.internal/background/<runId>/`), which is never a prepared
 *    workspace the agent opens.
 *
 *  - PUBLIC status — a single JSON file inside the agent-visible root
 *    (`<preparedDir>/.yuhi/background-status.json`). It is the ONLY background
 *    surface the agent / CLI / UI reads, and it contains ONLY path-safe fields:
 *    counts, per-item {status, relpath, kind, reasonCode, preparedRelpath},
 *    revision, revisionId. It NEVER contains an absolute path, staging path,
 *    provider detail, raw error, environment, username, or machine name.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  BackgroundPreparationKind,
  BackgroundPreparationStatus,
  BackgroundReasonCode,
  PublicBackgroundItem,
} from "./types.js";

/** Private root for a run's background state — OUTSIDE any agent-visible root. */
export function privateBackgroundDir(managedBase: string, runId: string): string {
  return path.join(path.resolve(managedBase), ".internal", "background", runId);
}

/** Private staging dir (pre-inspection bytes) — under the private root, same volume. */
export function privateStagingDir(managedBase: string, runId: string): string {
  return path.join(privateBackgroundDir(managedBase, runId), "staging");
}

/** The agent-visible public status file inside the prepared root. */
export function publicStatusPath(preparedDir: string): string {
  return path.join(path.resolve(preparedDir), ".yuhi", "background-status.json");
}

/** Per-item projection in the PUBLIC status — path-safe fields only. */
export interface PublicStatusItem {
  relpath: string;
  kind: BackgroundPreparationKind;
  status: BackgroundPreparationStatus;
  reasonCode?: BackgroundReasonCode;
  /** Repo-relative path of the published companion (safe); present when completed. */
  preparedRelpath?: string;
  originalSharedWithWarning?: boolean;
}

/** The whole PUBLIC status document. Path-safe by construction. */
export interface PublicBackgroundStatus {
  schemaVersion: 1;
  counts: {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    keptLocal: number;
    companionUnavailable: number;
    cancelled: number;
  };
  revision: number;
  revisionId?: string;
  items: PublicStatusItem[];
}

/** Build the public status from the queue's public projection (+ optional revision). */
export function buildPublicStatus(
  items: readonly PublicBackgroundItem[],
  revision: { revision: number; revisionId?: string } = { revision: 0 },
): PublicBackgroundStatus {
  const counts = {
    total: items.length,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    keptLocal: 0,
    companionUnavailable: 0,
    cancelled: 0,
  };
  const projected: PublicStatusItem[] = [];
  for (const item of items) {
    switch (item.status) {
      case "pending":
        counts.pending += 1;
        break;
      case "processing":
        counts.processing += 1;
        break;
      case "completed":
        counts.completed += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "cancelled":
        counts.cancelled += 1;
        break;
      default:
        // A missing companion is not "kept local" when Balanced already made the
        // original available with an explicit warning.
        if (item.originalSharedWithWarning) counts.companionUnavailable += 1;
        else counts.keptLocal += 1;
        break;
    }
    projected.push({
      relpath: item.relpath,
      kind: item.kind,
      status: item.status,
      ...(item.reasonCode ? { reasonCode: item.reasonCode } : {}),
      ...(item.preparedRelpath ? { preparedRelpath: item.preparedRelpath } : {}),
      ...(item.originalSharedWithWarning ? { originalSharedWithWarning: true } : {}),
    });
  }
  return {
    schemaVersion: 1,
    counts,
    revision: revision.revision,
    ...(revision.revisionId ? { revisionId: revision.revisionId } : {}),
    items: projected,
  };
}

/** Atomically (write-temp + rename) write the public status into the prepared root. */
export async function writePublicStatus(
  preparedDir: string,
  status: PublicBackgroundStatus,
): Promise<void> {
  const target = publicStatusPath(preparedDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(status, null, 2) + "\n", "utf8");
  await fs.rename(tmp, target);
}

/** Read the public status (undefined when missing/unparseable). */
export async function readPublicStatus(
  preparedDir: string,
): Promise<PublicBackgroundStatus | undefined> {
  try {
    const raw = await fs.readFile(publicStatusPath(preparedDir), "utf8");
    return JSON.parse(raw) as PublicBackgroundStatus;
  } catch {
    return undefined;
  }
}
