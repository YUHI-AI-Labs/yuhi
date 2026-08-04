/**
 * The safety pipeline (spec §13). Raw → secret scan → PII scan → metadata scan →
 * (compression) → EXACT OUTPUT SCAN → evidence → agent. No exceptions.
 *
 * Detector logic is NOT reimplemented here: it comes from `@yuhi/scanner`, so there
 * stays exactly one definition of what a secret is. This module adds the two things
 * the runtime needs on top: the private-metadata scan, and the post-compression
 * exact-output rescan that makes compression safe — a compressor that re-encodes or
 * concatenates content cannot smuggle a secret past a pre-scan.
 */

import { createHash } from "node:crypto";

import { BUILTIN_DETECTORS, redactText, runDetectors, type Detector } from "@yuhi/scanner";
import type { DetectorOptions } from "@yuhi/scanner";
import type { ScanFinding } from "@yuhi/shared";

import { privateLiterals, type PrivateMetadata } from "./event.js";
import { STRICT_MODE_POLICY, type DeliveryPolicy } from "./delivery-policy.js";

export type Severity = ScanFinding["severity"];

/** Public-safe finding: a category and a count. Never a value, never a preview. */
export interface PublicFinding {
  readonly detector: string;
  readonly severity: Severity;
  readonly count: number;
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = {
  entropyThreshold: 4.0,
  keywords: [],
};

export interface ContentScan {
  /** Content with secret spans replaced by `«REDACTED:…»` placeholders. */
  readonly text: string;
  readonly findings: readonly PublicFinding[];
  readonly redactions: number;
  readonly criticalOrHigh: number;
  /**
   * sha256 prefixes of the detected values. Never the values themselves.
   *
   * These exist so the evidence ledger can say "this finding recurred" and so the egress
   * guard can recognise a secret leaving without anything ever storing one.
   */
  readonly fingerprints: readonly string[];
}

/** Stable, non-reversible fingerprint of a secret value. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

export function scanAndRedact(
  content: string,
  opts: DetectorOptions = DEFAULT_DETECTOR_OPTIONS,
  detectors: readonly Detector[] = BUILTIN_DETECTORS,
): ContentScan {
  const list = detectors as Detector[];
  const raw = runDetectors(content, opts, list);
  const { redacted, count } = redactText(content, opts, list);
  // One extraction for both fingerprints and egress watching: the regex detectors miss
  // entropy- and assignment-shaped values (`AWS_SECRET_ACCESS_KEY=…`), which are exactly the
  // `.env` values Developer Mode delivers and therefore exactly what must be traceable.
  const values = detectSecretValues(content, opts, list);
  return {
    text: redacted,
    findings: summarize(raw),
    redactions: count,
    criticalOrHigh: raw.filter((f) => f.severity === "critical" || f.severity === "high").length,
    fingerprints: [...new Set(values.map(fingerprint))],
  };
}

/**
 * Mask ONLY hard-blocked key material, leaving everything else intact.
 *
 * Developer Mode's point is that a `.env` value reaches the agent; a private key never
 * should. Withholding the whole tool result because one line carried a PEM header would
 * block the work for the sake of a span we can simply mask — the `file blocked ≠ launch
 * blocked` principle applied to bytes.
 */
export function redactKeyMaterial(
  content: string,
  policy: DeliveryPolicy,
  opts: DetectorOptions = DEFAULT_DETECTOR_OPTIONS,
  detectors: readonly Detector[] = BUILTIN_DETECTORS,
): { text: string; count: number; categories: string[] } {
  const hardBlocked = (detectors as Detector[]).filter((d) => policy.hardBlockedCategories.includes(d.category));
  if (hardBlocked.length === 0) return { text: content, count: 0, categories: [] };
  const { redacted, count } = redactText(content, opts, hardBlocked);
  const categories = [...new Set(hardBlocked.filter((d) => d.scan(content).length > 0).map((d) => d.category))].sort();
  return { text: redacted, count, categories };
}

/**
 * The detected secret VALUES in `content`.
 *
 * Deliberately not part of any scan result: this exists solely so the egress guard can
 * recognise a value coming back out. Callers must keep it in memory and never log, store,
 * evidence or display it — the fingerprints are what get recorded.
 */
export function detectSecretValues(
  content: string,
  opts: DetectorOptions = DEFAULT_DETECTOR_OPTIONS,
  detectors: readonly Detector[] = BUILTIN_DETECTORS,
): string[] {
  const out = new Set<string>();
  for (const detector of detectors as Detector[]) {
    for (const hit of detector.scan(content)) out.add(hit.value);
  }
  // Entropy-detected assignments (`KEY=…`) are the common `.env` shape and are exactly what
  // Developer Mode delivers, so they are watched too.
  for (const line of content.split("\n")) {
    const assignment = /^[A-Z0-9_]{3,}\s*=\s*["']?([^"'\s]{12,})["']?\s*$/.exec(line.trim());
    if (assignment?.[1]) out.add(assignment[1]);
  }
  void opts;
  return [...out];
}

export interface MetadataScan {
  readonly text: string;
  /** How many private literals were replaced. */
  readonly redactions: number;
  /** Which fields leaked, by placeholder label — never the value itself. */
  readonly labels: readonly string[];
}

/**
 * Replace private-metadata literals with opaque placeholders. Absolute paths and
 * source basenames are the two things that survived into `.yuhi/` before 0.3.6, so
 * they are scrubbed from every delivery, not just from manifests.
 */
export function scanMetadata(text: string, meta: PrivateMetadata): MetadataScan {
  let out = text;
  let redactions = 0;
  const labels = new Set<string>();
  for (const literal of privateLiterals(meta)) {
    if (!out.includes(literal)) continue;
    const label = labelFor(literal, meta);
    const parts = out.split(literal);
    redactions += parts.length - 1;
    labels.add(label);
    out = parts.join(`«${label}»`);
  }
  return { text: out, redactions, labels: [...labels].sort() };
}

function labelFor(literal: string, meta: PrivateMetadata): string {
  if (literal === meta.absolutePath) return "PATH";
  if (literal === meta.sourceBasename) return "SOURCE";
  if (literal === meta.homeDir) return "HOME";
  if (literal === meta.hostname) return "HOST";
  if (literal === meta.command) return "COMMAND";
  return "ENV";
}

export type ExactOutputVerdict =
  | { readonly ok: true; readonly findings: readonly PublicFinding[] }
  | { readonly ok: false; readonly reason: string; readonly findings: readonly PublicFinding[] };

/**
 * The last gate before delivery. Re-scans the exact bytes about to be sent.
 *
 * What a finding MEANS here is the policy's call, not the scanner's:
 *  - strict    → anything critical/high fails closed (0.3.x behaviour, still the default
 *                for direct callers).
 *  - developer → a detected credential is expected content (the `.env` the developer asked
 *                the agent to read), so it does not fail; HARD-BLOCKED key material still
 *                does, and private metadata still does in both modes.
 */
export function exactOutputScan(
  deliveryText: string,
  meta: PrivateMetadata,
  opts: DetectorOptions = DEFAULT_DETECTOR_OPTIONS,
  detectors: readonly Detector[] = BUILTIN_DETECTORS,
  policy: DeliveryPolicy = STRICT_MODE_POLICY,
): ExactOutputVerdict {
  const findings = runDetectors(deliveryText, opts, detectors as Detector[]);
  const summary = summarize(findings);
  const blocked = summary.filter((f) => policy.hardBlockedCategories.includes(f.detector));
  if (blocked.length > 0) {
    return { ok: false, reason: `key-material-in-output:${blocked.map((f) => f.detector).join(",")}`, findings: summary };
  }
  const severe = policy.redactSecretsBeforeDelivery
    ? findings.filter((f) => f.severity === "critical" || f.severity === "high")
    : [];
  if (severe.length > 0) {
    return { ok: false, reason: "secret-in-output", findings: summary };
  }
  for (const literal of privateLiterals(meta)) {
    if (deliveryText.includes(literal)) {
      return { ok: false, reason: "private-metadata-in-output", findings: summary };
    }
  }
  return { ok: true, findings: summary };
}

function summarize(findings: readonly ScanFinding[]): PublicFinding[] {
  const byKey = new Map<string, PublicFinding>();
  for (const f of findings) {
    const key = `${f.detector}:${f.severity}`;
    const existing = byKey.get(key);
    byKey.set(
      key,
      existing
        ? { detector: f.detector, severity: f.severity, count: existing.count + 1 }
        : { detector: f.detector, severity: f.severity, count: 1 },
    );
  }
  return [...byKey.values()].sort((a, b) => a.detector.localeCompare(b.detector));
}
