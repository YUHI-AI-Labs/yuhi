import { DEFAULT_PREPARE_SAFETY_MODE, isSafetyMode, type SafetyMode } from "@yuhi/shared";

// Re-export the field type so consumers can depend on @yuhi/config alone.
export type { SafetyMode } from "@yuhi/shared";

/**
 * Candidate Safety Mode values from each configuration layer, in the order they are
 * resolved. Each is left untyped/optional because it comes from a different source
 * (CLI string, parsed YAML, etc.); {@link resolveSafetyMode} validates them.
 */
export interface SafetyModeSources {
  /** Highest priority: the `--safety-mode` CLI flag (already read as a string). */
  cli?: string;
  /** Repository config: the `safetyMode` field from yuhi.yaml. */
  repo?: unknown;
  /**
   * User/global config layer. No such policy-config layer exists in this repo today
   * (`~/.yuhi` under {@link @yuhi/shared} holds only runtime data — workspaces, audit,
   * state — not a merged yuhi.yaml), so this slot is reserved for forward
   * compatibility and is ignored unless a valid value is supplied.
   */
  user?: unknown;
}

/**
 * Resolve the effective Safety Mode using the priority order
 * **CLI arg > repository config (yuhi.yaml) > user/global config > balanced**.
 *
 * Only valid {@link SafetyMode} values are honored: an invalid lower-priority value
 * falls through to the next source. An invalid CLI value also falls through here —
 * rejecting a bad CLI flag is the caller's responsibility; this helper only resolves
 * already-valid inputs. When no source yields a valid mode, the default
 * (`balanced`) is returned.
 *
 * This returns the internal value only. For display, pass the result to
 * `safetyModeLabel` from @yuhi/core — display strings are never hardcoded here.
 */
export function resolveSafetyMode(sources: SafetyModeSources = {}): SafetyMode {
  for (const candidate of [sources.cli, sources.repo, sources.user]) {
    if (isSafetyMode(candidate)) return candidate;
  }
  return DEFAULT_PREPARE_SAFETY_MODE;
}
