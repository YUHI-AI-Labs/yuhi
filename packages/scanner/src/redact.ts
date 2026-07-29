import { BUILTIN_DETECTORS, type Detector, type DetectorOptions } from "./detectors.js";
import { shannonEntropy } from "./entropy.js";

export interface RedactResult {
  redacted: string;
  /** Number of spans replaced. */
  count: number;
}

const SECRET_KEY_HINT = /(secret|token|key|passwd|password|pwd|api[_-]?key|auth|credential)/i;
const TOKEN_RE = /[A-Za-z0-9+/=_-]{24,}/g;

interface Span {
  start: number;
  end: number;
  label: string;
}

/**
 * Replace detected secret spans in `content` with `«REDACTED:<category>»`
 * placeholders. Deterministic and applied ONLY to the workspace copy — the
 * original file is never touched (ADR-0004 / THREAT_MODEL T2).
 */
export function redactText(
  content: string,
  opts: DetectorOptions,
  detectors: Detector[] = BUILTIN_DETECTORS,
): RedactResult {
  const spans: Span[] = [];

  for (const d of detectors) {
    for (const hit of d.scan(content)) {
      spans.push({ start: hit.index, end: hit.index + hit.value.length, label: d.category });
    }
  }

  // Entropy spans: absolute indices of high-entropy tokens on secret-like lines.
  let lineStart = 0;
  for (const line of content.split("\n")) {
    if (SECRET_KEY_HINT.test(line)) {
      TOKEN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = TOKEN_RE.exec(line)) !== null && guard++ < 50) {
        if (shannonEntropy(m[0]) >= opts.entropyThreshold) {
          spans.push({
            start: lineStart + m.index,
            end: lineStart + m.index + m[0].length,
            label: "high-entropy-string",
          });
        }
      }
    }
    lineStart += line.length + 1; // +1 for the split "\n"
  }

  if (spans.length === 0) return { redacted: content, count: 0 };

  // Merge overlapping spans, keep the earliest label.
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ ...s });
    }
  }

  let out = "";
  let cursor = 0;
  for (const s of merged) {
    out += content.slice(cursor, s.start);
    out += `«REDACTED:${s.label}»`;
    cursor = s.end;
  }
  out += content.slice(cursor);
  return { redacted: out, count: merged.length };
}
