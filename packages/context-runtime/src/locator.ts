/**
 * Locator grammar and containment (spec §10: "requested locator was exposed or
 * policy-approved").
 *
 * Retrieval authorization is NOT "the agent knows an object id". An opaque id plus an
 * arbitrary locator would make `retrieve` an unrestricted read of private bytes. The
 * rule instead is: a requested locator must be the one Yuhi exposed, or *narrower*
 * than one it exposed. Narrower is always safe — it delivers strictly less.
 */

import { parseJsonPath, type JsonPathSegment } from "@yuhi/context-store";

export type Locator =
  | { readonly kind: "json"; readonly segments: readonly JsonPathSegment[] }
  | { readonly kind: "lines"; readonly from: number; readonly to: number }
  /** Byte range into the original bytes; end-exclusive. Used for long single-line content. */
  | { readonly kind: "bytes"; readonly from: number; readonly to: number };

export function parseLocator(raw: string): Locator | undefined {
  if (raw.startsWith("$")) {
    try {
      return { kind: "json", segments: parseJsonPath(raw) };
    } catch {
      return undefined;
    }
  }
  const lines = /^L(\d+)-L(\d+)$/.exec(raw);
  if (lines) {
    const from = Number(lines[1]);
    const to = Number(lines[2]);
    if (from < 1 || to < from) return undefined;
    return { kind: "lines", from, to };
  }
  const bytes = /^B(\d+)-B(\d+)$/.exec(raw);
  if (bytes) {
    const from = Number(bytes[1]);
    const to = Number(bytes[2]);
    if (to < from) return undefined;
    return { kind: "bytes", from, to };
  }
  return undefined;
}

/** True when `requested` delivers a subset of what `exposed` would deliver. */
export function locatorWithin(requested: Locator, exposed: Locator): boolean {
  if (requested.kind === "lines" && exposed.kind === "lines") {
    return requested.from >= exposed.from && requested.to <= exposed.to;
  }
  if (requested.kind === "bytes" && exposed.kind === "bytes") {
    return requested.from >= exposed.from && requested.to <= exposed.to;
  }
  if (requested.kind !== "json" || exposed.kind !== "json") return false;
  if (requested.segments.length < exposed.segments.length) return false;

  for (let i = 0; i < exposed.segments.length; i++) {
    const e = exposed.segments[i];
    const r = requested.segments[i];
    if (!e || !r) return false;
    const last = i === exposed.segments.length - 1;
    if (segmentEqual(e, r)) continue;
    // Only the final exposed segment may widen: a slice or wildcard contains the
    // narrower index/slice the agent is asking for. Deeper requested segments are
    // fine — they address less content, not more.
    if (!last || !segmentContains(e, r)) return false;
  }
  return true;
}

function segmentEqual(a: JsonPathSegment, b: JsonPathSegment): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "key" && b.kind === "key") return a.key === b.key;
  if (a.kind === "index" && b.kind === "index") return a.index === b.index;
  if (a.kind === "slice" && b.kind === "slice") return a.start === b.start && a.end === b.end;
  return a.kind === "wildcard" && b.kind === "wildcard";
}

function segmentContains(exposed: JsonPathSegment, requested: JsonPathSegment): boolean {
  if (exposed.kind === "wildcard") return requested.kind === "index" || requested.kind === "slice";
  if (exposed.kind !== "slice") return false;
  if (requested.kind === "index") return requested.index >= exposed.start && requested.index < exposed.end;
  if (requested.kind === "slice") return requested.start >= exposed.start && requested.end <= exposed.end;
  return false;
}

/** A deterministic narrower suggestion for an over-large request. */
export function narrowSuggestion(locator: Locator, maxItems: number): string | undefined {
  if (locator.kind === "lines") {
    return `L${locator.from}-L${Math.min(locator.to, locator.from + maxItems - 1)}`;
  }
  if (locator.kind === "bytes") {
    // Byte ranges narrow by size, not by item count: keep a readable window.
    return `B${locator.from}-B${Math.min(locator.to, locator.from + 8_000)}`;
  }
  const last = locator.segments[locator.segments.length - 1];
  if (!last || last.kind !== "slice") return undefined;
  const end = Math.min(last.end, last.start + maxItems);
  const head = locator.segments.slice(0, -1).map(renderSegment).join("");
  return `$${head}[${last.start}:${end}]`;
}

function renderSegment(s: JsonPathSegment): string {
  if (s.kind === "key") return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(s.key) ? `.${s.key}` : `[${JSON.stringify(s.key)}]`;
  if (s.kind === "index") return `[${s.index}]`;
  if (s.kind === "wildcard") return "[*]";
  return `[${s.start}:${s.end}]`;
}
