/**
 * v0.3.2 Safety Mode — a real core preset that shapes the EFFECTIVE preparation
 * policy. One mapping in core so the CLI, VS Code, reports, and tests share the
 * same behavior (never scattered UI conditionals).
 *
 * The three modes are strictly ordered — each withholds a SUPERSET of the one
 * below it:
 *
 *   Balanced          block secrets, convert documents, de-identify tables,
 *                     include verified source, include unverified WITH a warning.
 *   Strict            Balanced, plus keep sensitive/PII structured data local and
 *                     keep unverifiable/oversized content local (nothing unverified
 *                     reaches the agent).
 *   Maximum Privacy   Strict, plus keep non-source binaries/archives/media local and
 *                     deliver only zero-finding, verified content (close to allowlist).
 *
 * The transform is ESCALATE-ONLY: it appends more-restrictive rules and never
 * removes or weakens an existing rule. Because the policy engine is
 * most-restrictive-wins (ADR-0003), appended `local-only` rules can only raise a
 * file's restrictiveness — so `delivered(Balanced) ⊇ delivered(Strict) ⊇
 * delivered(Maximum Privacy)` holds by construction, and a hard `block` is never
 * downgraded by any mode.
 */
import type { Action, PolicyRule } from "@yuhi/shared";
import {
  SAFETY_MODES,
  DEFAULT_PREPARE_SAFETY_MODE,
  isSafetyMode,
  safetyModeLabel,
  type SafetyMode,
} from "@yuhi/shared";

// The Safety Mode vocabulary (type, values, default, guard, label) lives in
// @yuhi/shared so @yuhi/config can use it without a config↔core cycle. Re-export it
// here so existing `import { SafetyMode, ... } from "@yuhi/core"` call sites keep working.
export { SAFETY_MODES, DEFAULT_PREPARE_SAFETY_MODE, isSafetyMode, safetyModeLabel, type SafetyMode };

/** Structured-data / PII detectors kept local from Strict up (credentials are already
 *  blocked or redacted by the base policy, so they are not repeated here). */
const SENSITIVE_STRUCTURED_DETECTORS = [
  "tabular-direct-identifier-column",
  "tabular-headerless-sensitive-data",
  "tabular-malformed-sensitive-data",
];

/** Non-source binary / archive / media types Maximum Privacy keeps local by default.
 *  Office/PDF documents are intentionally NOT here — the companion pipeline delivers a
 *  sanitized Markdown companion only on verified success, which every mode allows. */
const NON_SOURCE_BINARY_GLOBS = [
  "**/*.zip", "**/*.tar", "**/*.tar.gz", "**/*.tgz", "**/*.gz", "**/*.bz2", "**/*.7z", "**/*.rar",
  "**/*.jar", "**/*.war", "**/*.bin", "**/*.exe", "**/*.dll", "**/*.so", "**/*.dylib", "**/*.o", "**/*.a",
  "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.gif", "**/*.webp", "**/*.bmp", "**/*.ico", "**/*.svg",
  "**/*.mp3", "**/*.mp4", "**/*.mov", "**/*.avi", "**/*.wav", "**/*.woff", "**/*.woff2", "**/*.ttf", "**/*.eot",
  "**/*.wasm", "**/*.sqlite", "**/*.db", "**/*.parquet",
];

function localOnlyRule(name: string, match: PolicyRule["match"], reason: string): PolicyRule {
  return { name, match, action: "local-only", reason };
}

export interface EffectivePolicy {
  defaultAction: Action;
  rules: PolicyRule[];
}

/**
 * Derive the effective policy for a Safety Mode by APPENDING restrictive rules to
 * the base policy. Balanced returns the base unchanged. The base rules always come
 * first so an explicit user `block` still wins; the appended rules only escalate.
 */
export function applySafetyMode(base: EffectivePolicy, mode: SafetyMode): EffectivePolicy {
  if (mode === "balanced") return { defaultAction: base.defaultAction, rules: [...base.rules] };

  const extra: PolicyRule[] = [
    localOnlyRule(
      "yuhi-safety-sensitive-structured",
      { detectors: SENSITIVE_STRUCTURED_DETECTORS },
      "Strict/Maximum Privacy keeps likely PII and sensitive structured data local.",
    ),
  ];

  if (mode === "maximum-privacy") {
    extra.push(
      localOnlyRule(
        "yuhi-safety-non-source-binaries",
        { paths: NON_SOURCE_BINARY_GLOBS },
        "Maximum Privacy keeps binaries, archives, media, and datastores local by default.",
      ),
    );
  }

  return { defaultAction: base.defaultAction, rules: [...base.rules, ...extra] };
}

/**
 * Prepare-loop hook: does this mode forbid delivering content that could not be
 * fully inspected/verified (oversized passthrough, unsupported binary passthrough,
 * structural transform failure)? True for Strict and Maximum Privacy — such files
 * are kept local instead of delivered with a warning.
 */
export function escalatesUnverified(mode: SafetyMode): boolean {
  return mode !== "balanced";
}

/**
 * Prepare-loop hook: does this mode require delivered files to be zero-finding?
 * True only for Maximum Privacy — a file whose safely-transformed copy still
 * carried any sensitive finding is kept local rather than delivered.
 */
export function requiresZeroFindings(mode: SafetyMode): boolean {
  return mode === "maximum-privacy";
}
