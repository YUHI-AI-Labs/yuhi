/**
 * v0.4.8 Privacy Mode — the single, user-facing mode selector for identifier
 * transformation and secret delivery, shared by Static Prepare, Dynamic Terminal, and
 * Native GUI Mode.
 *
 * The `PrivacyMode` TYPE, its guard, and the per-identifier transform decision already
 * existed (`identifier-taxonomy.ts`, originally scaffolded ahead of schedule for
 * "v0.5.0") — that module's own comment said `strict` and `balanced` "apply an
 * IDENTICAL transform, they differ only in what each surface says". v0.4.8 is what
 * makes that no longer true: Strict now ALSO redacts detected secrets before delivery
 * (Section 3.2), which needs real behavioral state, not just wording. This module adds
 * that: `ResolvedPrivacyPolicy` (secret redaction, artifact verification, residue
 * tolerance, warning/acknowledgement — composed once, read everywhere) and the
 * precedence-ordered resolution + legacy mapping around it. The base type is reused,
 * not redefined.
 *
 * This is a DIFFERENT axis from `SafetyMode` (`safety-mode.ts`): SafetyMode decides
 * how much UNVERIFIED content Static Prepare withholds (escalating file inclusion);
 * PrivacyMode decides what happens to DIRECT PERSONAL IDENTIFIERS and DETECTED SECRETS
 * within whatever content is being delivered. The two compose — a file the Safety Mode
 * decides to deliver still goes through Privacy Mode's identifier transformation.
 * `SafetyMode` is unchanged by this module.
 *
 * PrivacyMode REPLACES `DeliveryMode` (`packages/context-runtime/src/delivery-policy.ts`,
 * "developer" | "strict") as the primary selector. `DeliveryMode` is not deleted (see
 * `privacyModeFromLegacyDeliveryMode`) but new code should resolve a `PrivacyMode` and
 * read `ResolvedPrivacyPolicy` instead of branching on it directly.
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

/**
 * The resolved, composed policy every subsystem reads instead of branching on
 * `PrivacyMode` itself. Precomputed so a mode's meaning cannot drift between Static
 * Prepare, Dynamic Terminal, and Native GUI Mode call sites.
 */
export interface ResolvedPrivacyPolicy {
  readonly mode: PrivacyMode;

  readonly transformDirectPersonalIdentifiers: boolean;
  readonly preserveOperationalIdentifiers: true;
  readonly preserveAnalyticalAttributes: true;

  readonly redactDetectedSecretsBeforeDelivery: boolean;
  readonly requireVerifiedGeneratedArtifacts: boolean;
  readonly allowUnresolvedDirectPersonalResidue: boolean;
  readonly allowUnresolvedSecretResidue: boolean;

  readonly warningRequired: boolean;
  readonly warningAcknowledged: boolean;

  readonly source: PrivacyPolicySource;
}

const BALANCED_BASE = {
  mode: "balanced" as const,
  transformDirectPersonalIdentifiers: true,
  preserveOperationalIdentifiers: true as const,
  preserveAnalyticalAttributes: true as const,
  redactDetectedSecretsBeforeDelivery: false,
  requireVerifiedGeneratedArtifacts: true,
  allowUnresolvedDirectPersonalResidue: false,
  allowUnresolvedSecretResidue: true,
  warningRequired: false,
  warningAcknowledged: true,
};

const STRICT_BASE = {
  mode: "strict" as const,
  transformDirectPersonalIdentifiers: true,
  preserveOperationalIdentifiers: true as const,
  preserveAnalyticalAttributes: true as const,
  redactDetectedSecretsBeforeDelivery: true,
  requireVerifiedGeneratedArtifacts: true,
  allowUnresolvedDirectPersonalResidue: false,
  allowUnresolvedSecretResidue: false,
  warningRequired: false,
  warningAcknowledged: true,
};

const TRUSTED_LOCAL_BASE = {
  mode: "trusted-local" as const,
  transformDirectPersonalIdentifiers: false,
  preserveOperationalIdentifiers: true as const,
  preserveAnalyticalAttributes: true as const,
  redactDetectedSecretsBeforeDelivery: false,
  requireVerifiedGeneratedArtifacts: true,
  allowUnresolvedDirectPersonalResidue: true,
  allowUnresolvedSecretResidue: true,
  warningRequired: true,
  // Overridden per-resolution by the caller's acknowledgement (see resolvePrivacyPolicy).
  warningAcknowledged: false,
};

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
   * `deliveryMode` mapping, then the caller appends nothing further — an empty list
   * resolves to the default (`balanced`, `source: "default"`).
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

/**
 * Resolve the effective `ResolvedPrivacyPolicy` from precedence-ordered candidates.
 *
 * Precedence (Section 5): explicit CLI flag > explicit VS Code selection > workspace
 * config > legacy mapping > default (`balanced`). The first candidate with a
 * non-empty `mode` wins; an unknown mode string fails immediately (never a silent
 * fallback to a lower-precedence candidate or the default).
 */
export function resolvePrivacyPolicy(input: ResolvePrivacyPolicyInput): ResolvedPrivacyPolicy {
  const chosen = input.candidates.find((c) => c.mode !== "");
  if (!chosen) {
    return { ...BALANCED_BASE, source: "default" };
  }
  if (!isPrivacyMode(chosen.mode)) {
    throw new PrivacyModeResolutionError(
      `Unknown Privacy Mode "${chosen.mode}" (from ${chosen.source}). ` +
        `Valid values: ${PRIVACY_MODES.join(", ")}.`,
      "invalid-privacy-mode",
    );
  }
  if (chosen.mode === "trusted-local") {
    if (input.trustedLocalAcknowledged !== true) {
      throw new PrivacyModeResolutionError(
        "Trusted Local delivers personal identifiers and secrets unchanged and " +
          "requires explicit acknowledgement before it can be used.",
        "trusted-local-not-acknowledged",
      );
    }
    return { ...TRUSTED_LOCAL_BASE, warningAcknowledged: true, source: chosen.source };
  }
  const base = chosen.mode === "strict" ? STRICT_BASE : BALANCED_BASE;
  return { ...base, source: chosen.source };
}

/**
 * Legacy `DeliveryMode` -> `PrivacyMode` mapping (Section 6).
 *
 * `developer` maps to `balanced`, NEVER `trusted-local`: Developer Mode's contract was
 * "secrets may reach Claude for development work", not "personal identifiers are
 * delivered unmasked". Widening it to `trusted-local` on migration would silently
 * remove identifier protection a Developer Mode user never asked to give up.
 */
export function privacyModeFromLegacyDeliveryMode(deliveryMode: "developer" | "strict"): PrivacyMode {
  return deliveryMode === "strict" ? "strict" : "balanced";
}

export const LEGACY_DELIVERY_MODE_MAPPING_NOTICE =
  "Legacy deliveryMode was mapped to Privacy Mode: Balanced. Update yuhi.yaml when convenient.";

/** User-facing copy (Section 3), one place so CLI/VS Code/docs cannot drift. */
export interface PrivacyModeCopy {
  readonly title: string;
  readonly en: string;
  readonly ja: string;
}

export const PRIVACY_MODE_COPY: Readonly<Record<PrivacyMode, PrivacyModeCopy>> = {
  balanced: {
    title: "Balanced",
    en:
      "Protect direct personal identifiers while preserving operational identifiers " +
      "and analytical context. Recommended for most development and business-analysis " +
      "workflows.",
    ja:
      "氏名や連絡先などを保護しながら、学生証番号・業務ID・分析属性を維持します。" +
      "通常の開発・業務分析に推奨します。",
  },
  strict: {
    title: "Strict",
    en:
      "Protect direct personal identifiers and redact detected secrets. Operational " +
      "identifiers and analytical attributes remain available. Unverified artifacts " +
      "remain local-only.",
    ja:
      "直接個人識別子に加え、検出されたsecretも配信前にマスクします。業務識別子と分析" +
      "属性は維持します。安全性を確認できないファイルはローカルに残します。",
  },
  "trusted-local": {
    title: "Trusted Local — Unmasked data",
    en:
      "Yuhi will not mask personal identifiers or detected secrets. Original values " +
      "may be delivered to the AI agent.\n\nUse only with a trusted local model, " +
      "private infrastructure, or another environment explicitly approved for " +
      "unmasked data. Yuhi does not provide OS-level isolation.",
    ja:
      "個人識別情報や検出されたsecretをマスクせず、元の値をAIエージェントへ渡す場合が" +
      "あります。\n\n信頼できるローカルモデル、閉域・専用環境、または未加工データの利用" +
      "が承認された環境でのみ使用してください。YuhiはOSレベルの隔離を提供しません。",
  },
};
