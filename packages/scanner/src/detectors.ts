import type { ScanFinding, Severity } from "@yuhi/shared";
import { shannonEntropy, maskSecret } from "./entropy.js";

/**
 * A deterministic detector. `category` is the id that policy rules reference
 * (e.g. "api-key", "access-token", "private-key", "high-entropy-string").
 *
 * IMPORTANT: findings never carry the raw matched value — only a masked preview.
 */
export interface Detector {
  id: string;
  category: string;
  severity: Severity;
  description: string;
  /** Return match ranges (start index in content) or run a custom scan. */
  scan(content: string): { index: number; value: string }[];
}

function regexDetector(
  id: string,
  category: string,
  severity: Severity,
  description: string,
  re: RegExp,
): Detector {
  return {
    id,
    category,
    severity,
    description,
    scan(content: string) {
      const out: { index: number; value: string }[] = [];
      const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = rx.exec(content)) !== null && guard++ < 1000) {
        out.push({ index: m.index, value: m[0] });
        if (m.index === rx.lastIndex) rx.lastIndex++;
      }
      return out;
    },
  };
}

/** Built-in deterministic detectors. Regexes are anchored/bounded to avoid ReDoS. */
export const BUILTIN_DETECTORS: Detector[] = [
  regexDetector(
    "private-key-block",
    "private-key",
    "critical",
    "PEM private key block",
    /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/,
  ),
  regexDetector(
    "aws-access-key-id",
    "api-key",
    "high",
    "AWS access key id",
    /\bAKIA[0-9A-Z]{16}\b/,
  ),
  regexDetector(
    "openai-key",
    "api-key",
    "critical",
    "OpenAI API key",
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  ),
  regexDetector(
    "anthropic-key",
    "api-key",
    "critical",
    "Anthropic API key",
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  ),
  regexDetector(
    "google-api-key",
    "api-key",
    "high",
    "Google API key",
    /\bAIza[0-9A-Za-z_-]{35}\b/,
  ),
  regexDetector(
    "github-token",
    "access-token",
    "critical",
    "GitHub token",
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/,
  ),
  regexDetector(
    "github-pat",
    "access-token",
    "critical",
    "GitHub fine-grained PAT",
    /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  ),
  regexDetector(
    "slack-token",
    "access-token",
    "high",
    "Slack token",
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  ),
  regexDetector(
    "stripe-key",
    "api-key",
    "critical",
    "Stripe secret key",
    /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/,
  ),
  regexDetector(
    "jwt",
    "access-token",
    "medium",
    "JSON Web Token",
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/,
  ),
  regexDetector(
    "database-url",
    "database-url",
    "high",
    "Database URL with embedded credentials",
    /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/,
  ),
];

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

export interface DetectorOptions {
  entropyThreshold: number;
  /** Extra sensitive keywords the user configured. */
  keywords: string[];
}

/**
 * High-entropy detector: flags long tokens (>= 24 chars) that (a) look like a
 * base64/hex secret AND (b) exceed the entropy threshold AND (c) sit near a
 * secret-ish assignment. This is intentionally conservative to limit noise; the
 * regex detectors above are the primary signal.
 */
const SECRET_KEY_HINT = /(secret|token|key|passwd|password|pwd|api[_-]?key|auth|credential)/i;
const TOKEN_RE = /[A-Za-z0-9+/=_-]{24,}/g;

function scanEntropy(content: string, opts: DetectorOptions): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = content.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (!SECRET_KEY_HINT.test(line)) continue;
    let m: RegExpExecArray | null;
    TOKEN_RE.lastIndex = 0;
    let guard = 0;
    while ((m = TOKEN_RE.exec(line)) !== null && guard++ < 50) {
      const value = m[0];
      if (shannonEntropy(value) >= opts.entropyThreshold) {
        findings.push({
          detector: "high-entropy-string",
          path: "",
          line: li + 1,
          severity: "medium",
          maskedPreview: maskSecret(value),
          description: "High-entropy string near a secret-like assignment",
        });
      }
    }
  }
  return findings;
}

function scanKeywords(content: string, opts: DetectorOptions): ScanFinding[] {
  const findings: ScanFinding[] = [];
  if (opts.keywords.length === 0) return findings;
  const lines = content.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const lower = lines[li]!.toLowerCase();
    for (const kw of opts.keywords) {
      if (kw && lower.includes(kw.toLowerCase())) {
        findings.push({
          detector: "user-keyword",
          path: "",
          line: li + 1,
          severity: "medium",
          maskedPreview: `keyword: ${kw}`,
          description: `Matched user-configured sensitive keyword "${kw}"`,
        });
        break;
      }
    }
  }
  return findings;
}

/** Run all detectors against text content. Returns findings without a path set. */
export function runDetectors(
  content: string,
  opts: DetectorOptions,
  detectors: Detector[] = BUILTIN_DETECTORS,
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const d of detectors) {
    for (const hit of d.scan(content)) {
      findings.push({
        detector: d.category,
        path: "",
        line: lineOf(content, hit.index),
        severity: d.severity,
        maskedPreview: maskSecret(hit.value),
        description: d.description,
      });
    }
  }
  findings.push(...scanEntropy(content, opts));
  findings.push(...scanKeywords(content, opts));
  return findings;
}
