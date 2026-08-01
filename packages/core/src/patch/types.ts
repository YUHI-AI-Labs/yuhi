export type PreparedRepresentation = "full" | "compressed" | "background-artifact";

export interface PreparedSnapshotFile {
  /** POSIX repository-relative path. Never an absolute path. */
  relpath: string;
  sha256: string;
  sizeBytes: number;
  representation: PreparedRepresentation;
  /** Permission bits only; ownership and machine-specific metadata are excluded. */
  mode: number;
  binary: boolean;
  /** Unsupported filesystem entry detected without following or reading it. */
  unsafeType?: "symlink" | "special";
}

export interface PreparedSnapshot {
  contextId: string;
  revisionId: string;
  createdFromRunId: string;
  files: PreparedSnapshotFile[];
}

export type PatchChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "mode-changed"
  | "binary";

export type PatchApplyEligibility = "eligible" | "requires-review" | "blocked";
export type PatchRisk = "low" | "review" | "high" | "blocked";

export type PatchReasonCode =
  | "patch-added"
  | "patch-modified"
  | "patch-deleted"
  | "patch-renamed"
  | "patch-binary"
  | "patch-compressed-source"
  | "patch-background-artifact"
  | "patch-source-changed"
  | "patch-path-escape"
  | "patch-symlink"
  | "patch-secret-added"
  | "patch-pii-added"
  | "patch-sensitive-config"
  | "patch-generated-large-file"
  | "patch-unsupported-mode"
  | "patch-eligible"
  | "patch-apply-failed"
  | "patch-applied"
  | "patch-undone"
  | "patch-undo-conflict";

export interface PatchChange {
  relpath: string;
  kind: PatchChangeKind;
  previousRelpath?: string;
  beforeHash?: string;
  afterHash?: string;
  beforeSizeBytes?: number;
  afterSizeBytes?: number;
  beforeMode?: number;
  afterMode?: number;
  representation: PreparedRepresentation;
  applyEligibility: PatchApplyEligibility;
  risk?: PatchRisk;
  sourceChanged?: boolean;
  unsafeType?: "symlink" | "special";
  reasonCodes: PatchReasonCode[];
}

export interface PatchManifest {
  schemaVersion: 1;
  patchId: string;
  contextId: string;
  revisionId: string;
  sourceBaselineId: string;
  agentSessionId?: string;
  agentId?: "claude" | "codex";
  changes: PatchChange[];
}
