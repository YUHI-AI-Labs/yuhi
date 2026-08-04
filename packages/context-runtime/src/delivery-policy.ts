/**
 * Delivery policy — what a detected secret MEANS for delivery (v0.4.0).
 *
 * Until 0.3.x the answer was fixed: a credential was redacted or the file was withheld, in
 * every mode. v0.4.0 makes it a policy decision, because the fixed answer made Yuhi useless
 * for the thing developers actually do — ask an agent why the app cannot reach its API when
 * the answer is in `.env`.
 *
 * The distinction that keeps this honest:
 *
 *   detection      always runs, in every mode
 *   delivery       policy decides (Developer Mode: values reach the agent)
 *   evidence/UI    NEVER carries a raw value, in any mode
 *   hard blocks    private keys and similar material are refused regardless of mode
 *
 * The scanner has no idea any of this exists — it reports findings and nothing else. Modes
 * are composed here so a future Enterprise Strict Mode is a new policy object, not a new
 * branch inside detection.
 */

import type { PublicFinding } from "./safety.js";

export type DeliveryMode = "developer" | "strict";

/**
 * Material that is never useful to deliver and catastrophic to leak. Blocked in EVERY mode,
 * including Developer Mode: a `.env` value is a working credential the developer already
 * has, but a private key or seed phrase is key material whose disclosure is unbounded.
 */
export const HARD_BLOCKED_CATEGORIES: readonly string[] = [
  "private-key",
  "ssh-private-key",
  "certificate-private-key",
  "recovery-key",
  "seed-phrase",
  "browser-session-store",
  "os-credential-store",
];

export interface DeliveryPolicy {
  readonly mode: DeliveryMode;
  /** Replace detected secret spans before the agent sees them? */
  readonly redactSecretsBeforeDelivery: boolean;
  /** Categories refused regardless of mode. */
  readonly hardBlockedCategories: readonly string[];
  /** Always true. Evidence and UI never carry a raw value in any mode. */
  readonly maskValuesInEvidence: true;
  /** Human-readable notice shown when a session starts under this policy. */
  readonly notice: string;
}

export const DEVELOPER_MODE_NOTICE = [
  "Developer Mode",
  "",
  "Project configuration, including .env files, may be available to Claude Code.",
  "Secret values are not written to Yuhi logs, evidence, or UI.",
  "Use a future strict policy mode for pre-delivery masking.",
].join("\n");

/** v0.4.0 default. Values reach the agent; they never reach logs, evidence or UI. */
export const DEVELOPER_MODE_POLICY: DeliveryPolicy = {
  mode: "developer",
  redactSecretsBeforeDelivery: false,
  hardBlockedCategories: HARD_BLOCKED_CATEGORIES,
  maskValuesInEvidence: true,
  notice: DEVELOPER_MODE_NOTICE,
};

/** The 0.3.x behaviour, kept whole: nothing detected as a secret is delivered raw. */
export const STRICT_MODE_POLICY: DeliveryPolicy = {
  mode: "strict",
  redactSecretsBeforeDelivery: true,
  hardBlockedCategories: HARD_BLOCKED_CATEGORIES,
  maskValuesInEvidence: true,
  notice: [
    "Strict Mode",
    "",
    "Strict Mode masks detected secrets and supported identifiers before delivery. Detection coverage depends on file format and content.",
    "It is not a guarantee that every secret or identifier is removed.",
  ].join("\n"),
};

export function policyForMode(mode: DeliveryMode): DeliveryPolicy {
  return mode === "strict" ? STRICT_MODE_POLICY : DEVELOPER_MODE_POLICY;
}

/** Findings this policy refuses to deliver at all. Empty means "deliver, and record". */
export function hardBlockedFindings(
  findings: readonly PublicFinding[],
  policy: DeliveryPolicy,
): PublicFinding[] {
  return findings.filter((f) => policy.hardBlockedCategories.includes(f.detector));
}

/**
 * The user-facing reason for a hard block: the KIND of material and why, never the value
 * and never the path it came from.
 */
export function hardBlockReason(findings: readonly PublicFinding[]): string {
  const kinds = [...new Set(findings.map((f) => f.detector))].sort().join(", ");
  return `key-material-blocked:${kinds}`;
}
