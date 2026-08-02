/**
 * Deterministic Context ID (v0.3.4).
 *
 * The Context ID is the stable, agent-independent fingerprint of a prepared
 * context. It answers a single question: "is this the SAME prepared context?"
 * so that later Claude/Codex adapters can attach a per-run Agent Session to a
 * shared, deterministic context without re-computing or re-scanning anything.
 *
 * Format: `sha256:<hex>` (lowercase hex).
 *
 * INCLUDED (the identity of a prepared context):
 *   - Yuhi version
 *   - manifest / schema version
 *   - sorted SOURCE file relative paths + their content hashes
 *   - safety mode
 *   - policy inputs (policy hash)
 *   - compression on/off
 *   - token budget
 *   - relevant preparation options (reduction mode, compression threshold)
 *
 * EXCLUDED (must never influence the ID):
 *   - current time / createdAt
 *   - randomness (runId, session id)
 *   - user name / machine name
 *   - ABSOLUTE paths (only repo-relative paths are hashed)
 *   - the agent id and the agent session id
 *
 * Invariants (locked by context-id.test.ts):
 *   - same repo state + same prep settings ⇒ byte-identical Context ID
 *   - changing source content / safety mode / compression toggle / token budget
 *     ⇒ a different ID
 *   - changing ONLY the agent ⇒ the SAME ID
 */
import { createHash } from "node:crypto";
import type { SafetyMode } from "@yuhi/shared";

export const CONTEXT_ID_ALGORITHM = "sha256";
export const CONTEXT_ID_PREFIX = `${CONTEXT_ID_ALGORITHM}:`;

/**
 * Canonicalization version. Bump ONLY when the canonical serialization changes
 * in a way that must invalidate previously computed IDs.
 */
export const CONTEXT_ID_CANONICALIZATION_VERSION = 1;

/** One SOURCE file's contribution to the Context ID (repo-relative only). */
export interface ContextIdSourceFile {
  /** Repo-relative POSIX path. NEVER an absolute path. */
  relpath: string;
  /** SHA-256 of the source bytes, or null when not hashed (binary / large). */
  sha256: string | null;
  /** Source size in bytes — a stable discriminator when a content hash is absent. */
  size?: number | null;
}

/** The complete, deterministic input set for {@link computeContextId}. */
export interface ContextIdInput {
  yuhiVersion: string;
  manifestSchemaVersion: number;
  /** Source files (order-independent; sorted internally before hashing). */
  sourceFiles: readonly ContextIdSourceFile[];
  safetyMode: SafetyMode;
  /** Policy input fingerprint (e.g. the resolved policy hash used to prepare). */
  policyHash: string;
  /** Whether structure compression was enabled for this run. */
  compression: boolean;
  /** Token budget for the delivered context; null = no budget. */
  tokenBudget: number | null;
  /** Reduction aggressiveness mode (e.g. "balanced"). */
  reductionMode: string;
  /** Threshold (tokens) under which files stay full during compression. */
  compressionThresholdTokens?: number | null;
}

/**
 * Produce the canonical, deterministic serialization of a Context ID input.
 * Exposed for tests and debugging; {@link computeContextId} hashes this string.
 *
 * Determinism guarantees:
 *   - source files are sorted by relpath (locale-independent code-point order)
 *   - object keys are emitted in a fixed, explicit order (insertion order)
 *   - only the whitelisted, agent-independent fields participate
 */
export function canonicalizeContextIdInput(input: ContextIdInput): string {
  const sourceFiles = [...input.sourceFiles]
    .map((file) => ({
      relpath: file.relpath,
      sha256: file.sha256 ?? null,
      size: file.size ?? null,
    }))
    .sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));

  // Explicit, ordered, key-stable structure. JSON.stringify preserves the
  // insertion order of string keys, so this serialization is byte-stable.
  const canonical = {
    canonicalization: CONTEXT_ID_CANONICALIZATION_VERSION,
    yuhiVersion: input.yuhiVersion,
    manifestSchemaVersion: input.manifestSchemaVersion,
    safetyMode: input.safetyMode,
    policyHash: input.policyHash,
    compression: input.compression,
    tokenBudget: input.tokenBudget ?? null,
    reductionMode: input.reductionMode,
    compressionThresholdTokens: input.compressionThresholdTokens ?? null,
    sourceFiles,
  };
  return JSON.stringify(canonical);
}

/** Compute the deterministic Context ID (`sha256:<hex>`). */
export function computeContextId(input: ContextIdInput): string {
  const hex = createHash(CONTEXT_ID_ALGORITHM)
    .update(canonicalizeContextIdInput(input))
    .digest("hex");
  return `${CONTEXT_ID_PREFIX}${hex}`;
}

/** True when a string is a well-formed Context ID (`sha256:<64 hex>`). */
export function isContextId(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
