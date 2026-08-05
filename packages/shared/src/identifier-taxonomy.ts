import type { DirectIdentifierType } from "./student-records.js";

/**
 * Identifier taxonomy.
 *
 * Yuhi's goal is NOT "remove every identifier". It is: protect what identifies a
 * PERSON, and preserve the keys and attributes an analysis needs. Masking a student
 * id or a course code destroys the joins and group-bys the data exists for, while
 * buying no privacy — the person is already protected by masking their name.
 *
 * This layer sits ON TOP of `DirectIdentifierType`; it does not replace it. The
 * existing classifier still decides *what a column is*, and this decides *what to do
 * about it*.
 */
export type IdentifierCategory =
  /** Identifies a natural person on its own. Pseudonymize. */
  | "direct-personal-identifier"
  /** A business key: joins records, does not name a person. Preserve. */
  | "operational-identifier"
  /** A measurement or dimension. Preserve. */
  | "analytical-attribute";

/**
 * The categories, by identifier type.
 *
 * Read the OPERATIONAL list as the deliberate part: a student id, a course code, an
 * employee number and an application number are all keys into business data. They are
 * kept verbatim so `JOIN`, `GROUP BY` and time series still work after preparation.
 */
export function identifierCategory(type: DirectIdentifierType): IdentifierCategory {
  switch (type) {
    // ── Names a person, or reaches them directly ─────────────────────────────
    case "name":
    case "name-reading":
    case "email":
    case "phone":
    case "address":
    case "my-number":
    case "passport-number":
    case "bank-account":
    case "credit-card":
    case "biometric-id":
    case "government-id":
      return "direct-personal-identifier";

    // ── Business keys. PRESERVED — masking these breaks analysis for no gain ──
    case "student-id":
    case "student-card":
    case "employee-id":
    case "account-id":
    case "institutional-id":
    case "course-code":
    case "staff-id":
    case "application-number":
    case "record-id":
      return "operational-identifier";
  }
}

/** True when a value of this type must be replaced before delivery. */
export function requiresPseudonymization(type: DirectIdentifierType): boolean {
  return identifierCategory(type) === "direct-personal-identifier";
}

/**
 * True when this type identifies the SUBJECT of the row, and so may be used to decide
 * that two rows describe the same person.
 *
 * Preserving operational identifiers makes them usable as linkage keys, but only some of
 * them are keys to the row's subject. A course code names a group, and a staff id names a
 * DIFFERENT person — the instructor. Both repeat across many rows by design, so using
 * them for identity resolution links every student in a class to one entity, which then
 * conflicts and defeats the linkage entirely.
 *
 * Direct-personal types are excluded for a different reason: they are being replaced, so
 * they cannot be relied on as stable keys. `name` in particular is not unique.
 */
export function identifiesRowSubject(type: DirectIdentifierType): boolean {
  if (identifierCategory(type) !== "operational-identifier") return false;
  return type !== "course-code" && type !== "staff-id";
}

/** True when a value of this type must survive preparation unchanged. */
export function mustPreserve(type: DirectIdentifierType): boolean {
  return identifierCategory(type) !== "direct-personal-identifier";
}

/**
 * Every direct-personal type, for surfaces that need to enumerate what is protected.
 * Derived from `identifierCategory` so a new type cannot be forgotten here.
 */
export const DIRECT_PERSONAL_TYPES: readonly DirectIdentifierType[] = (
  [
    "name",
    "name-reading",
    "email",
    "phone",
    "address",
    "my-number",
    "passport-number",
    "bank-account",
    "credit-card",
    "biometric-id",
    "government-id",
    "student-id",
    "student-card",
    "employee-id",
    "account-id",
    "institutional-id",
    "course-code",
    "staff-id",
    "application-number",
    "record-id",
  ] as const satisfies readonly DirectIdentifierType[]
).filter(requiresPseudonymization);

/** Public wording for every surface. Never claim that all identifiers are removed. */
export const PRIVACY_POLICY_SUMMARY_EN =
  "Direct personal identifiers are protected while operational identifiers required " +
  "for analysis are preserved.";

export const PRIVACY_POLICY_SUMMARY_JA =
  "直接個人識別子を保護しながら、業務分析に必要な識別子と属性を維持します。";

/**
 * Privacy delivery mode (v0.5.0).
 *
 * The transform is selected by where the context is going, not by how much can be
 * hidden.
 */
export type PrivacyMode = "strict" | "balanced" | "trusted-local";

export const PRIVACY_MODES: readonly PrivacyMode[] = ["strict", "balanced", "trusted-local"];

/**
 * The default. `strict` and `balanced` apply an IDENTICAL transform — they differ only
 * in what each surface says — so the default cannot change what is delivered, only how
 * it is described.
 */
export const DEFAULT_PRIVACY_MODE: PrivacyMode = "balanced";

export function isPrivacyMode(value: unknown): value is PrivacyMode {
  return typeof value === "string" && (PRIVACY_MODES as readonly string[]).includes(value);
}

/**
 * Whether this mode transforms direct personal identifiers at all.
 *
 * `strict` and `balanced` share one implementation deliberately: two code paths that
 * are meant to behave identically will drift, and a privacy transform is the last place
 * to discover that.
 */
export function modeTransformsDirectIdentifiers(mode: PrivacyMode): boolean {
  return mode !== "trusted-local";
}

/** Per-mode decision for a single identifier type. */
export function actionFor(
  mode: PrivacyMode,
  type: DirectIdentifierType,
): "pseudonymize" | "preserve" {
  if (!modeTransformsDirectIdentifiers(mode)) return "preserve";
  return requiresPseudonymization(type) ? "pseudonymize" : "preserve";
}

export interface PrivacyModeDescriptor {
  mode: PrivacyMode;
  /** True when Yuhi replaced direct personal identifiers in this run. */
  transformed: boolean;
  operationalIdentifiersPreserved: true;
  /** Present only for `trusted-local`, where the user must be warned. */
  warning?: string;
}

export const TRUSTED_LOCAL_WARNING =
  "Direct personal identifiers are delivered unchanged. Use only in trusted " +
  "local/private environments.";

/**
 * `trusted-local` is NOT a security posture — it means Yuhi did not transform anything.
 * Every surface that reports it must carry the warning, so it is attached here rather
 * than left for each surface to remember.
 */
export function describePrivacyMode(mode: PrivacyMode): PrivacyModeDescriptor {
  const transformed = modeTransformsDirectIdentifiers(mode);
  return {
    mode,
    transformed,
    operationalIdentifiersPreserved: true,
    ...(transformed ? {} : { warning: TRUSTED_LOCAL_WARNING }),
  };
}

/** One-line wording per mode, shared by the CLI and the VS Code panel. */
export function privacyModeSummary(mode: PrivacyMode): string {
  switch (mode) {
    case "strict":
      return "Privacy Mode: Strict — direct identifiers masked. Operational identifiers preserved.";
    case "balanced":
      return "Privacy Mode: Balanced — direct identifiers masked. Operational identifiers preserved for analysis.";
    case "trusted-local":
      return `Privacy Mode: Trusted Local — direct identifiers are not transformed. ${TRUSTED_LOCAL_WARNING}`;
  }
}
