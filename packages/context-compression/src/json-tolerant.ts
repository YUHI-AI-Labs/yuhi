/**
 * Slice 3C — tolerant JSON structure scanner.
 *
 * The strict compressor needs a parseable document. Real Claude Code traffic gives us
 * (ADR-0005): one-line JSON cut off mid-document, fragments, NDJSON, incomplete arrays.
 * A strict parser throws on all of those, which is how the first real session measured
 * 0.0% reduction.
 *
 * This is deliberately NOT a JSON parser and never attempts repair. It is a character
 * scanner that reports what it can see — candidate keys per depth, repeated shapes,
 * nesting, error/status fields, representative values — and hands back byte or line
 * locators for everything it did not deliver. Strict parsing is tried first by the
 * registry; this runs only when that fails.
 */

import {
  throwIfAborted,
  type CompressContext,
  type CompressInput,
  type CompressResult,
  type Compressor,
  type Omission,
  type Sample,
  type VerifyOutcome,
} from "./contract.js";
import { coalesceDroppedLines, renderSelection } from "./line-selection.js";

export const JSON_TOLERANT_COMPRESSOR_ID = "json-tolerant-scan";
export const JSON_TOLERANT_COMPRESSOR_VERSION = "1";

const MIN_BYTES = 4_000;
const HEAD_BYTES = 900;
const MAX_KEYS_REPORTED = 24;
const MAX_INTERESTING = 6;
const MAX_TRACKED_VALUES = 400;
/** Lower rank wins. An error beats a status; a status beats a message. */
const KEY_RANK: Record<string, number> = {
  error: 0, errors: 0, exception: 0, failed: 0, failure: 0, stack: 0, traceback: 0,
  status: 1, code: 1, message: 2,
};
const NDJSON_MIN_LINES = 5;

const INTERESTING_KEY = /^(error|errors|exception|status|failed|failure|stack|traceback|message|code)$/i;

export const jsonTolerantCompressor: Compressor = {
  id: JSON_TOLERANT_COMPRESSOR_ID,
  version: JSON_TOLERANT_COMPRESSOR_VERSION,

  supports(kind, sample: Sample): boolean {
    if (kind !== "json" && kind !== "text" && kind !== "shell-output" && kind !== "log") return false;
    if (sample.bytes < MIN_BYTES) return false;
    const trimmed = sample.text.trimStart();
    return trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"');
  },

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  },

  async compress(input: CompressInput, ctx: CompressContext): Promise<CompressResult> {
    throwIfAborted(ctx);
    const ndjson = tryNdjson(input, ctx);
    if (ndjson) return ndjson;

    const scan = scanStructure(input.content, ctx);
    const bytes = Buffer.from(input.content, "utf8");
    const head = bytes.subarray(0, Math.min(HEAD_BYTES, bytes.byteLength)).toString("utf8");
    const omissionFrom = Math.min(HEAD_BYTES, bytes.byteLength);
    const locator = `B${omissionFrom}-B${bytes.byteLength}`;

    const lines: string[] = [
      `[Yuhi tolerant JSON scan] ${bytes.byteLength} bytes · ${scan.truncated ? "TRUNCATED / not parseable as a complete document" : "not parseable as JSON"}`,
      `Nesting depth observed: ${scan.maxDepth}${scan.truncated ? ` · unclosed containers at end: ${scan.unclosed}` : ""}`,
    ];

    for (const [depth, keys] of [...scan.keysByDepth.entries()].sort((a, b) => a[0] - b[0]).slice(0, 4)) {
      const top = [...keys.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_KEYS_REPORTED);
      lines.push(
        `Keys at depth ${depth} (${keys.size} distinct): ${top.map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(", ")}`,
      );
    }
    if (scan.repeatedShape) {
      lines.push(`Repeated record shape (${scan.repeatedShapeCount} occurrences): {${scan.repeatedShape}}`);
    }
    if (scan.interesting.length > 0) {
      lines.push("Error/status fields found:");
      for (const item of scan.interesting) {
        lines.push(`  "${item.key}": ${item.value}${item.count > 1 ? ` (×${item.count})` : ""}`);
      }
    }
    lines.push(`Representative head (${head.length} bytes verbatim):`);
    lines.push(head);
    lines.push(`… ${bytes.byteLength - omissionFrom} bytes withheld → retrieve ${locator} …`);

    const text = lines.join("\n");
    const omissions: Omission[] = [
      {
        objectId: input.objectId,
        locator,
        kind: "json-fragment-bytes",
        tokensOmitted: ctx.estimateTokens(bytes.subarray(omissionFrom).toString("utf8")),
        items: bytes.byteLength - omissionFrom,
      },
    ];

    return {
      compressorId: JSON_TOLERANT_COMPRESSOR_ID,
      compressorVersion: JSON_TOLERANT_COMPRESSOR_VERSION,
      text,
      anchors: [lines[0] ?? ""],
      omissions,
      removed: [{ kind: "json-fragment-bytes", count: bytes.byteLength - omissionFrom }],
      tokensBefore: ctx.estimateTokens(input.content),
      tokensAfter: ctx.estimateTokens(text),
    };
  },

  verify(input: CompressInput, result: CompressResult): VerifyOutcome {
    if (result.tokensAfter >= result.tokensBefore) return { ok: false, reason: "no-reduction" };
    for (const omission of result.omissions) {
      if (!/^(B\d+-B\d+|L\d+-L\d+)$/.test(omission.locator)) return { ok: false, reason: "unretrievable-omission" };
      if (omission.objectId !== input.objectId) return { ok: false, reason: "foreign-omission" };
    }
    for (const anchor of result.anchors) {
      if (anchor !== "" && !result.text.includes(anchor)) return { ok: false, reason: "missing-anchor" };
    }
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------- NDJSON

/**
 * NDJSON / JSON-lines: each line is its own document, so the file as a whole never
 * parses. Handled by keeping head and tail records plus a merged shape.
 */
function tryNdjson(input: CompressInput, ctx: CompressContext): CompressResult | undefined {
  const lines = input.content.split("\n");
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  if (nonEmpty.length < NDJSON_MIN_LINES) return undefined;

  const sampleSize = Math.min(nonEmpty.length, 50);
  let parsed = 0;
  const fields = new Map<string, Set<string>>();
  for (let i = 0; i < sampleSize; i++) {
    const line = nonEmpty[i] ?? "";
    try {
      const value: unknown = JSON.parse(line);
      parsed++;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          const set = fields.get(k) ?? new Set<string>();
          set.add(v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
          fields.set(k, set);
        }
      }
    } catch {
      // A single unparseable record does not disqualify the file.
    }
  }
  if (parsed / sampleSize < 0.7) return undefined;

  const keep = 3;
  const keptNumbers = new Set<number>();
  const droppedLines: number[] = [];
  const reasons = new Map<number, string>();
  let seenRecords = 0;
  const interesting: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    seenRecords++;
    const isHead = seenRecords <= keep;
    const isTail = seenRecords > nonEmpty.length - keep;
    const looksInteresting = interesting.length < MAX_INTERESTING && /"(error|exception|failed|failure)"\s*:/i.test(line);
    if (isHead || isTail || looksInteresting) {
      keptNumbers.add(i + 1);
      if (looksInteresting && !isHead && !isTail) interesting.push(i + 1);
      continue;
    }
    droppedLines.push(i + 1);
    reasons.set(i + 1, "ndjson records");
  }
  if (droppedLines.length === 0) return undefined;

  const coalesced = coalesceDroppedLines({
    lines,
    droppedLines,
    objectId: input.objectId,
    estimateTokens: ctx.estimateTokens,
    reasons,
  });
  const shape = [...fields.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, types]) => `${k}:${[...types].sort().join("|")}`)
    .join(", ");
  const header = `[Yuhi tolerant JSON scan] NDJSON · ${nonEmpty.length} records · shape {${shape}}`;
  const text = `${header}\n${renderSelection(lines, new Set(droppedLines), coalesced.markers)}`;

  return {
    compressorId: JSON_TOLERANT_COMPRESSOR_ID,
    compressorVersion: JSON_TOLERANT_COMPRESSOR_VERSION,
    text,
    anchors: [header],
    omissions: coalesced.omissions,
    removed: coalesced.removed,
    tokensBefore: ctx.estimateTokens(input.content),
    tokensAfter: ctx.estimateTokens(text),
  };
}

// ------------------------------------------------------------------- structure scan

interface StructureScan {
  readonly maxDepth: number;
  readonly unclosed: number;
  readonly truncated: boolean;
  readonly keysByDepth: Map<number, Map<string, number>>;
  readonly repeatedShape?: string;
  readonly repeatedShapeCount: number;
  readonly interesting: { key: string; value: string; count: number }[];
}

/**
 * Choose which error/status values to surface. Rare values first: in a 400-record
 * fragment `"status":"ok"` appears 399 times and tells the agent nothing, while the one
 * `"status":"failed"` is the whole reason it is reading the file.
 */
function selectInteresting(tracked: Map<string, Map<string, number>>): { key: string; value: string; count: number }[] {
  const out: { key: string; value: string; count: number }[] = [];
  const keys = [...tracked.keys()].sort((a, b) => {
    const rank = (KEY_RANK[a.toLowerCase()] ?? 3) - (KEY_RANK[b.toLowerCase()] ?? 3);
    return rank !== 0 ? rank : a.localeCompare(b);
  });
  for (const key of keys) {
    const values = [...(tracked.get(key) ?? new Map()).entries()].sort(
      (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
    );
    for (const [value, count] of values.slice(0, 2)) {
      if (out.length >= MAX_INTERESTING) return out;
      out.push({ key, value, count });
    }
  }
  return out;
}

/**
 * Single pass over the characters. Tracks string state so a `{` inside a string never
 * changes depth, records which keys appear at which depth, and captures short values
 * for error/status-like keys.
 */
function scanStructure(content: string, ctx: CompressContext): StructureScan {
  const keysByDepth = new Map<number, Map<string, number>>();
  const tracked = new Map<string, Map<string, number>>();
  const shapes = new Map<string, number>();

  let depth = 0;
  let maxDepth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let pendingKey: { name: string; depth: number } | undefined;
  let currentShape: string[] = [];
  const shapeStack: string[][] = [];

  for (let i = 0; i < content.length; i++) {
    if ((i & 0xffff) === 0) throwIfAborted(ctx);
    const ch = content[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        const value = content.slice(stringStart + 1, i);
        // A string followed by `:` is a key.
        let j = i + 1;
        while (j < content.length && /\s/.test(content[j] ?? "")) j++;
        if (content[j] === ":") {
          const perDepth = keysByDepth.get(depth) ?? new Map<string, number>();
          perDepth.set(value, (perDepth.get(value) ?? 0) + 1);
          keysByDepth.set(depth, perDepth);
          currentShape.push(value);
          pendingKey = { name: value, depth };
        } else if (pendingKey && INTERESTING_KEY.test(pendingKey.name)) {
          track(tracked, pendingKey.name, JSON.stringify(value.slice(0, 160)));
          pendingKey = undefined;
        } else {
          pendingKey = undefined;
        }
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      stringStart = i;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
      shapeStack.push(currentShape);
      currentShape = [];
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (currentShape.length > 0) {
        const key = currentShape.slice(0, 12).sort().join(",");
        shapes.set(key, (shapes.get(key) ?? 0) + 1);
      }
      currentShape = shapeStack.pop() ?? [];
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (pendingKey && INTERESTING_KEY.test(pendingKey.name) && /[-\d tfn]/.test(ch ?? "")) {
      // A non-string value (number, true/false/null) for an interesting key.
      const slice = content.slice(i, i + 40);
      const match = /^(-?\d+(\.\d+)?|true|false|null)/.exec(slice.trim());
      if (match) track(tracked, pendingKey.name, match[1] ?? "");
      pendingKey = undefined;
    }
  }

  const repeated = [...shapes.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    maxDepth,
    unclosed: depth,
    truncated: depth > 0 || inString,
    keysByDepth,
    ...(repeated && repeated[1] > 1 ? { repeatedShape: repeated[0], repeatedShapeCount: repeated[1] } : { repeatedShapeCount: 0 }),
    interesting: selectInteresting(tracked),
  };
}

function track(tracked: Map<string, Map<string, number>>, key: string, value: string): void {
  const values = tracked.get(key) ?? new Map<string, number>();
  if (values.size >= MAX_TRACKED_VALUES && !values.has(value)) return;
  values.set(value, (values.get(value) ?? 0) + 1);
  tracked.set(key, values);
}
