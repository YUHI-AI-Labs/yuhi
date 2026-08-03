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

import { BUILTIN_DETECTORS, redactText, runDetectors, type Detector } from "@yuhi/scanner";
import type { DetectorOptions } from "@yuhi/scanner";
import type { ScanFinding } from "@yuhi/shared";

import { privateLiterals, type PrivateMetadata } from "./event.js";

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
}

export function scanAndRedact(
  content: string,
  opts: DetectorOptions = DEFAULT_DETECTOR_OPTIONS,
  detectors: readonly Detector[] = BUILTIN_DETECTORS,
): ContentScan {
  const list = detectors as Detector[];
  const raw = runDetectors(content, opts, list);
  const { redacted, count } = redactText(content, opts, list);
  return {
    text: redacted,
    findings: summarize(raw),
    redactions: count,
    criticalOrHigh: raw.filter((f) => f.severity === "critical" || f.severity === "high").length,
  };
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
 * The last gate before delivery. Re-scans the exact bytes about to be sent. Anything
 * critical/high, or any surviving private literal, fails closed — the runtime turns
 * that into `withheld`, never a raw fallback.
 */
export function exactOutputScan(
  deliveryText: string,
  meta: PrivateMetadata,
  opts: DetectorOptions = DEFAULT_DETECTOR_OPTIONS,
  detectors: readonly Detector[] = BUILTIN_DETECTORS,
): ExactOutputVerdict {
  const findings = runDetectors(deliveryText, opts, detectors as Detector[]);
  const summary = summarize(findings);
  const severe = findings.filter((f) => f.severity === "critical" || f.severity === "high");
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
