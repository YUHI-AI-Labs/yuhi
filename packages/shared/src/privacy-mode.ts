/**
 * v0.4.8 Privacy Mode — the single, user-facing mode selector for identifier
 * transformation, shared by Static Prepare, Dynamic Terminal, and Native GUI Mode.
 *
 * The `PrivacyMode` TYPE, its guard, and the per-identifier transform decision already
 * existed (`identifier-taxonomy.ts`, originally scaffolded ahead of schedule for
 * "v0.5.0"). This module adds the resolution machinery around it.
 *
 * **Privacy Mode and Secret Delivery are two SEPARATE policy axes, composed per
 * SURFACE, not a single flat mode.** This was discovered, not assumed: Static Prepare
 * (`prepareWorkspace()`) redacts every detected secret today, unconditionally, in
 * every existing Safety Mode — there is no "Developer Mode" concept there at all.
 * "Developer Mode" (secrets may reach the agent for development work) has only ever
 * existed for Dynamic Context sessions (`packages/context-runtime/src/delivery-policy.ts`).
 * Naively making Balanced mean "secrets pass through" everywhere would have silently
 * weakened Static Prepare's current, unconditional secret protection — the exact
 * regression `resolveDeliveryPolicy` is built to make impossible by construction:
 *
 *   Surface           Balanced              Strict     Trusted Local
 *   static-prepare     redact                redact     redact   <- ALWAYS redact
 *   dynamic-terminal    developer-delivery    redact     developer-delivery (ack'd)
 *   native-gui          developer-delivery    redact     developer-delivery (ack'd)
 *
 * Two-step resolution, deliberately not one function:
 *   1. `resolvePrivacyPolicy()` — WHICH PrivacyMode wins (CLI > VS Code selection >
 *      workspace config > legacy mapping > default), and the Trusted Local
 *      acknowledgement gate. Throws; never a silent fallback.
 *   2. `resolveDeliveryPolicy()` — given an ALREADY-VALID mode + a `PrivacySurface`,
 *      compose the full behavioral policy (identifier transform + secret delivery).
 *      Pure and non-throwing: by the time it runs, step 1 already decided the
 *      selection is allowed.
 *
 * This is a DIFFERENT axis from `SafetyMode` (`safety-mode.ts`): SafetyMode decides
 * how much UNVERIFIED content Static Prepare withholds (escalating file inclusion);
 * PrivacyMode decides what happens to DIRECT PERSONAL IDENTIFIERS within whatever
 * content is being delivered. `SafetyMode` is unchanged by this module.
 */
import { DEFAULT_PRIVACY_MODE, isPrivacyMode, PRIVACY_MODES, type PrivacyMode } from "./identifier-taxonomy.js";

export type { PrivacyMode };
export { PRIVACY_MODES, isPrivacyMode, DEFAULT_PRIVACY_MODE };

export type PrivacyPolicySource =
  | "cli"
  | "workspace-config"
  | "vscode-setting"
  | "legacy-mapping"
  | "default";

/** Thrown by `resolvePrivacyPolicy` for an invalid explicit value or a missing
 *  Trusted Local acknowledgement. Never silently falls back to a different mode. */
export class PrivacyModeResolutionError extends Error {
  constructor(
    message: string,
    readonly code: "invalid-privacy-mode" | "trusted-local-not-acknowledged",
  ) {
    super(message);
    this.name = "PrivacyModeResolutionError";
  }
}

export interface PrivacyModeCandidate {
  readonly mode: string;
  readonly source: PrivacyPolicySource;
}

export interface ResolvePrivacyPolicyInput {
  /**
   * Precedence-ordered candidates, HIGHEST priority first: explicit CLI flag, explicit
   * VS Code session/command selection, workspace `yuhi.yaml` config, the legacy
   * `deliveryMode` mapping. An empty list (or every candidate's `mode` being `""`,
   * meaning "not explicitly set at that layer") resolves to the default
   * (`balanced`, `source: "default"`).
   */
  readonly candidates: readonly PrivacyModeCandidate[];
  /**
   * Required when the resolved mode is `trusted-local`. `false`/absent fails closed
   * (`PrivacyModeResolutionError`) rather than silently resolving to a masked mode —
   * the whole point of the confirmation gate is that trusted-local is never a silent
   * default or a silent fallback.
   */
  readonly trustedLocalAcknowledged?: boolean;
}

/** The mode-level resolution result: WHICH mode won, and from where. Surface-agnostic
 *  — feed this into `resolveDeliveryPolicy` to get the surface's actual behavior. */
export interface ResolvedPrivacyModeSelection {
  readonly mode: PrivacyMode;
  readonly source: PrivacyPolicySource;
  /** True for balanced/strict (nothing to acknowledge). For trusted-local, true only
   *  because `resolvePrivacyPolicy` already enforced the acknowledgement gate below —
   *  this field is never `false` in a value this function successfully returns. */
  readonly warningAcknowledged: boolean;
}

/**
 * Resolve WHICH `PrivacyMode` is in effect (Section 5 precedence) and enforce the
 * Trusted Local acknowledgement gate. Does NOT know about `PrivacySurface` or secret
 * delivery — see the module doc comment for why that is a second, separate step.
 */
export function resolvePrivacyPolicy(input: ResolvePrivacyPolicyInput): ResolvedPrivacyModeSelection {
  const chosen = input.candidates.find((c) => c.mode !== "");
  if (!chosen) {
    return { mode: DEFAULT_PRIVACY_MODE, source: "default", warningAcknowledged: true };
  }
  if (!isPrivacyMode(chosen.mode)) {
    throw new PrivacyModeResolutionError(
      `Unknown Privacy Mode "${chosen.mode}" (from ${chosen.source}). ` +
        `Valid values: ${PRIVACY_MODES.join(", ")}.`,
      "invalid-privacy-mode",
    );
  }
  if (chosen.mode === "trusted-local" && input.trustedLocalAcknowledged !== true) {
    throw new PrivacyModeResolutionError(
      "Trusted Local delivers personal identifiers unchanged (and, outside Static " +
        "Prepare, may also deliver secrets to the agent) and requires explicit " +
        "acknowledgement before it can be used.",
      "trusted-local-not-acknowledged",
    );
  }
  return { mode: chosen.mode, source: chosen.source, warningAcknowledged: true };
}

/** Where a resolved policy applies. Secret delivery is the ONLY field that varies by
 *  surface — see the module doc comment's matrix. */
export type PrivacySurface = "static-prepare" | "dynamic-terminal" | "native-gui";

/**
 * What happens to a DETECTED secret before delivery.
 *
 * `redact`: masked, same as today's unconditional Static Prepare behavior.
 * `developer-delivery`: the EXISTING Dynamic Context "Developer Mode" contract — the
 * value may reach the agent because the developer needs it for the work, but it is
 * NEVER written to Yuhi's own logs, UI, statistics, or public evidence, in any mode
 * (see `packages/context-runtime/src/delivery-policy.ts`'s `maskValuesInEvidence`,
 * always `true`, unaffected by this module).
 */
export type SecretDeliveryMode = "redact" | "developer-delivery";

export interface ResolvedDeliveryPolicy {
  readonly privacyMode: PrivacyMode;
  readonly surface: PrivacySurface;

  readonly transformDirectPersonalIdentifiers: boolean;
  readonly preserveOperationalIdentifiers: true;
  readonly preserveAnalyticalAttributes: true;

  readonly secretDeliveryMode: SecretDeliveryMode;

  /** Always true: even Trusted Local must not deliver a corrupt, wrong-run, or
   *  unverified generated artifact (companion/summary). This checks the artifact's
   *  structural integrity, NOT the absence of personal identifiers within it. */
  readonly requireVerifiedGeneratedArtifacts: true;

  readonly warningRequired: boolean;
  readonly warningAcknowledged: boolean;

  readonly source: PrivacyPolicySource;
}

export interface ResolveDeliveryPolicyInput {
  readonly privacyMode: PrivacyMode;
  readonly surface: PrivacySurface;
  /** Must already be `true` for `trusted-local` — obtained by having called
   *  `resolvePrivacyPolicy` first, which enforces the gate. This function does not
   *  re-validate; it trusts the caller completed step 1. */
  readonly warningAcknowledged?: boolean;
  readonly source?: PrivacyPolicySource;
}

/**
 * Compose the full behavioral policy for a mode + surface. Pure, non-throwing: the
 * Trusted Local acknowledgement GATE lives in `resolvePrivacyPolicy` (step 1); by the
 * time this runs the selection is already known-valid, so this function only composes
 * what it means for `surface` — it never rejects a call.
 */
export function resolveDeliveryPolicy(input: ResolveDeliveryPolicyInput): ResolvedDeliveryPolicy {
  const { privacyMode, surface } = input;
  const transformDirectPersonalIdentifiers = privacyMode !== "trusted-local";
  const warningRequired = privacyMode === "trusted-local";

  // Static Prepare redacts detected secrets in EVERY mode, unconditionally — this is
  // today's actual, existing, unconditional behavior (packages/config/src/defaults.ts's
  // `redact-detected-secrets` rule, gated on nothing but detector match) and is
  // DELIBERATELY not made mode-dependent. See the module doc comment.
  const secretDeliveryMode: SecretDeliveryMode =
    surface === "static-prepare"
      ? "redact"
      : privacyMode === "strict"
        ? "redact"
        : "developer-delivery";

  return {
    privacyMode,
    surface,
    transformDirectPersonalIdentifiers,
    preserveOperationalIdentifiers: true,
    preserveAnalyticalAttributes: true,
    secretDeliveryMode,
    requireVerifiedGeneratedArtifacts: true,
    warningRequired,
    warningAcknowledged: warningRequired ? input.warningAcknowledged === true : true,
    source: input.source ?? "default",
  };
}

/**
 * Legacy `DeliveryMode` -> `PrivacyMode` mapping (Section 6/10), for Dynamic
 * Context/Native GUI surfaces only — Static Prepare never had a `deliveryMode`.
 *
 * `developer` maps to `balanced`, NEVER `trusted-local`: Developer Mode's contract was
 * "secrets may reach Claude for development work", not "personal identifiers are
 * delivered unmasked". Widening it to `trusted-local` on migration would silently
 * remove identifier protection a Developer Mode user never asked to give up. Combined
 * with `resolveDeliveryPolicy`, `developer` -> `balanced` on a dynamic surface still
 * resolves to `secretDeliveryMode: "developer-delivery"` — the same real behavior the
 * legacy mode already had, just reached through the new type.
 */
export function privacyModeFromLegacyDeliveryMode(deliveryMode: "developer" | "strict"): PrivacyMode {
  return deliveryMode === "strict" ? "strict" : "balanced";
}

export const LEGACY_DELIVERY_MODE_MAPPING_NOTICE =
  "Legacy deliveryMode was mapped to Privacy Mode: Balanced. Update yuhi.yaml when convenient.";

/** User-facing copy (Section 3 + Clarification Section 7/8), split by surface because
 *  secret delivery genuinely differs by surface — one shared string would either lie
 *  on Static Prepare ("secrets may reach Claude") or lie on Dynamic surfaces ("secrets
 *  are redacted"). One place so CLI/VS Code/docs cannot drift or say the wrong one. */
export interface PrivacyModeCopy {
  readonly title: string;
  readonly en: string;
  readonly ja: string;
}

const STATIC_PREPARE_COPY: Readonly<Record<PrivacyMode, PrivacyModeCopy>> = {
  balanced: {
    title: "Balanced",
    en:
      "Direct personal identifiers are transformed. Operational identifiers are " +
      "preserved. Detected secrets are redacted from the prepared workspace.",
    ja:
      "直接個人識別子を変換し、業務識別子を維持します。検出されたsecretは準備済み" +
      "ワークスペースからマスクされます。",
  },
  strict: {
    title: "Strict",
    en:
      "Direct personal identifiers are transformed. Operational identifiers are " +
      "preserved. Detected secrets are redacted from the prepared workspace. " +
      "Unverified artifacts remain local-only.",
    ja:
      "直接個人識別子を変換し、業務識別子を維持します。検出されたsecretは準備済み" +
      "ワークスペースからマスクされます。安全性を確認できないファイルはローカルに" +
      "残します。",
  },
  "trusted-local": {
    title: "Trusted Local — Unmasked identifiers",
    en:
      "Privacy transformation is disabled: personal identifiers are delivered " +
      "unchanged. Detected secrets are still redacted from the prepared workspace.\n\n" +
      "Use only with a trusted local model, private infrastructure, or another " +
      "environment explicitly approved for unmasked data. Yuhi does not provide " +
      "OS-level isolation.",
    ja:
      "privacy変換を行いません: 個人識別情報はそのまま配信されます。検出されたsecret" +
      "は引き続き準備済みワークスペースからマスクされます。\n\n信頼できるローカル" +
      "モデル、閉域・専用環境、または未加工データの利用が承認された環境でのみ" +
      "使用してください。YuhiはOSレベルの隔離を提供しません。",
  },
};

const DYNAMIC_SURFACE_COPY: Readonly<Record<PrivacyMode, PrivacyModeCopy>> = {
  balanced: {
    title: "Balanced",
    en:
      "Direct personal identifiers are transformed. Operational identifiers are " +
      "preserved. Development secrets may be delivered to Claude when required, but " +
      "are not written to Yuhi public logs or evidence.",
    ja:
      "直接個人識別子を変換し、業務識別子を維持します。開発に必要なsecretはClaudeへ" +
      "渡る場合がありますが、Yuhiの公開ログやEvidenceには記録しません。",
  },
  strict: {
    title: "Strict",
    en:
      "Direct personal identifiers and detected secrets are both transformed before " +
      "delivery. Operational identifiers are preserved. Unverified artifacts remain " +
      "local-only.",
    ja:
      "直接個人識別子に加え、検出されたsecretも配信前にマスクします。業務識別子は" +
      "維持します。安全性を確認できないファイルはローカルに残します。",
  },
  "trusted-local": {
    title: "Trusted Local — Unmasked data",
    en:
      "Privacy transformation is disabled. Personal identifiers and development " +
      "secrets may be delivered unchanged. Explicit acknowledgement is required.\n\n" +
      "Use only with a trusted local model, private infrastructure, or another " +
      "environment explicitly approved for unmasked data. Yuhi does not provide " +
      "OS-level isolation.",
    ja:
      "privacy変換を行いません。個人識別情報や開発用secretがそのまま配信される場合" +
      "があります。明示的な確認が必要です。\n\n信頼できるローカルモデル、閉域・専用" +
      "環境、または未加工データの利用が承認された環境でのみ使用してください。Yuhiは" +
      "OSレベルの隔離を提供しません。",
  },
};

/** Surface-aware copy lookup — NEVER use a single shared string across surfaces (a
 *  Static Prepare string would lie about secrets on a dynamic surface, and vice
 *  versa). `"trusted-local"` must never be described as "always fully unmasked": on
 *  `static-prepare` its secret behavior is identical to balanced/strict. */
export function privacyModeCopyFor(mode: PrivacyMode, surface: PrivacySurface): PrivacyModeCopy {
  return surface === "static-prepare" ? STATIC_PREPARE_COPY[mode] : DYNAMIC_SURFACE_COPY[mode];
}
