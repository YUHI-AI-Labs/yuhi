import { createHash } from "node:crypto";
import type { PatchChange, PatchManifest, PreparedSnapshot } from "./types.js";

function comparePath(a: PatchChange, b: PatchChange): number {
  return a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0;
}

export function canonicalizePatchIdentity(
  contextId: string,
  revisionId: string,
  changes: readonly PatchChange[],
): string {
  return JSON.stringify({
    contextId,
    revisionId,
    changes: [...changes].sort(comparePath).map((change) => ({
      relpath: change.relpath,
      kind: change.kind,
      beforeHash: change.beforeHash ?? null,
      afterHash: change.afterHash ?? null,
    })),
  });
}

export function computePatchId(contextId: string, revisionId: string, changes: readonly PatchChange[]): string {
  return `sha256:${createHash("sha256").update(canonicalizePatchIdentity(contextId, revisionId, changes)).digest("hex")}`;
}

/** Stable baseline identity. The run id is provenance and intentionally excluded. */
export function computePreparedSnapshotId(snapshot: PreparedSnapshot): string {
  const canonical = JSON.stringify({
    contextId: snapshot.contextId,
    revisionId: snapshot.revisionId,
    files: [...snapshot.files].sort((a, b) => a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0).map((file) => ({
      relpath: file.relpath,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      representation: file.representation,
      mode: file.mode,
      binary: file.binary,
    })),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export interface CreatePatchManifestInput {
  contextId: string;
  revisionId: string;
  sourceBaselineId: string;
  changes: readonly PatchChange[];
  agentSessionId?: string;
  agentId?: "claude" | "codex";
}

export function createPatchManifest(input: CreatePatchManifestInput): PatchManifest {
  const changes = [...input.changes].sort(comparePath);
  return {
    schemaVersion: 1,
    patchId: computePatchId(input.contextId, input.revisionId, changes),
    contextId: input.contextId,
    revisionId: input.revisionId,
    sourceBaselineId: input.sourceBaselineId,
    ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    changes,
  };
}
