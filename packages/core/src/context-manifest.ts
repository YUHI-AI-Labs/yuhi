/**
 * Context Manifest contract (v0.3.4).
 *
 * Yuhi separates two manifests that used to be conflated:
 *
 *   1. Context Manifest  — DETERMINISTIC. The identity + shape of a prepared
 *      context. Same repo state + same prep settings ⇒ same Context Manifest
 *      (modulo intentionally non-deterministic bookkeeping the on-disk manifest
 *      keeps, such as `runId`/`createdAt`, which are NOT part of the PUBLIC
 *      projection below). Owned by core. Written to `<prepared>/manifest.json`.
 *
 *   2. Agent Session Manifest — PER-RUN. sessionId, contextId, agent, working
 *      directory, status. Owned by @yuhi/agents (one per adapter launch).
 *
 * This module defines the Context Manifest's STABLE PUBLIC shape and a projector
 * that derives it from the raw on-disk manifest. The public projection MUST NOT
 * contain: absolute paths, user/machine names, raw command args, environment
 * values, or any personal info. It copies only whitelisted, repo-relative,
 * aggregate-safe fields — never spreads unknown keys.
 */
import path from "node:path";
import { YUHI_VERSION, type SafetyMode, isSafetyMode } from "@yuhi/shared";
import { isContextId } from "./context-id.js";

export type ContextRepresentation = "full" | "compressed" | "excluded";

/** One file line in the PUBLIC Context Manifest — repo-relative, metadata only. */
export interface ContextManifestFileEntry {
  /** Repo-relative POSIX path. Absolute paths are rejected by the projector. */
  relpath: string;
  action: string;
  status: string;
  transmission: string;
  omitted: boolean;
  transformed: boolean;
  contextRepresentation?: ContextRepresentation;
}

/** The STABLE, public-safe Context Manifest. */
export interface ContextManifest {
  schemaVersion: number;
  /** Deterministic, agent-independent Context ID (`sha256:<hex>`). */
  contextId: string;
  generator: { name: "Yuhi"; version: string };
  source: { reductionMode: string; safetyMode: SafetyMode };
  policy: { safetyMode: SafetyMode };
  summary: {
    files: number;
    transformedFiles: number;
    excludedFiles: number;
  };
  files: ContextManifestFileEntry[];
  warnings: string[];
}

/** Loose view of the on-disk manifest (`manifest.json`) fields we project from. */
interface RawManifestLike {
  schemaVersion?: unknown;
  contextId?: unknown;
  reductionMode?: unknown;
  safetyMode?: unknown;
  files?: unknown;
  warnings?: unknown;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

function toRepresentation(value: unknown): ContextRepresentation | undefined {
  return value === "full" || value === "compressed" || value === "excluded" ? value : undefined;
}

function toWarnings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (value && typeof value === "object") {
    // The on-disk manifest stores `warnings` as a small count map; expose stable,
    // content-free category strings only when a count is non-zero.
    return Object.entries(value as Record<string, unknown>)
      .filter(([, count]) => typeof count === "number" && count > 0)
      .map(([category]) => category)
      .sort();
  }
  return [];
}

/**
 * Project the raw on-disk manifest into the STABLE, public-safe Context Manifest.
 * Throws when the manifest lacks a valid Context ID (a manifest predating v0.3.4,
 * or a tampered file) so callers never emit a Context Manifest without an identity.
 */
export function toPublicContextManifest(raw: unknown): ContextManifest {
  const m = (raw ?? {}) as RawManifestLike;
  if (!isContextId(m.contextId)) {
    throw new Error("Context Manifest is missing a valid contextId (sha256:<hex>).");
  }
  const safetyMode: SafetyMode = isSafetyMode(m.safetyMode) ? m.safetyMode : "balanced";
  const rawFiles = Array.isArray(m.files) ? (m.files as Record<string, unknown>[]) : [];

  const files: ContextManifestFileEntry[] = rawFiles
    .map((file) => ({
      relpath: str(file.relpath),
      action: str(file.action),
      status: str(file.status),
      transmission: str(file.transmission),
      omitted: bool(file.omitted),
      transformed: bool(file.transformed),
      ...(toRepresentation(file.contextRepresentation)
        ? { contextRepresentation: toRepresentation(file.contextRepresentation) }
        : {}),
    }))
    // Defense in depth: a public manifest must never carry an absolute path.
    .filter((file) => file.relpath !== "" && !path.isAbsolute(file.relpath));

  return {
    schemaVersion: typeof m.schemaVersion === "number" ? m.schemaVersion : 2,
    contextId: m.contextId,
    generator: { name: "Yuhi", version: YUHI_VERSION },
    source: { reductionMode: str(m.reductionMode, "balanced"), safetyMode },
    policy: { safetyMode },
    summary: {
      files: files.length,
      transformedFiles: files.filter((f) => f.transformed && !f.omitted).length,
      excludedFiles: files.filter((f) => f.omitted).length,
    },
    files,
    warnings: toWarnings(m.warnings),
  };
}
