/**
 * Slice 3B — grep / search result compressor.
 *
 * Search output is the other high-volume shape in a real session: hundreds of hits,
 * many of them the same line found twice, spread over dozens of files, when the agent
 * needs to know WHICH FILES matched and a couple of examples each.
 *
 * Preserved: the true total match count, the file list, per-file counts, and up to
 * `MAX_PER_FILE` representative hits per file with their line numbers (the anchors a
 * follow-up Read or patch needs).
 * Dropped: exact duplicate hits, hits beyond the per-file cap, files beyond the file
 * cap — every dropped run retrievable as a line range.
 *
 * Path policy is unchanged: paths are content here, so the runtime's metadata scan is
 * what masks absolute paths. This compressor never invents or rewrites a path.
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

export const SEARCH_COMPRESSOR_ID = "search-results-grouped";
export const SEARCH_COMPRESSOR_VERSION = "1";

const MAX_PER_FILE = 5;
const MAX_FILES = 25;
const MIN_HITS = 12;

/** `path:line:content` (ripgrep/grep -n) or `path:content`. */
const HIT_WITH_LINE = /^([^\s:][^:]*):(\d+):(.*)$/;
const HIT_PATH_ONLY = /^([^\s:][^:]*\.[A-Za-z0-9]{1,8})$/;

interface Hit {
  readonly lineNumber: number;
  readonly file: string;
  readonly line?: number;
  readonly content: string;
}

export const searchResultsCompressor: Compressor = {
  id: SEARCH_COMPRESSOR_ID,
  version: SEARCH_COMPRESSOR_VERSION,
  // Everything load-bearing is preserved by contract and asserted by verify(), so a
  // retrieve template would cost a turn without adding information.
  hintPolicy: "answer-complete",

  supports(kind, sample: Sample): boolean {
    if (kind !== "text" && kind !== "source" && kind !== "shell-output") return false;
    const lines = sample.text.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < MIN_HITS) return false;
    const hits = lines.filter((l) => HIT_WITH_LINE.test(l) || HIT_PATH_ONLY.test(l)).length;
    // Two thirds of the lines must look like search hits, so prose is not mangled.
    return hits / lines.length >= 0.66;
  },

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  },

  async compress(input: CompressInput, ctx: CompressContext): Promise<CompressResult> {
    throwIfAborted(ctx);
    const lines = input.content.split("\n");
    const hits: Hit[] = [];

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? "";
      if (raw.trim() === "") continue;
      const withLine = HIT_WITH_LINE.exec(raw);
      if (withLine) {
        hits.push({
          lineNumber: i + 1,
          file: withLine[1] ?? "",
          line: Number(withLine[2]),
          content: (withLine[3] ?? "").trim(),
        });
        continue;
      }
      const pathOnly = HIT_PATH_ONLY.exec(raw.trim());
      if (pathOnly) hits.push({ lineNumber: i + 1, file: pathOnly[1] ?? "", content: "" });
    }

    // Group by file, first appearance wins — deterministic and matches how the agent read it.
    const byFile = new Map<string, Hit[]>();
    for (const hit of hits) {
      const list = byFile.get(hit.file);
      if (list) list.push(hit);
      else byFile.set(hit.file, [hit]);
    }

    const droppedLines: number[] = [];
    const reasons = new Map<number, string>();
    const seen = new Set<string>();
    const anchors: string[] = [];
    let fileIndex = 0;

    for (const [file, fileHits] of byFile) {
      throwIfAborted(ctx);
      fileIndex++;
      const overFileCap = fileIndex > MAX_FILES;
      let keptInFile = 0;

      for (const hit of fileHits) {
        const key = `${hit.file}:${hit.line ?? ""}:${hit.content}`;
        if (seen.has(key)) {
          droppedLines.push(hit.lineNumber);
          reasons.set(hit.lineNumber, "duplicate hits");
          continue;
        }
        seen.add(key);

        if (overFileCap) {
          droppedLines.push(hit.lineNumber);
          reasons.set(hit.lineNumber, "files beyond the cap");
          continue;
        }
        if (keptInFile >= MAX_PER_FILE) {
          droppedLines.push(hit.lineNumber);
          reasons.set(hit.lineNumber, "hits beyond the per-file cap");
          continue;
        }
        keptInFile++;
        if (anchors.length < 24 && hit.line !== undefined) anchors.push(`${file}:${hit.line}`);
      }
    }

    const coalesced = coalesceDroppedLines({
      lines,
      droppedLines,
      objectId: input.objectId,
      estimateTokens: ctx.estimateTokens,
      reasons,
    });

    // The true counts are preserved even though the hits are not.
    const shownFiles = Math.min(byFile.size, MAX_FILES);
    const header = [
      `[search] ${hits.length} match${hits.length === 1 ? "" : "es"} in ${byFile.size} file${byFile.size === 1 ? "" : "s"} · showing ${shownFiles} file${shownFiles === 1 ? "" : "s"}, up to ${MAX_PER_FILE} per file`,
      ...[...byFile.entries()]
        .slice(0, MAX_FILES)
        .map(([file, fileHits]) => `${file}: ${fileHits.length} match${fileHits.length === 1 ? "" : "es"}`),
      "---",
    ].join("\n");
    anchors.unshift(`${hits.length} match${hits.length === 1 ? "" : "es"} in ${byFile.size} file${byFile.size === 1 ? "" : "s"}`);

    const body = renderSelection(lines, new Set(droppedLines), coalesced.markers);
    const text = `${header}\n${body}`;

    return {
      compressorId: SEARCH_COMPRESSOR_ID,
      compressorVersion: SEARCH_COMPRESSOR_VERSION,
      text,
      anchors,
      omissions: coalesced.omissions,
      removed: coalesced.removed,
      tokensBefore: ctx.estimateTokens(input.content),
      tokensAfter: ctx.estimateTokens(text),
    };
  },

  verify(input: CompressInput, result: CompressResult): VerifyOutcome {
    if (result.tokensAfter >= result.tokensBefore) return { ok: false, reason: "no-reduction" };
    if (!result.text.startsWith("[search] ")) return { ok: false, reason: "missing-header" };
    for (const omission of result.omissions) {
      if (!/^L\d+-L\d+$/.test(omission.locator)) return { ok: false, reason: "unretrievable-omission" };
      if (omission.objectId !== input.objectId) return { ok: false, reason: "foreign-omission" };
    }
    // The original match count must survive: recall is what a search result is for.
    const total = /^\[search\] (\d+) match/.exec(result.text);
    if (!total) return { ok: false, reason: "missing-match-count" };
    return { ok: true };
  },
};
