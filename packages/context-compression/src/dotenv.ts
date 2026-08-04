/**
 * Configuration compressor — `.env`, `*.tfvars`, and flat `KEY=VALUE` config.
 *
 * Developer Mode exists because an agent cannot diagnose "why can't the app reach the API"
 * without the configuration. So this compressor's job is the opposite of hiding: it must
 * preserve everything a diagnosis depends on —
 *
 *   variable names · presence and absence · value type · endpoint structure
 *   region/model/provider relationships · duplicate or conflicting definitions
 *
 * — and remove only what carries no diagnostic signal: comment blocks, repeated blank runs,
 * exact duplicate lines. Values are kept in the delivered view; whether a raw value may be
 * delivered at all is the DELIVERY POLICY's call, not this module's, and evidence and UI
 * never receive a value from anywhere.
 *
 * On a small `.env` this correctly achieves nothing, `verify()` says so, and the runtime
 * delivers the scanned original.
 */

import {
  throwIfAborted,
  type CompressContext,
  type CompressInput,
  type CompressResult,
  type Compressor,
  type Sample,
  type VerifyOutcome,
} from "./contract.js";
import { coalesceDroppedLines, renderSelection } from "./line-selection.js";

export const DOTENV_COMPRESSOR_ID = "config-keys-and-conflicts";
export const DOTENV_COMPRESSOR_VERSION = "1";

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/;
const COMMENT = /^\s*[#;]/;
/** Fewer assignments than this is a snippet, not a configuration file. */
const MIN_ASSIGNMENTS = 8;

type ValueType = "url" | "number" | "boolean" | "empty" | "quoted" | "string";

function classify(rawValue: string): ValueType {
  const value = rawValue.trim();
  if (value === "" || value === '""' || value === "''") return "empty";
  if (/^https?:\/\//i.test(value.replace(/^['"]|['"]$/g, ""))) return "url";
  if (/^-?\d+(\.\d+)?$/.test(value)) return "number";
  if (/^(true|false)$/i.test(value)) return "boolean";
  if (/^['"].*['"]$/.test(value)) return "quoted";
  return "string";
}

export const dotenvCompressor: Compressor = {
  id: DOTENV_COMPRESSOR_ID,
  version: DOTENV_COMPRESSOR_VERSION,
  // Every variable name, type and conflict is preserved by contract, so a retrieve prompt
  // would cost a turn without adding anything.
  hintPolicy: "answer-complete",

  supports(kind, sample: Sample): boolean {
    if (kind !== "text" && kind !== "source" && kind !== "shell-output") return false;
    const lines = sample.text.split("\n").filter((l) => l.trim() !== "" && !COMMENT.test(l));
    if (lines.length < MIN_ASSIGNMENTS) return false;
    const assignments = lines.filter((l) => ASSIGNMENT.test(l)).length;
    return assignments / lines.length >= 0.8;
  },

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  },

  async compress(input: CompressInput, ctx: CompressContext): Promise<CompressResult> {
    throwIfAborted(ctx);
    const lines = input.content.split("\n");
    const droppedLines: number[] = [];
    const reasons = new Map<number, string>();
    const seen = new Set<string>();
    const definitions = new Map<string, { count: number; types: Set<ValueType>; values: Set<string> }>();

    let blankRun = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const lineNumber = i + 1;

      if (line.trim() === "") {
        blankRun++;
        if (blankRun > 1) {
          droppedLines.push(lineNumber);
          reasons.set(lineNumber, "blank");
        }
        continue;
      }
      blankRun = 0;

      const assignment = ASSIGNMENT.exec(line);
      if (assignment) {
        const key = assignment[1] ?? "";
        const value = assignment[2] ?? "";
        const record = definitions.get(key) ?? { count: 0, types: new Set<ValueType>(), values: new Set<string>() };
        record.count++;
        record.types.add(classify(value));
        record.values.add(value.trim());
        definitions.set(key, record);

        // A duplicate KEY with the SAME value is noise; a duplicate with a DIFFERENT value
        // is a conflict and is exactly what the agent is looking for, so it is kept.
        if (seen.has(line.trim())) {
          droppedLines.push(lineNumber);
          reasons.set(lineNumber, "duplicate definitions");
          continue;
        }
        seen.add(line.trim());
        continue;
      }

      if (COMMENT.test(line)) {
        droppedLines.push(lineNumber);
        reasons.set(lineNumber, "comments");
        continue;
      }
    }

    const conflicts = [...definitions.entries()].filter(([, r]) => r.values.size > 1);
    const coalesced = coalesceDroppedLines({
      lines,
      droppedLines,
      objectId: input.objectId,
      estimateTokens: ctx.estimateTokens,
      reasons,
    });

    const header = [
      `[config] ${definitions.size} variables defined across ${lines.length} lines`,
      ...(conflicts.length > 0
        ? [`conflicting definitions: ${conflicts.map(([k, r]) => `${k} (${r.values.size} different values)`).join(", ")}`]
        : []),
      `types: ${summarizeTypes(definitions)}`,
      "---",
    ].join("\n");

    const text = `${header}\n${renderSelection(lines, new Set(droppedLines), coalesced.markers)}`;

    return {
      compressorId: DOTENV_COMPRESSOR_ID,
      compressorVersion: DOTENV_COMPRESSOR_VERSION,
      text,
      anchors: [`${definitions.size} variables defined`, ...conflicts.map(([k]) => k)],
      omissions: coalesced.omissions,
      removed: coalesced.removed,
      tokensBefore: ctx.estimateTokens(input.content),
      tokensAfter: ctx.estimateTokens(text),
    };
  },

  verify(input: CompressInput, result: CompressResult): VerifyOutcome {
    if (result.tokensAfter >= result.tokensBefore) return { ok: false, reason: "no-reduction" };
    for (const omission of result.omissions) {
      if (!/^L\d+-L\d+$/.test(omission.locator)) return { ok: false, reason: "unretrievable-omission" };
      if (omission.objectId !== input.objectId) return { ok: false, reason: "foreign-omission" };
    }
    // Every variable NAME must survive: a config view that lost a key would make the agent
    // report a variable as missing when it is present.
    for (const line of input.content.split("\n")) {
      const key = ASSIGNMENT.exec(line)?.[1];
      if (key && !result.text.includes(key)) return { ok: false, reason: "dropped-variable" };
    }
    return { ok: true };
  },
};

function summarizeTypes(
  definitions: ReadonlyMap<string, { count: number; types: Set<ValueType>; values: Set<string> }>,
): string {
  const counts = new Map<string, number>();
  for (const [, record] of definitions) {
    for (const type of record.types) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return (
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([type, n]) => `${n} ${type}`)
      .join(", ") || "none"
  );
}
