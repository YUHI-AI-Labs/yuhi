/**
 * v0.3 disclosure-decision model — "You decide what the AI can see".
 *
 * Pure, deterministic resolution of what happens to each prepared file, independent
 * of any UI. Two orthogonal axes:
 *   - Safety Mode (strict | balanced | open) — how cautious the recommendation is.
 *   - Context Detail (full-sanitized | standard | compact) — how much is shared.
 *
 * Resolution priority (highest wins):
 *   1. hard security block (credentials/keys/explicit block) — NEVER overridable
 *   2. explicit per-file user decision
 *   3. folder-level user rule
 *   4. file-type / glob rule
 *   5. Safety Mode recommendation
 *   6. default policy
 * A user decision can never override a hard security block (invariant #3/#20.3).
 */

export type DisclosureSafetyMode = "strict" | "balanced" | "open";
export type ContextDetail = "full-sanitized" | "standard" | "compact";

export type DisclosureDecision =
  | "include-full-sanitized"
  | "include-standard"
  | "include-compact"
  | "exclude-user"
  | "exclude-policy"
  | "pending-review"
  | "blocked";

export const DISCLOSURE_SAFETY_MODES: readonly DisclosureSafetyMode[] = ["strict", "balanced", "open"];
export const CONTEXT_DETAILS: readonly ContextDetail[] = ["full-sanitized", "standard", "compact"];
export const DEFAULT_DISCLOSURE_SAFETY_MODE: DisclosureSafetyMode = "balanced";
export const DEFAULT_CONTEXT_DETAIL: ContextDetail = "standard";

/** The security-relevant facts about a prepared file, derived from processing. */
export interface DisclosureInput {
  /** Stable non-sensitive id (e.g. relative-path hash) — never a raw absolute path. */
  fileId: string;
  fileType: string;
  /** A hard, non-overridable security block (credential/private key/explicit block). */
  hardBlocked: boolean;
  hardBlockReason?: string;
  /** Policy excluded (local-only) but not a hard security block. */
  policyExcluded: boolean;
  /** Yuhi could not verify the content (over scan cap, unsupported inspection…). */
  unverified: boolean;
  /** The type is not locally inspectable/transformable at all (unknown binary…). */
  unsupported: boolean;
  /** A structured identifier survived into the final artifact (should be excluded). */
  survivingStructuredPii: boolean;
  /** Residual free-text identity risk remains (companion text with possible names). */
  residualRisk: boolean;
  /** Local processing produced a usable sanitized artifact (companion / transformed). */
  sanitizedArtifactAvailable: boolean;
}

/** Explicit user choices that can steer resolution (never past a hard block). */
export interface DisclosureOverrides {
  /** Workspace-default context detail. */
  defaultContextDetail?: ContextDetail;
  /** Per-file explicit decision (highest user priority). */
  userDecision?: DisclosureDecision | null;
  /** Per-file context-detail override. */
  userContextDetail?: ContextDetail | null;
  /** Folder-rule decision (lower priority than a per-file decision). */
  folderDecision?: DisclosureDecision | null;
  /** File-type/glob-rule decision (lowest user priority). */
  typeDecision?: DisclosureDecision | null;
}

export interface DisclosureRecord {
  fileId: string;
  recommendation: DisclosureDecision;
  recommendationReason: string;
  userDecision: DisclosureDecision | null;
  effectiveDecision: DisclosureDecision;
  overrideAllowed: boolean;
  contextDetail: ContextDetail;
  /** Who determined the effective decision. */
  decidedBy: "policy" | "user" | "folder" | "type" | "recommendation";
}

const INCLUDE_DECISIONS: ReadonlySet<DisclosureDecision> = new Set([
  "include-full-sanitized",
  "include-standard",
  "include-compact",
]);

export function isIncludeDecision(d: DisclosureDecision): boolean {
  return INCLUDE_DECISIONS.has(d);
}

/** Map a context detail to its include decision. */
function includeFor(detail: ContextDetail): DisclosureDecision {
  return detail === "full-sanitized"
    ? "include-full-sanitized"
    : detail === "compact"
      ? "include-compact"
      : "include-standard";
}

/** Yuhi's recommendation for a file under a given Safety Mode (before user input). */
function recommend(
  input: DisclosureInput,
  mode: DisclosureSafetyMode,
  detail: ContextDetail,
): { decision: DisclosureDecision; reason: string; overrideAllowed: boolean } {
  // 1. Hard security block — identical in every mode, never overridable.
  if (input.hardBlocked) {
    return {
      decision: "blocked",
      reason: input.hardBlockReason ?? "Hard security block (credential/private key/policy)",
      overrideAllowed: false,
    };
  }
  // 2. Explicit non-hard policy exclusion (local-only).
  if (input.policyExcluded) {
    return { decision: "exclude-policy", reason: "Excluded by policy (kept local)", overrideAllowed: mode === "open" };
  }
  // 3. A surviving structured identifier is unsafe to share in any mode.
  if (input.survivingStructuredPii) {
    return mode === "strict"
      ? { decision: "exclude-policy", reason: "Structured personal identifier survived — excluded in Strict", overrideAllowed: false }
      : { decision: "pending-review", reason: "Structured personal identifier may survive — needs review", overrideAllowed: true };
  }
  // 4. Unsupported / unverified content.
  if (input.unsupported || (input.unverified && !input.sanitizedArtifactAvailable)) {
    if (mode === "strict") {
      return { decision: "exclude-policy", reason: "Unverified/unsupported content — excluded in Strict", overrideAllowed: false };
    }
    return { decision: "pending-review", reason: "Unverified/unsupported content — needs review", overrideAllowed: true };
  }
  // 5. Sanitized artifact available.
  if (input.sanitizedArtifactAvailable) {
    if (input.residualRisk && mode === "strict") {
      return { decision: "pending-review", reason: "Sanitized, but residual free-text identity risk — review in Strict", overrideAllowed: true };
    }
    const reason = input.residualRisk
      ? "Sanitized; residual free-text identity risk remains"
      : "Sanitized locally";
    return { decision: includeFor(detail), reason, overrideAllowed: true };
  }
  // 6. Default: nothing sensitive detected, plain content.
  return { decision: includeFor(detail), reason: "No sensitive content detected", overrideAllowed: true };
}

/**
 * Resolve the effective disclosure decision for a file. Deterministic and pure.
 * A hard block (overrideAllowed=false) is always final — user/folder/type decisions
 * are ignored for it.
 */
export function resolveDisclosure(
  input: DisclosureInput,
  mode: DisclosureSafetyMode = DEFAULT_DISCLOSURE_SAFETY_MODE,
  overrides: DisclosureOverrides = {},
): DisclosureRecord {
  const contextDetail =
    overrides.userContextDetail ?? overrides.defaultContextDetail ?? DEFAULT_CONTEXT_DETAIL;
  const rec = recommend(input, mode, contextDetail);

  // A user/folder/type decision applies ONLY when override is allowed (never past a
  // hard block), in strict priority order: per-file user > folder > type.
  let effective = rec.decision;
  let decidedBy: DisclosureRecord["decidedBy"] = "recommendation";
  const userDecision = overrides.userDecision ?? null;
  if (rec.overrideAllowed) {
    if (userDecision) {
      effective = userDecision;
      decidedBy = "user";
    } else if (overrides.folderDecision) {
      effective = overrides.folderDecision;
      decidedBy = "folder";
    } else if (overrides.typeDecision) {
      effective = overrides.typeDecision;
      decidedBy = "type";
    }
  } else {
    // Non-overridable recommendation (hard block / strict exclusion) is authoritative.
    decidedBy = "policy";
  }

  // Safety net: a decision may never turn a hard block into anything shareable.
  if (input.hardBlocked) {
    effective = "blocked";
    decidedBy = "policy";
  }

  return {
    fileId: input.fileId,
    recommendation: rec.decision,
    recommendationReason: rec.reason,
    userDecision,
    effectiveDecision: effective,
    overrideAllowed: rec.overrideAllowed,
    contextDetail,
    decidedBy,
  };
}
