import type { Action, Destination } from "./actions.js";
import type { ProcessorSpec } from "./processors.js";
import type { FileCapabilities } from "./file-capabilities.js";

/** Severity used by scanner findings and risk summaries. */
export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

/** A single detector hit. NEVER contains the raw secret value. */
export interface ScanFinding {
  /** Detector id, e.g. "aws-access-key-id", "high-entropy-string". */
  detector: string;
  /** Repo-relative POSIX path of the file. */
  path: string;
  /** 1-based line where the match starts (best-effort). */
  line?: number;
  severity: Severity;
  /** Masked, safe-to-display preview such as "AKIA****************". */
  maskedPreview: string;
  /** Short human explanation, e.g. "Looks like an AWS access key id". */
  description: string;
}

/** File-level flags produced by the scanner (not secret detection). */
export interface FileFlags {
  isBinary: boolean;
  isSymlink: boolean;
  symlinkTarget?: string;
  /** Larger than the configured large-file threshold. */
  isLarge: boolean;
  /** Tracked by git (undefined when not a git repo). */
  tracked?: boolean;
}

export interface FileInfo {
  /** Repo-relative POSIX path. */
  relpath: string;
  /** Absolute, resolved filesystem path. */
  absPath: string;
  size: number;
  /** SHA-256 of the source bytes when read (text, not large). Used by diff/status. */
  sha256?: string;
  flags: FileFlags;
  findings: ScanFinding[];
  inspection: FileCapabilities & {
    inspectionAttempted: boolean;
    inspectionSucceeded: boolean;
    contentVerified: boolean;
  };
  /** Metadata-only document inspection result. Extracted text is never persisted here. */
  documentInspection?: DocumentInspectionResult;
}

export type DocumentExtractionMethod = "pdf-text" | "ocr" | "none";

export interface DocumentInspectionResult {
  status: "inspected" | "unavailable" | "failed";
  extractedTextAvailable: boolean;
  extractionMethod: DocumentExtractionMethod;
  pageCount?: number;
  /** Stable, content-free warning categories only. */
  warnings: string[];
}

export interface DocumentInspectionFile {
  relpath: string;
  absPath: string;
}

export interface DocumentInspector {
  canInspect(file: DocumentInspectionFile): boolean;
  /**
   * Extracted text is delivered only to this in-memory consumer and is never
   * part of the returned/persisted result.
   */
  inspect(
    file: DocumentInspectionFile,
    consumeExtractedText: (text: string) => void,
  ): Promise<DocumentInspectionResult>;
}

export interface ScanResult {
  root: string;
  filesInspected: number;
  files: FileInfo[];
  findings: ScanFinding[];
  riskSummary: Record<Severity, number>;
  /** Non-fatal issues (skipped symlinks, unreadable files…). */
  warnings: string[];
}

/** The action decision for a single file, with provenance for `explain`. */
export interface FileDecision {
  relpath: string;
  action: Action;
  /** The rule that won (or a synthetic name like "default" / "detector:<id>"). */
  ruleName: string;
  reason: string;
  destinations: Destination[];
  findings: ScanFinding[];
  /** For `prepare-locally`: the processor pipeline from the winning rule. */
  processors?: ProcessorSpec[];
}

export interface PolicyEvaluation {
  decisions: FileDecision[];
  /** decisions grouped by action for rendering. */
  byAction: Record<Action, FileDecision[]>;
}

/** One entry in a generated workspace manifest. */
export interface ManifestFile {
  relpath: string;
  action: Action;
  ruleName: string;
  sourceSha256: string;
  /** null when the file is transformed such that output differs / or not copied. */
  outputSha256: string | null;
  /** true when redaction actually changed bytes. */
  transformed: boolean;
  bytes: number;
}

export interface WorkspaceManifest {
  id: string;
  createdAt: string;
  yuhiVersion: string;
  policyHash: string;
  agent: string;
  source: {
    path: string;
    /** Hash of the *original* tree (relpaths + per-file source hashes). */
    treeHash: string;
    isGitRepo: boolean;
  };
  workspacePath: string;
  files: ManifestFile[];
  symlinksSkipped: string[];
  blocked: string[];
  localOnly: string[];
  counts: {
    visible: number;
    transformed: number;
    blocked: number;
    localOnly: number;
    symlinksSkipped: number;
  };
}

/** Local, metadata-only audit record. Never contains file contents or secrets. */
export interface AuditRecord {
  id: string;
  timestamp: string;
  yuhiVersion: string;
  policyHash: string;
  agent: string;
  source: { pathHash: string; isGitRepo: boolean };
  workspaceId: string | null;
  counts: {
    inspected: number;
    visible: number;
    transformed: number;
    blocked: number;
    localOnly: number;
  };
  appliedRules: string[];
  exitCode: number | null;
  durationMs: number | null;
  outcome: "previewed" | "created" | "ran" | "error";
}

// ---- Agent adapter contracts ----

export interface AgentRunContext {
  agentId: string;
  /** The generated workspace the agent will run in. */
  workspacePath: string;
  /** Extra args to forward to the underlying CLI (everything after `--`). */
  forwardedArgs: string[];
  /** Environment variables explicitly permitted to reach the child. */
  env: NodeJS.ProcessEnv;
  interactive: boolean;
}

export interface AgentCommand {
  /** Executable file (resolved). */
  file: string;
  /** argv array — NEVER a shell string. */
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ValidationResult {
  ok: boolean;
  problems: string[];
}

export interface AgentAdapter {
  id: string;
  displayName: string;
  /** Is the underlying CLI installed & runnable? */
  detect(): Promise<boolean>;
  /** Shown to the user when detect() is false. */
  installHint(): string;
  validate(ctx: AgentRunContext): Promise<ValidationResult>;
  buildCommand(ctx: AgentRunContext): Promise<AgentCommand>;
}
