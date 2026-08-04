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
 *    counts, per-item {status, documentId, kind, reasonCode, preparedRelpath} plus
 *    a `relpath` ONLY for an original the agent already has (otherwise a kind-only
 *    `displayName`), revision, revisionId. It NEVER contains an absolute path,
 *    staging path, provider detail, raw error, environment, username, machine name,
 *    or the filename of a file whose original was withheld.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { documentIdFor, withheldDisplayName } from "../metadata-boundary.js";
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

/**
 * Per-item projection in the PUBLIC status — path-safe fields only.
 *
 * `relpath` is present ONLY for a file the agent can already see in its tree. When
 * the original was withheld, the item is identified by `documentId` + the kind-only
 * `displayName` instead: the filename of a withheld file is itself identifying data.
 */
export interface PublicStatusItem {
  relpath?: string;
  /** Stable public identity of the source document (`doc-<hex>`). Always present. */
  documentId?: string;
  /** Kind-only public label (`doc-<hex>.pdf`), used when there is no `relpath`. */
  displayName?: string;
  kind: BackgroundPreparationKind;
  status: BackgroundPreparationStatus;
  reasonCode?: BackgroundReasonCode;
  /** Repo-relative path of the published companion (safe); present when completed. */
  preparedRelpath?: string;
  originalSharedWithWarning?: boolean;
}

/**
 * Background accounting, with FILE counts and JOB counts kept apart (#14/#15).
 *
 * One source PDF can legitimately produce several jobs — a text extraction and an
 * OCR pass — and the old `total` counted jobs while every consumer read it as a
 * file count, so a single document appeared twice. `sourceDocuments` answers "how
 * many of my files is this about"; the `*Jobs` fields answer "how much work is
 * there". Never mix them.
 */
export interface BackgroundAccounting {
  /** Distinct source documents represented, deduplicated by `documentId`. */
  sourceDocuments: number;
  /** Total inspection jobs across those documents (may exceed `sourceDocuments`). */
  inspectionJobs: number;
  pendingJobs: number;
  processingJobs: number;
  completedJobs: number;
  failedJobs: number;
  cancelledJobs: number;
  /** Companions actually published (a completed job with a delivered artifact). */
  companionsCreated: number;
  /** Distinct documents whose original stayed local with no companion. */
  keptLocalDocuments: number;
  /** Distinct documents whose original was delivered with a warning, companion absent. */
  companionUnavailableDocuments: number;
}

/** The whole PUBLIC status document. Path-safe by construction. */
export interface PublicBackgroundStatus {
  schemaVersion: 1;
  counts: {
    /** DEPRECATED name kept for compatibility: this is a JOB count, not a file count.
     *  Read `accounting.inspectionJobs` / `accounting.sourceDocuments` instead. */
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    keptLocal: number;
    companionUnavailable: number;
    cancelled: number;
  };
  /** File-vs-job split. Authoritative for every surface. */
  accounting: BackgroundAccounting;
  /** Terminal when no job is pending or processing. */
  activity: "idle" | "running";
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
    // METADATA BOUNDARY: the item's own `relpath` is the PRIVATE source path. It may
    // cross into the public status only when that exact path was delivered to the
    // agent; otherwise the agent gets an identity + a kind, never a name.
    const documentId = item.documentId ?? documentIdFor(item.relpath, item.contextId);
    projected.push({
      ...(item.publicRelpath
        ? { relpath: item.publicRelpath }
        : { displayName: withheldDisplayName(item.relpath, documentId) }),
      documentId,
      kind: item.kind,
      status: item.status,
      ...(item.reasonCode ? { reasonCode: item.reasonCode } : {}),
      ...(item.preparedRelpath ? { preparedRelpath: item.preparedRelpath } : {}),
      ...(item.originalSharedWithWarning ? { originalSharedWithWarning: true } : {}),
    });
  }
  // Deduplicate by documentId so one PDF is one document however many jobs it has.
  const documents = new Set<string>();
  const keptLocalDocs = new Set<string>();
  const companionUnavailableDocs = new Set<string>();
  let companionsCreated = 0;
  for (const item of projected) {
    const id = item.documentId ?? item.displayName ?? item.relpath ?? "";
    if (id) documents.add(id);
    if (item.status === "completed" && item.preparedRelpath) companionsCreated += 1;
    if (item.status !== "pending" && item.status !== "processing" &&
        item.status !== "completed" && item.status !== "failed" && item.status !== "cancelled") {
      if (item.originalSharedWithWarning) companionUnavailableDocs.add(id);
      else keptLocalDocs.add(id);
    }
  }
  const accounting: BackgroundAccounting = {
    sourceDocuments: documents.size,
    inspectionJobs: items.length,
    pendingJobs: counts.pending,
    processingJobs: counts.processing,
    completedJobs: counts.completed,
    failedJobs: counts.failed,
    cancelledJobs: counts.cancelled,
    companionsCreated,
    keptLocalDocuments: keptLocalDocs.size,
    companionUnavailableDocuments: companionUnavailableDocs.size,
  };
  return {
    schemaVersion: 1,
    counts,
    accounting,
    // A job in a TERMINAL state is not work in progress. Reporting "running" while
    // every item was already kept-local left the UI spinning forever.
    activity: counts.pending + counts.processing > 0 ? "running" : "idle",
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
