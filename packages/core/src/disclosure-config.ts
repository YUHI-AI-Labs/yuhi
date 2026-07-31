/**
 * v0.3 disclosure configuration + migration from a v0.2.9 manifest.
 *
 * The config holds the user's Workspace-level intent (Safety Mode, default Context
 * Detail, local-AI capability config, and per-file / folder / type overrides). It is
 * pure data — persistence and UI live elsewhere. Migration maps an existing v0.2.9
 * prepared manifest into disclosure records without ever weakening a security state:
 * verifiable sanitized artifacts are preserved, anything uncertain becomes
 * pending-review, and hard blocks stay blocked.
 */
import {
  resolveDisclosure,
  type ContextDetail,
  type DisclosureDecision,
  type DisclosureInput,
  type DisclosureRecord,
  type DisclosureSafetyMode,
  DEFAULT_CONTEXT_DETAIL,
  DEFAULT_DISCLOSURE_SAFETY_MODE,
  CONTEXT_DETAILS,
  DISCLOSURE_SAFETY_MODES,
} from "./disclosure.js";

/** Capability-based local-AI config (no hard-coded model name in core logic). */
export interface LocalAiConfig {
  enabled: boolean;
  provider: "ollama";
  summaryModel: string | null;
  maxConcurrentRequests: number;
  requestTimeoutMs: number;
  cacheEnabled: boolean;
}

export interface DisclosureConfig {
  version: 1;
  safetyMode: DisclosureSafetyMode;
  defaultContextDetail: ContextDetail;
  localAI: LocalAiConfig;
  /** Per-file overrides keyed by stable fileId (never a raw absolute path). */
  fileOverrides: Record<string, { decision?: DisclosureDecision; contextDetail?: ContextDetail }>;
  /** Folder-prefix rules (fileId prefix -> decision). */
  folderRules: Record<string, DisclosureDecision>;
  /** File-type/glob rules (extension or glob -> decision). */
  typeRules: Record<string, DisclosureDecision>;
}

export const DEFAULT_LOCAL_AI: LocalAiConfig = {
  enabled: true,
  provider: "ollama",
  summaryModel: null,
  maxConcurrentRequests: 2,
  requestTimeoutMs: 30_000,
  cacheEnabled: true,
};

export const DEFAULT_DISCLOSURE_CONFIG: DisclosureConfig = {
  version: 1,
  safetyMode: DEFAULT_DISCLOSURE_SAFETY_MODE,
  defaultContextDetail: DEFAULT_CONTEXT_DETAIL,
  localAI: DEFAULT_LOCAL_AI,
  fileOverrides: {},
  folderRules: {},
  typeRules: {},
};

function isDisclosureSafetyMode(v: unknown): v is DisclosureSafetyMode {
  return typeof v === "string" && (DISCLOSURE_SAFETY_MODES as readonly string[]).includes(v);
}
function isContextDetail(v: unknown): v is ContextDetail {
  return typeof v === "string" && (CONTEXT_DETAILS as readonly string[]).includes(v);
}

/** Parse an untrusted stored config into a safe, fully-populated config. Never throws;
 *  unknown/invalid fields fall back to defaults (fail safe toward Balanced/Standard). */
export function parseDisclosureConfig(raw: unknown): DisclosureConfig {
  const cfg: DisclosureConfig = {
    ...DEFAULT_DISCLOSURE_CONFIG,
    localAI: { ...DEFAULT_LOCAL_AI },
    fileOverrides: {},
    folderRules: {},
    typeRules: {},
  };
  if (!raw || typeof raw !== "object") return cfg;
  const o = raw as Record<string, unknown>;
  if (isDisclosureSafetyMode(o.safetyMode)) cfg.safetyMode = o.safetyMode;
  if (isContextDetail(o.defaultContextDetail)) cfg.defaultContextDetail = o.defaultContextDetail;
  if (o.localAI && typeof o.localAI === "object") {
    const l = o.localAI as Record<string, unknown>;
    if (typeof l.enabled === "boolean") cfg.localAI.enabled = l.enabled;
    if (l.summaryModel === null || typeof l.summaryModel === "string") cfg.localAI.summaryModel = l.summaryModel;
    if (typeof l.maxConcurrentRequests === "number" && l.maxConcurrentRequests > 0) {
      cfg.localAI.maxConcurrentRequests = Math.min(8, Math.floor(l.maxConcurrentRequests));
    }
    if (typeof l.requestTimeoutMs === "number" && l.requestTimeoutMs > 0) {
      cfg.localAI.requestTimeoutMs = Math.min(300_000, Math.floor(l.requestTimeoutMs));
    }
    if (typeof l.cacheEnabled === "boolean") cfg.localAI.cacheEnabled = l.cacheEnabled;
  }
  for (const [key, src] of [["fileOverrides", o.fileOverrides], ["folderRules", o.folderRules], ["typeRules", o.typeRules]] as const) {
    if (src && typeof src === "object") {
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        if (key === "fileOverrides" && v && typeof v === "object") {
          const ov = v as Record<string, unknown>;
          const entry: { decision?: DisclosureDecision; contextDetail?: ContextDetail } = {};
          if (typeof ov.decision === "string") entry.decision = ov.decision as DisclosureDecision;
          if (isContextDetail(ov.contextDetail)) entry.contextDetail = ov.contextDetail;
          cfg.fileOverrides[k] = entry;
        } else if (key !== "fileOverrides" && typeof v === "string") {
          cfg[key][k] = v as DisclosureDecision;
        }
      }
    }
  }
  return cfg;
}

/** A single file entry from a v0.2.9 prepared manifest (only the fields we read). */
export interface LegacyManifestFile {
  relpath: string;
  outcome?: string;
  omitted?: boolean;
  failureCategory?: string;
  finalRescanVerified?: boolean;
  document?: { deliveredArtifactType?: string; residualNameRisk?: boolean; originalSharedWithAgent?: boolean };
}

/** Map a v0.2.9 manifest file entry to the security facts the resolver needs. */
export function deriveDisclosureInput(file: LegacyManifestFile, fileId: string): DisclosureInput {
  const failure = file.failureCategory;
  const hardBlocked = failure === "unresolved-secret";
  const survivingStructuredPii =
    failure === "reidentification-risk" && file.finalRescanVerified === false && !file.document;
  const sanitizedArtifactAvailable =
    file.outcome === "included-transformed" ||
    file.outcome === "included-unchanged" ||
    file.document?.deliveredArtifactType?.startsWith("sanitized-") === true;
  return {
    fileId,
    fileType: file.document?.deliveredArtifactType ? "document" : "file",
    hardBlocked,
    policyExcluded: !hardBlocked && file.omitted === true,
    unverified: file.outcome === "included-unverified" && !file.document,
    unsupported: failure === "structural" && !file.document,
    survivingStructuredPii,
    residualRisk: file.document?.residualNameRisk === true || survivingStructuredPii,
    sanitizedArtifactAvailable,
  };
}

/** Stable, non-sensitive file id derived from the relative path (no raw path stored). */
export function fileIdFor(relpath: string): string {
  // Simple deterministic hash — avoids persisting an unsafe original filename.
  let h = 2166136261;
  for (let i = 0; i < relpath.length; i++) {
    h ^= relpath.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return "f" + (h >>> 0).toString(36);
}

export interface MigrationResult {
  config: DisclosureConfig;
  records: DisclosureRecord[];
  /** Files that could not be verified and were set to pending-review. */
  pendingReview: number;
}

/**
 * Migrate a v0.2.9 manifest into v0.3 disclosure records. Defaults to Balanced /
 * Standard. Verifiable sanitized artifacts keep an include recommendation; hard
 * blocks stay blocked; anything uncertain becomes pending-review. Never mutates the
 * source workspace (pure).
 */
export function migrateWorkspaceDisclosure(
  files: readonly LegacyManifestFile[],
  existingConfig?: unknown,
): MigrationResult {
  const config = parseDisclosureConfig(existingConfig ?? {});
  const records: DisclosureRecord[] = [];
  let pendingReview = 0;
  for (const file of files) {
    const fileId = fileIdFor(file.relpath);
    const input = deriveDisclosureInput(file, fileId);
    const override = config.fileOverrides[fileId];
    const rec = resolveDisclosure(input, config.safetyMode, {
      defaultContextDetail: config.defaultContextDetail,
      ...(override?.decision ? { userDecision: override.decision } : {}),
      ...(override?.contextDetail ? { userContextDetail: override.contextDetail } : {}),
    });
    if (rec.effectiveDecision === "pending-review") pendingReview += 1;
    records.push(rec);
  }
  return { config, records, pendingReview };
}
