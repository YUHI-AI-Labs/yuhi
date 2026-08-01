/**
 * Yuhi v0.3.5 "Progressive Context" — the REVISION layer.
 *
 * A prepared context has ONE immutable identity — the deterministic Context ID
 * (`report.contextId`). Background preparation (document extraction, OCR, local
 * summarization) keeps running AFTER Yuhi Mode launches and, when a result passes
 * the safety-gated publisher, adds a sanitized companion artifact to the
 * agent-visible workspace. That progression must be observable WITHOUT ever
 * mutating the base Context ID.
 *
 * This module models that progression:
 *
 *   - `baseContextId`  — stays byte-identical no matter how many background
 *                        artifacts complete. It answers "same prepared context?".
 *   - `revision`       — 0 at prepare; +1 for each safely-published artifact.
 *   - `revisionId`     — a deterministic `sha256:<hex>` over the immutable
 *                        `baseContextId` PLUS the SORTED set of safely-published
 *                        background artifacts (repo-relative path + content hash)
 *                        up to this revision. It answers "exactly WHICH delivered
 *                        set — base + published companions — is this?".
 *
 * The base delivered state is represented by the immutable `baseContextId` itself
 * (which is ALREADY the deterministic, agent-invariant fingerprint of the prepared
 * base workspace — `report.contextId`). Folding it in means callers no longer need
 * to re-hash the base prepared files per call site: the revisionId is complete and
 * identical no matter which call site (worker, VS Code, CLI, either agent) computes
 * it. It changes ONLY when the published safe-artifact set changes.
 *
 * revisionId INCLUDES:
 *   - the immutable `baseContextId` (the deterministic base fingerprint)
 *   - sorted repo-relative POSIX paths of the safely-published artifacts
 *   - each published artifact's content hash (sha256, normalized) when known
 *   - a canonicalization version tag
 *
 * revisionId EXCLUDES (must never influence it):
 *   - `updatedAt` / wall-clock time / createdAt
 *   - machine name, user name
 *   - ABSOLUTE paths (only repo-relative paths participate)
 *   - agent id, agent session id, run id
 *   - randomness / UUIDs
 *
 * Consequence: the SAME base + published set yields a byte-identical revisionId
 * regardless of WHEN it was produced, on WHICH machine, by WHICH user, or for
 * WHICH agent (Claude / Codex) — because `baseContextId` is itself agent-invariant
 * and none of the excluded inputs participate. A `failed` / `timed-out` /
 * `cancelled` / `kept-local` background item publishes nothing, so it neither bumps
 * the revision nor changes the revisionId.
 */
import { createHash } from "node:crypto";

import type { PublicBackgroundItem } from "./types.js";

export const REVISION_ID_ALGORITHM = "sha256";
export const REVISION_ID_PREFIX = `${REVISION_ID_ALGORITHM}:`;

/**
 * Canonicalization version. Bump ONLY when the canonical serialization changes in
 * a way that must invalidate previously computed revisionIds.
 *
 * v2: the base delivered state is now represented by the immutable `baseContextId`
 * folded into the hash, replacing per-file base-prepared-file hashes.
 */
export const REVISION_ID_CANONICALIZATION_VERSION = 2;

/**
 * One file that has been safely PUBLISHED to the agent at a given revision — a
 * sanitized background companion artifact. Repo-relative only.
 */
export interface DeliveredFile {
  /** Repo-relative POSIX path. NEVER an absolute path. */
  relpath: string;
  /**
   * Content hash of the delivered bytes. Accepts bare hex or a `sha256:<hex>`
   * form; both are normalized to the same value so the revisionId is stable
   * across callers that format hashes differently.
   */
  sha256: string;
}

/** The immutable base id + incrementing, deterministic revision of a context. */
export interface ProgressiveContextState {
  /** == report.contextId. IMMUTABLE across background completion. */
  baseContextId: string;
  /** 0 at prepare; +1 for each safely-published (completed) artifact. */
  revision: number;
  /** Deterministic `sha256:<hex>` over the delivered file-set (see module doc). */
  revisionId: string;
  /** Background items that safely published an artifact. */
  completedItems: number;
  /** Background items still queued or in flight (pending / processing). */
  pendingItems: number;
  /** Terminal-but-unpublished items (failed / timed-out / cancelled / kept-local). */
  failedItems: number;
  /** Bookkeeping only — NOT part of revisionId. */
  updatedAt: string;
}

/**
 * Deterministic input to {@link computeRevisionId}: the immutable base fingerprint
 * plus the safely-published artifacts delivered on top of it.
 */
export interface RevisionIdInput {
  /** == report.contextId. The deterministic, agent-invariant base fingerprint. */
  baseContextId: string;
  /** The safely-published background companion artifacts (repo-relative). */
  files: readonly DeliveredFile[];
}

/** Normalize a content hash so `abc` and `sha256:abc` (any case) compare equal. */
function normalizeHash(value: string): string {
  const s = (value ?? "").trim().toLowerCase();
  return s.startsWith(REVISION_ID_PREFIX) ? s.slice(REVISION_ID_PREFIX.length) : s;
}

/** Locale-independent code-point comparison (matches the Context ID ordering). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Produce the canonical, deterministic serialization of the delivered set: the
 * immutable base fingerprint plus the safely-published artifacts. Exposed for
 * tests/debugging; {@link computeRevisionId} hashes this string.
 *
 * Determinism guarantees:
 *   - the immutable `baseContextId` is emitted first (it stands in for the whole
 *     base delivered state — no per-base-file hashing needed)
 *   - published files are sorted by relpath (code-point order)
 *   - duplicate relpaths collapse to the LAST occurrence
 *   - object keys are emitted in a fixed order (insertion order)
 */
export function canonicalizeRevisionIdInput(input: RevisionIdInput): string {
  const byRelpath = new Map<string, string>();
  for (const file of input.files) {
    byRelpath.set(file.relpath, normalizeHash(file.sha256));
  }
  const files = [...byRelpath.entries()]
    .map(([relpath, sha256]) => ({ relpath, sha256 }))
    .sort((a, b) => compareStrings(a.relpath, b.relpath));

  return JSON.stringify({
    canonicalization: REVISION_ID_CANONICALIZATION_VERSION,
    baseContextId: input.baseContextId,
    files,
  });
}

/** Compute the deterministic revisionId (`sha256:<hex>`) from base + published set. */
export function computeRevisionId(input: RevisionIdInput): string {
  const hex = createHash(REVISION_ID_ALGORITHM)
    .update(canonicalizeRevisionIdInput(input))
    .digest("hex");
  return `${REVISION_ID_PREFIX}${hex}`;
}

/** True when a string is a well-formed revisionId (`sha256:<64 hex>`). */
export function isRevisionId(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

/** Bucketing: statuses that are terminal-but-unpublished all count as "failed". */
function isPublished(item: PublicBackgroundItem): boolean {
  return item.status === "completed";
}

/** Input to the pure reducer that derives a {@link ProgressiveContextState}. */
export interface ProgressiveContextInput {
  /**
   * == report.contextId — copied through untouched AND folded into the revisionId
   * to represent the immutable base delivered state (no base-file hashes needed).
   */
  baseContextId: string;
  /** The queue's public projection (`BackgroundQueue.list()`). */
  backgroundItems: readonly PublicBackgroundItem[];
  /**
   * Content hash (sha256) of each safely-published artifact, keyed by its
   * `preparedRelpath`. A `completed` item still counts toward `revision` /
   * `completedItems` when its hash is absent, but then contributes an empty
   * content hash to the delivered set.
   */
  publishedArtifactHashes?: Readonly<Record<string, string>>;
  /** Injected clock for `updatedAt` ONLY (never influences revisionId). */
  now?: () => Date;
}

/**
 * Pure reducer: derive the {@link ProgressiveContextState} from the immutable
 * base id, the base prepared files, and the queue's public items.
 *
 * Rules:
 *   - `baseContextId` is copied through unchanged (never recomputed) AND folded
 *     into the revisionId to stand in for the whole base delivered state.
 *   - `revision` == the number of safely-published (`completed`) items. A
 *     `failed` / `timed-out` / `cancelled` / `kept-local` item does NOT bump it.
 *   - `revisionId` is computed over `baseContextId` PLUS every published artifact's
 *     `preparedRelpath` + content hash. It is order-independent and free of time /
 *     machine / user / agent / abspath.
 */
export function reduceProgressiveContextState(
  input: ProgressiveContextInput,
): ProgressiveContextState {
  let completedItems = 0;
  let pendingItems = 0;
  let failedItems = 0;

  for (const item of input.backgroundItems) {
    switch (item.status) {
      case "completed":
        completedItems += 1;
        break;
      case "pending":
      case "processing":
        pendingItems += 1;
        break;
      default:
        // failed / timed-out / cancelled / kept-local — terminal, unpublished.
        failedItems += 1;
        break;
    }
  }

  // The base delivered state is represented by the immutable baseContextId; only
  // the published artifacts are enumerated here. The order is sorted so the outcome
  // is input-order-independent.
  const published = input.backgroundItems
    .filter((it) => isPublished(it) && typeof it.preparedRelpath === "string" && it.preparedRelpath !== "")
    .map((it) => it.preparedRelpath as string)
    .sort(compareStrings);

  const delivered: DeliveredFile[] = published.map((relpath) => ({
    relpath,
    sha256: input.publishedArtifactHashes?.[relpath] ?? "",
  }));

  const revisionId = computeRevisionId({ baseContextId: input.baseContextId, files: delivered });
  const updatedAt = (input.now?.() ?? new Date()).toISOString();

  return {
    baseContextId: input.baseContextId,
    revision: completedItems,
    revisionId,
    completedItems,
    pendingItems,
    failedItems,
    updatedAt,
  };
}

/** Loose view of a persisted/raw progressive-context blob for the projector. */
interface RawProgressiveContextLike {
  baseContextId?: unknown;
  revision?: unknown;
  revisionId?: unknown;
  completedItems?: unknown;
  pendingItems?: unknown;
  failedItems?: unknown;
  updatedAt?: unknown;
}

function nonNegInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Project a raw/persisted progressive-context blob into the STABLE, public-safe
 * {@link ProgressiveContextState}. Whitelists fields only (never spreads unknown
 * keys), so no absolute path, machine, or user identity can leak. Returns
 * `undefined` when the blob lacks a valid base Context ID + revisionId.
 */
export function toPublicProgressiveContextState(
  raw: unknown,
): ProgressiveContextState | undefined {
  const r = (raw ?? {}) as RawProgressiveContextLike;
  const baseContextId = typeof r.baseContextId === "string" ? r.baseContextId : "";
  if (!/^sha256:[0-9a-f]{64}$/.test(baseContextId)) return undefined;
  if (!isRevisionId(r.revisionId)) return undefined;
  return {
    baseContextId,
    revision: nonNegInt(r.revision),
    revisionId: r.revisionId,
    completedItems: nonNegInt(r.completedItems),
    pendingItems: nonNegInt(r.pendingItems),
    failedItems: nonNegInt(r.failedItems),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
  };
}
