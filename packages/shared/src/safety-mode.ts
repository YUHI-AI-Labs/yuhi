/**
 * Safety Mode — the user-facing preparation preset. Lives in @yuhi/shared (the
 * lowest package) so BOTH @yuhi/config and @yuhi/core can reference it without a
 * dependency cycle. The dependency direction is: shared ← config ← core.
 *
 * This module holds only the vocabulary (type, values, default, guard, label).
 * The policy transform that turns a mode into an effective preparation policy
 * (`applySafetyMode`) and the prepare-loop hooks live in @yuhi/core.
 */
export type SafetyMode = "balanced" | "strict" | "maximum-privacy";

export const SAFETY_MODES: readonly SafetyMode[] = ["balanced", "strict", "maximum-privacy"];

export const DEFAULT_PREPARE_SAFETY_MODE: SafetyMode = "balanced";

export function isSafetyMode(v: unknown): v is SafetyMode {
  return typeof v === "string" && (SAFETY_MODES as readonly string[]).includes(v);
}

/** Human display name for the UI / reports (internal value stays lowercase-kebab). */
export function safetyModeLabel(mode: SafetyMode): string {
  switch (mode) {
    case "strict":
      return "Strict";
    case "maximum-privacy":
      return "Maximum Privacy";
    case "balanced":
    default:
      return "Balanced";
  }
}
