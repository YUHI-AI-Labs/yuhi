import path from "node:path";

import type {
  PatchApplyEligibility,
  PatchChangeKind,
  PatchReasonCode,
  PreparedRepresentation,
} from "./types.js";

export type PatchValidationRisk = "low" | "review" | "high" | "blocked";
export type PatchValidationEligibility = PatchApplyEligibility;

/** Input is deliberately metadata/content supplied by the caller; validation never reads Source. */
export interface PatchValidationInput {
  relpath: string;
  /** Required for rename safety; both the origin and destination are validated. */
  previousRelpath?: string;
  kind: PatchChangeKind;
  representation: PreparedRepresentation;
  beforeContent?: string | Uint8Array;
  afterContent?: string | Uint8Array;
  baselineSourceHash?: string;
  currentSourceHash?: string;
  sourceGitDirty?: boolean;
  destinationExists?: boolean;
  destinationTrackedByBaseline?: boolean;
  isSymlink?: boolean;
  symlinkEscapesSourceRoot?: boolean;
  isDeviceFile?: boolean;
  executable?: boolean;
  maxGeneratedFileBytes?: number;
}

export interface PatchValidationResult {
  relpath: string;
  risk: PatchValidationRisk;
  applyEligibility: PatchValidationEligibility;
  reasonCodes: PatchReasonCode[];
}

export interface PatchSetValidationResult {
  valid: boolean;
  changes: PatchValidationResult[];
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const ABSOLUTE_WINDOWS = /^(?:[a-z]:[\\/]|\\\\)/i;
const INTERNAL_SEGMENTS = new Set([".git", ".yuhi"]);
const INTERNAL_FILES = /^(?:CLAUDE\.md|AGENTS\.md|context-manifest\.json|prepared-manifest\.json|background-status\.json|queue\.json|session-manifest\.json)$/i;
const CREDENTIAL_FILE = /(?:^|\/)(?:\.env(?:\..*)?|credentials?(?:\.[^/]*)?|secrets?\.(?:json|ya?ml)|id_(?:rsa|dsa|ecdsa|ed25519))$/i;
const CI_FILE = /^(?:\.github\/workflows\/|\.gitlab-ci\.ya?ml$|\.circleci\/|azure-pipelines\.ya?ml$)/i;
const SECURITY_CONFIG = /(?:^|\/)(?:CODEOWNERS|dependabot\.ya?ml|renovate(?:\.json|\.json5)?|security\.ya?ml)$/i;
const LOCKFILE = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock)$/i;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk-proj-|sk-|gh[opsu]_|github_pat_)[A-Za-z0-9_-]{16,}\b/,
  /(?:api[_-]?key|client[_-]?secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{12,}/i,
];
const PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:\+?\d[\s().-]*){10,15}\b/,
];

function bytes(value: string | Uint8Array | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array();
  return typeof value === "string" ? Buffer.from(value) : value;
}

function text(value: string | Uint8Array | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
}

function hasNewMatch(before: string, after: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const collect = (value: string) => new Set([...value.matchAll(new RegExp(pattern.source, flags))].map((match) => match[0]));
    const prior = collect(before);
    return [...collect(after)].some((match) => !prior.has(match));
  });
}

function normalizedRelpath(relpath: string): string | undefined {
  const hasControl = [...relpath].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (!relpath || hasControl || path.posix.isAbsolute(relpath) || ABSOLUTE_WINDOWS.test(relpath)) return undefined;
  const slash = relpath.replace(/\\/g, "/");
  const segments = slash.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) return undefined;
  return segments.join("/");
}

function packageScriptsChanged(relpath: string, before: string, after: string): boolean {
  if (!/(?:^|\/)package\.json$/i.test(relpath)) return false;
  try {
    const a = JSON.stringify((JSON.parse(before) as { scripts?: unknown }).scripts ?? null);
    const b = JSON.stringify((JSON.parse(after) as { scripts?: unknown }).scripts ?? null);
    return a !== b;
  } catch {
    // A changed, unparsable package.json still deserves elevated review.
    return before !== after;
  }
}

function add(reasons: Set<PatchReasonCode>, code: PatchReasonCode): void {
  reasons.add(code);
}

/**
 * Fail-closed policy for a single proposed Source change. Raw findings are never
 * returned: callers receive only the safe relpath, classification, and reason codes.
 */
export function validatePatchChange(input: PatchValidationInput): PatchValidationResult {
  const reasons = new Set<PatchReasonCode>();
  let risk: PatchValidationRisk = "low";
  let eligibility: PatchValidationEligibility = "eligible";
  const normalized = normalizedRelpath(input.relpath);

  const raise = (next: PatchValidationRisk, reason: PatchReasonCode): void => {
    const order: PatchValidationRisk[] = ["low", "review", "high", "blocked"];
    if (order.indexOf(next) > order.indexOf(risk)) risk = next;
    if (next === "blocked") eligibility = "blocked";
    else if (next !== "low" && eligibility === "eligible") eligibility = "requires-review";
    add(reasons, reason);
  };

  if (!normalized) {
    raise("blocked", "patch-path-escape");
  } else {
    const segments = normalized.split("/");
    if (segments.some((segment) => INTERNAL_SEGMENTS.has(segment.toLocaleLowerCase("en-US"))) || INTERNAL_FILES.test(segments.at(-1) ?? "")) {
      raise("blocked", "patch-sensitive-config");
    }
    if (segments.some((segment) => WINDOWS_RESERVED.test(segment) || /[. ]$/.test(segment) || segment.includes(":"))) {
      raise("blocked", "patch-path-escape");
    }
  }

  if (input.isSymlink || input.symlinkEscapesSourceRoot) raise("blocked", "patch-symlink");
  if (input.isDeviceFile) raise("blocked", "patch-unsupported-mode");
  if (input.kind === "renamed" && !normalizedRelpath(input.previousRelpath ?? "")) {
    raise("blocked", "patch-path-escape");
  }
  if (input.representation === "compressed") raise("blocked", "patch-compressed-source");
  if (input.representation === "background-artifact") raise("blocked", "patch-background-artifact");

  if (input.baselineSourceHash !== undefined && input.currentSourceHash !== input.baselineSourceHash) {
    raise("blocked", "patch-source-changed");
  }
  if (input.sourceGitDirty) raise("blocked", "patch-source-changed");
  if (input.kind === "added" && input.destinationExists && !input.destinationTrackedByBaseline) {
    raise("blocked", "patch-source-changed");
  }

  const before = text(input.beforeContent);
  const after = text(input.afterContent);
  if (normalized && CREDENTIAL_FILE.test(normalized)) raise("blocked", "patch-sensitive-config");
  if (hasNewMatch(before, after, SECRET_PATTERNS)) raise("blocked", "patch-secret-added");
  // v0.3.6 deliberately has no value-safe, per-finding confirmation flow. A
  // generic "Apply" confirmation is not meaningful consent to publish newly
  // generated personal data, so fail closed until that UX exists.
  if (hasNewMatch(before, after, PII_PATTERNS)) raise("blocked", "patch-pii-added");
  if (normalized && CI_FILE.test(normalized)) raise("high", "patch-sensitive-config");
  if (normalized && (SECURITY_CONFIG.test(normalized) || packageScriptsChanged(normalized, before, after))) {
    raise("high", "patch-sensitive-config");
  }
  if (normalized && LOCKFILE.test(normalized) && Math.abs(bytes(after).byteLength - bytes(before).byteLength) > 64 * 1024) {
    raise("high", "patch-sensitive-config");
  }

  const afterBytes = bytes(input.afterContent);
  const limit = input.maxGeneratedFileBytes ?? 10 * 1024 * 1024;
  if (afterBytes.byteLength > limit) raise("high", "patch-generated-large-file");
  // Binary bytes and permission-mode changes cannot be reviewed accurately in
  // the text/hunk UI and the apply transaction intentionally does not support
  // them. Keep the policy identical at review and apply time.
  if (input.kind === "binary") raise("blocked", "patch-binary");
  if (input.kind === "mode-changed" || input.executable || afterBytes.includes(0))
    raise("blocked", "patch-unsupported-mode");

  if (reasons.size === 0) add(reasons, "patch-eligible");
  return { relpath: normalized ?? "[invalid-path]", risk, applyEligibility: eligibility, reasonCodes: [...reasons] };
}

/** Validate a selection and reject path aliases that could overwrite each other. */
export function validatePatchSet(inputs: readonly PatchValidationInput[]): PatchSetValidationResult {
  const changes = inputs.map(validatePatchChange);
  const aliases = new Map<string, number[]>();
  inputs.forEach((input, index) => {
    const relpath = normalizedRelpath(input.relpath);
    if (!relpath) return;
    const key = relpath.normalize("NFC").toLocaleLowerCase("en-US").normalize("NFC");
    const indexes = aliases.get(key) ?? [];
    indexes.push(index);
    aliases.set(key, indexes);
  });
  for (const indexes of aliases.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      const result = changes[index];
      if (!result) continue;
      result.risk = "blocked";
      result.applyEligibility = "blocked";
      if (!result.reasonCodes.includes("patch-path-escape")) result.reasonCodes.push("patch-path-escape");
    }
  }
  return { valid: changes.every((change) => change.applyEligibility !== "blocked"), changes };
}
