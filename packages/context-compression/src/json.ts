/**
 * JSON compressor — vertical slice 1 (spec §12, §20).
 *
 *   Large JSON → schema → statistics → interesting rows → retrieve
 *
 * The delivered artifact is a *view*, not JSON: it uses `…` markers where content
 * was withheld. Every marker has a JSONPath locator in `omissions`, so the agent can
 * ask for exactly that region via the store's `jsonPath()`. Nothing is destroyed.
 *
 * Determinism: object keys keep document order (`JSON.parse` preserves insertion
 * order); merged element schemas sort their keys, because key order across thousands
 * of rows is not stable input. The same bytes therefore always produce the same view,
 * which is what makes delivered-prefix stability (architecture §2) achievable.
 */

import { formatJsonPath, type JsonPathSegment } from "@yuhi/context-store";

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

export const JSON_COMPRESSOR_ID = "json-outline";
export const JSON_COMPRESSOR_VERSION = "1";

/**
 * Keys that make a row worth showing even when its neighbours are collapsed. A
 * 10k-row array whose row 8,214 is the failure is the case where naive
 * head/tail sampling delivers a smaller payload and a useless one.
 */
const INTERESTING_KEYS = ["error", "errors", "exception", "failed", "failure", "stack", "traceback"];

interface Settings {
  readonly sampleKeep: number;
  readonly maxDepth: number;
  readonly maxStringChars: number;
  readonly maxKeys: number;
  readonly interestingRows: number;
}

/**
 * Budget ladder. We try settings in order and keep the first view that fits the
 * caller's token budget — deterministic, and cheap enough to run several times.
 */
const LADDER: readonly Settings[] = [
  { sampleKeep: 2, maxDepth: 5, maxStringChars: 160, maxKeys: 32, interestingRows: 3 },
  { sampleKeep: 1, maxDepth: 4, maxStringChars: 120, maxKeys: 24, interestingRows: 3 },
  { sampleKeep: 1, maxDepth: 3, maxStringChars: 80, maxKeys: 16, interestingRows: 2 },
  { sampleKeep: 0, maxDepth: 2, maxStringChars: 60, maxKeys: 12, interestingRows: 1 },
];

/** Mutable per-call state. Never module-level: compressors must be thread-safe. */
interface Build {
  readonly lines: string[];
  readonly omissions: Omission[];
  readonly anchors: string[];
  readonly removed: Map<string, number>;
  readonly input: CompressInput;
  readonly ctx: CompressContext;
  readonly cfg: Settings;
}

export const jsonCompressor: Compressor = {
  id: JSON_COMPRESSOR_ID,
  version: JSON_COMPRESSOR_VERSION,

  supports(kind, sample: Sample): boolean {
    if (kind === "json") return true;
    // A tool that returned JSON as generic text is still JSON.
    if (kind !== "text" && kind !== "shell-output") return false;
    const first = sample.text.trimStart()[0];
    return first === "{" || first === "[";
  },

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  },

  async compress(input: CompressInput, ctx: CompressContext): Promise<CompressResult> {
    throwIfAborted(ctx);
    // A parse failure is a hard failure, not a silent passthrough: the runtime
    // decides what to do, and its only safe options are another compressor or
    // withholding. Compression never falls back to raw content on its own.
    const parsed: unknown = JSON.parse(input.content);

    let best: CompressResult | undefined;
    for (const cfg of LADDER) {
      throwIfAborted(ctx);
      const built = render(parsed, input, ctx, cfg);
      best = built;
      if (input.tokenBudget === undefined || built.tokensAfter <= input.tokenBudget) break;
    }
    // `best` is always assigned: LADDER is non-empty.
    return best as CompressResult;
  },

  verify(input: CompressInput, result: CompressResult): VerifyOutcome {
    if (result.text.length === 0) return { ok: false, reason: "empty-view" };
    // Refusing to "compress" small content is honest: the runtime then delivers the
    // scanned original rather than a longer view (§18 forbids inflating).
    if (result.tokensAfter >= result.tokensBefore) return { ok: false, reason: "no-reduction" };
    for (const omission of result.omissions) {
      if (!omission.locator.startsWith("$")) return { ok: false, reason: "unretrievable-omission" };
      if (omission.objectId !== input.objectId) return { ok: false, reason: "foreign-omission" };
    }
    for (const anchor of result.anchors) {
      if (!result.text.includes(anchor)) return { ok: false, reason: "missing-anchor" };
    }
    return { ok: true };
  },
};

function render(parsed: unknown, input: CompressInput, ctx: CompressContext, cfg: Settings): CompressResult {
  const b: Build = {
    lines: [],
    omissions: [],
    anchors: [],
    removed: new Map(),
    input,
    ctx,
    cfg,
  };

  b.lines.push(`# JSON view — ${describeType(parsed)}, ${Buffer.byteLength(input.content, "utf8")} bytes original`);
  b.lines.push("# `…` marks withheld regions; every one is retrievable by the JSONPath shown.");
  renderNode(parsed, [], 0, b);

  const text = `${b.lines.join("\n")}\n`;
  return {
    compressorId: JSON_COMPRESSOR_ID,
    compressorVersion: JSON_COMPRESSOR_VERSION,
    text,
    anchors: b.anchors,
    omissions: b.omissions,
    removed: [...b.removed.entries()].map(([kind, count]) => ({ kind, count })).sort((x, y) => x.kind.localeCompare(y.kind)),
    tokensBefore: ctx.estimateTokens(input.content),
    tokensAfter: ctx.estimateTokens(text),
  };
}

/** Structural pass: one line per container, samples/stats indented beneath it. */
function renderNode(node: unknown, segs: JsonPathSegment[], depth: number, b: Build): void {
  throwIfAborted(b.ctx);
  const path = formatJsonPath(segs);
  const pad = "  ".repeat(depth);

  if (Array.isArray(node)) {
    const schema = mergedSchema(node);
    const line = `${pad}${path}: array(${node.length})${schema ? ` of ${schema}` : ""}`;
    b.lines.push(line);
    if (depth <= 1) b.anchors.push(line);

    const stats = numericStats(node);
    if (stats) b.lines.push(`${pad}  stats: ${stats}`);

    const keep = b.cfg.sampleKeep;
    const shownIdx = sampleIndexes(node.length, keep);
    for (const i of shownIdx) {
      b.lines.push(`${pad}  [${i}]: ${compact(node[i], [...segs, { kind: "index", index: i }], depth + 1, b)}`);
    }
    for (const i of interestingIndexes(node, shownIdx, b.cfg.interestingRows)) {
      b.lines.push(`${pad}  interesting [${i}]: ${compact(node[i], [...segs, { kind: "index", index: i }], depth + 1, b)}`);
    }

    const shown = new Set(shownIdx);
    const omitted = node.length - shown.size;
    if (omitted > 0) {
      const start = keep;
      const end = node.length - keep;
      recordOmission(b, {
        objectId: b.input.objectId,
        locator: formatJsonPath([...segs, { kind: "slice", start, end }]),
        kind: "array-elements",
        tokensOmitted: b.ctx.estimateTokens(JSON.stringify(node.slice(start, end))),
        items: omitted,
      });
      b.lines.push(`${pad}  omitted ${omitted} elements → retrieve ${formatJsonPath([...segs, { kind: "slice", start, end }])}`);
    }
    return;
  }

  if (isPlainObject(node)) {
    const keys = Object.keys(node);
    const line = `${pad}${path}: object(${keys.length} keys)`;
    b.lines.push(line);
    if (depth <= 1) b.anchors.push(line);

    const shownKeys = keys.slice(0, b.cfg.maxKeys);
    for (const key of shownKeys) {
      const childSegs: JsonPathSegment[] = [...segs, { kind: "key", key }];
      const value = node[key];
      if (depth + 1 < b.cfg.maxDepth && isContainer(value)) {
        renderNode(value, childSegs, depth + 1, b);
      } else {
        b.lines.push(`${"  ".repeat(depth + 1)}${key}: ${compact(value, childSegs, depth + 1, b)}`);
      }
    }
    if (keys.length > shownKeys.length) {
      const rest = keys.length - shownKeys.length;
      recordOmission(b, {
        objectId: b.input.objectId,
        locator: path,
        kind: "object-keys",
        tokensOmitted: 0,
        items: rest,
      });
      b.lines.push(`${pad}  … ${rest} more keys → retrieve ${path}`);
    }
    return;
  }

  b.lines.push(`${pad}${path}: ${compact(node, segs, depth, b)}`);
}

/**
 * Inline rendering with reversible truncation. Every `…` emitted here records an
 * omission first, so the view can never contain an unretrievable hole.
 */
function compact(value: unknown, segs: JsonPathSegment[], depth: number, b: Build): string {
  if (typeof value === "string") {
    if (value.length <= b.cfg.maxStringChars) return JSON.stringify(value);
    recordOmission(b, {
      objectId: b.input.objectId,
      locator: formatJsonPath(segs),
      kind: "string-tail",
      tokensOmitted: b.ctx.estimateTokens(value.slice(b.cfg.maxStringChars)),
    });
    return `${JSON.stringify(`${value.slice(0, b.cfg.maxStringChars)}…`)} (truncated, ${value.length} chars)`;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    if (depth >= b.cfg.maxDepth || value.length > b.cfg.sampleKeep * 2 + 1) {
      recordOmission(b, {
        objectId: b.input.objectId,
        locator: formatJsonPath(segs),
        kind: "array",
        tokensOmitted: b.ctx.estimateTokens(JSON.stringify(value)),
        items: value.length,
      });
      return `[… ${value.length} elements …]`;
    }
    return `[${value.map((v, i) => compact(v, [...segs, { kind: "index", index: i }], depth + 1, b)).join(", ")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (depth >= b.cfg.maxDepth) {
      recordOmission(b, {
        objectId: b.input.objectId,
        locator: formatJsonPath(segs),
        kind: "object",
        tokensOmitted: b.ctx.estimateTokens(JSON.stringify(value)),
        items: keys.length,
      });
      return `{… ${keys.length} keys …}`;
    }
    const shown = keys.slice(0, b.cfg.maxKeys);
    const parts = shown.map(
      (k) => `${JSON.stringify(k)}: ${compact(value[k], [...segs, { kind: "key", key: k }], depth + 1, b)}`,
    );
    if (keys.length > shown.length) {
      recordOmission(b, {
        objectId: b.input.objectId,
        locator: formatJsonPath(segs),
        kind: "object-keys",
        tokensOmitted: 0,
        items: keys.length - shown.length,
      });
      parts.push(`… ${keys.length - shown.length} more keys …`);
    }
    return `{${parts.join(", ")}}`;
  }
  return "null";
}

function recordOmission(b: Build, omission: Omission): void {
  b.omissions.push(omission);
  b.removed.set(omission.kind, (b.removed.get(omission.kind) ?? 0) + (omission.items ?? 1));
}

/** First `keep` and last `keep` indexes, deduplicated and ordered. */
function sampleIndexes(length: number, keep: number): number[] {
  if (keep <= 0 || length === 0) return [];
  const out = new Set<number>();
  for (let i = 0; i < keep && i < length; i++) out.add(i);
  for (let i = Math.max(0, length - keep); i < length; i++) out.add(i);
  return [...out].sort((a, c) => a - c);
}

function interestingIndexes(node: readonly unknown[], already: readonly number[], limit: number): number[] {
  if (limit <= 0) return [];
  const skip = new Set(already);
  const out: number[] = [];
  const scanLimit = Math.min(node.length, 5000);
  for (let i = 0; i < scanLimit && out.length < limit; i++) {
    if (skip.has(i)) continue;
    const row = node[i];
    if (!isPlainObject(row)) continue;
    for (const key of Object.keys(row)) {
      if (!INTERESTING_KEYS.includes(key.toLowerCase())) continue;
      const v = row[key];
      if (v === null || v === undefined || v === false || v === "" || (Array.isArray(v) && v.length === 0)) continue;
      out.push(i);
      break;
    }
  }
  return out;
}

/** Merged element schema. Keys are sorted: row key order is not stable input. */
function mergedSchema(node: readonly unknown[]): string {
  if (node.length === 0) return "";
  const scanLimit = Math.min(node.length, 1000);
  const kinds = new Set<string>();
  const fields = new Map<string, Set<string>>();
  for (let i = 0; i < scanLimit; i++) {
    const el = node[i];
    kinds.add(describeType(el));
    if (isPlainObject(el)) {
      for (const [k, v] of Object.entries(el)) {
        const set = fields.get(k) ?? new Set<string>();
        set.add(describeType(v));
        fields.set(k, set);
      }
    }
  }
  const kindList = [...kinds].sort().join("|");
  if (fields.size === 0) return kindList;
  const shape = [...fields.entries()]
    .sort((a, c) => a[0].localeCompare(c[0]))
    .map(([k, types]) => `${k}:${[...types].sort().join("|")}`)
    .join(", ");
  return `${kindList}{${shape}}`;
}

function numericStats(node: readonly unknown[]): string | undefined {
  const scanLimit = Math.min(node.length, 5000);
  let count = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < scanLimit; i++) {
    const v = node[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    count++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (count === 0) return undefined;
  const scanned = count < node.length ? ` (first ${count})` : "";
  return `number min=${min} max=${max}${scanned}`;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isPlainObject(value)) return "object";
  return typeof value;
}

function isContainer(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
