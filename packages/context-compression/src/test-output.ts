/**
 * Slice 3A — test-output and shell-output compressor.
 *
 * The highest-value dynamic content in a real coding session: a test run prints
 * thousands of passing records and framework noise around the handful of lines that
 * actually decide what to do next.
 *
 * PRESERVED (never dropped, and asserted by `verify()`):
 *   command · exit code · pass/fail/skip counts · failing test names · failure messages
 *   stack traces (capped per trace) · file:line anchors · warnings (first of each)
 *   durations when meaningful
 *
 * DROPPED (each range retrievable):
 *   passing test records · repeated framework output · progress indicators
 *   duplicate warnings · repeated stack frames beyond the cap · install noise
 *   exact duplicate lines
 *
 * The anchors matter beyond token count: a patch is written against `file:line`, so a
 * compressor that drops anchors produces a smaller payload and a broken edit.
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
import { coalesceDroppedLines, normalizeForDuplicates, renderSelection } from "./line-selection.js";

export const TEST_OUTPUT_COMPRESSOR_ID = "test-output-failures-and-anchors";
export const TEST_OUTPUT_COMPRESSOR_VERSION = "1";

/** Below this there is nothing worth restructuring. */
const MIN_LINES = 40;
/** Frames kept per stack trace: enough to locate, not enough to bury the message. */
const MAX_FRAMES_PER_TRACE = 6;

// --- Preserve ---------------------------------------------------------------------
const FAILURE_MARKER = /(^|\s)(FAIL|FAILED|✗|×|✕|●|ERROR|E\s{2,})|(^|\b)(AssertionError|Unhandled|Uncaught)/;
const FAILURE_MESSAGE = /^\s*(Error|TypeError|ReferenceError|AssertionError|SyntaxError|RangeError|expected|Expected|Received|Actual|Diff|-\s|\+\s|assert)/;
const SUMMARY = /\b(\d+)\s+(passed|failed|skipped|pending|todo|passing|failing|errors?)\b|^\s*(Test Files|Tests|Suites|Snapshots|Duration|Time|Ran all)\b/i;
const EXIT_CODE = /\b(exit(ed)?\s+(code|status)|exit code)\b\s*[:=]?\s*\d+|^\s*\$\?\s*=\s*\d+/i;
const COMMAND_ECHO = /^\s*[$>»]\s+\S/;
const STACK_FRAME = /^\s*(at\s+\S|File\s+"|\s+#\d+\s+0x|from\s+\S+:\d+)/;
const FILE_ANCHOR = /(^|[\s(])([\w./~@-]+\.[a-z]{1,5}):(\d+)(:(\d+))?/i;
const WARNING = /^\s*(warn(ing)?|WARN|DeprecationWarning|npm warn)\b/i;

// --- Drop -------------------------------------------------------------------------
const PASSING_RECORD = /^\s*(PASS\b|✓|√|ok\s+\d+|·|\s*✔)|\s(PASS|passed)\s*$/;
const PROGRESS = /\r|^\s*[[#=>\-|/\\]+\s*\d{1,3}%|^\s*\d{1,3}%\s|^\s*[|/\-\\]\s*$|^\s*\.{3,}\s*$/;
const INSTALL_NOISE = /^\s*(added|removed|changed|audited)\s+\d+\s+packages|^\s*Progress:\s+resolved|^\s*(npm|pnpm|yarn)\s+(notice|info|sill|http)\b|node_modules\/\.(pnpm|bin)\b/;
const FRAMEWORK_NOISE = /^\s*(RUN|DEV|WAIT|WATCH)\s+v?\d|^\s*(Determining test suites|Using|Loaded config|Starting|Collecting)\b/;

export const testOutputCompressor: Compressor = {
  id: TEST_OUTPUT_COMPRESSOR_ID,
  version: TEST_OUTPUT_COMPRESSOR_VERSION,

  supports(kind, sample: Sample): boolean {
    if (kind !== "test-output" && kind !== "shell-output" && kind !== "log") return false;
    return sample.text.split("\n").length >= MIN_LINES;
  },

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  },

  async compress(input: CompressInput, ctx: CompressContext): Promise<CompressResult> {
    throwIfAborted(ctx);
    const lines = input.content.split("\n");
    const droppedLines: number[] = [];
    const reasons = new Map<number, string>();
    const anchors: string[] = [];

    const seenNormalized = new Set<string>();
    const seenWarnings = new Set<string>();
    let framesInCurrentTrace = 0;
    let blankRun = 0;

    for (let i = 0; i < lines.length; i++) {
      if ((i & 0x3ff) === 0) throwIfAborted(ctx);
      const line = lines[i] ?? "";
      const lineNumber = i + 1;
      const normalized = normalizeForDuplicates(line);

      // Stack-frame state resets whenever we leave a trace.
      if (STACK_FRAME.test(line)) {
        framesInCurrentTrace++;
      } else if (normalized !== "") {
        framesInCurrentTrace = 0;
      }

      if (normalized === "") {
        blankRun++;
        if (blankRun > 1) {
          droppedLines.push(lineNumber);
          reasons.set(lineNumber, "blank");
        }
        continue;
      }
      blankRun = 0;

      // ---- preserve, in priority order -------------------------------------------
      const isFailure = FAILURE_MARKER.test(line) || FAILURE_MESSAGE.test(line);
      const isSummary = SUMMARY.test(line);
      const isExit = EXIT_CODE.test(line);
      const isCommand = COMMAND_ECHO.test(line);
      const hasAnchor = FILE_ANCHOR.test(line);

      if (isExit || isSummary || isCommand) {
        if (anchors.length < 24) anchors.push(line.trim());
        continue;
      }
      if (isFailure) {
        if (anchors.length < 24) anchors.push(line.trim());
        continue;
      }
      if (STACK_FRAME.test(line)) {
        if (framesInCurrentTrace <= MAX_FRAMES_PER_TRACE) continue;
        droppedLines.push(lineNumber);
        reasons.set(lineNumber, "repeated stack frames");
        continue;
      }
      if (WARNING.test(line)) {
        // First of each distinct warning is kept; repeats are dropped.
        if (!seenWarnings.has(normalized)) {
          seenWarnings.add(normalized);
          continue;
        }
        droppedLines.push(lineNumber);
        reasons.set(lineNumber, "duplicate warnings");
        continue;
      }
      if (hasAnchor) continue;

      // ---- drop -------------------------------------------------------------------
      if (PASSING_RECORD.test(line)) {
        droppedLines.push(lineNumber);
        reasons.set(lineNumber, "passing test records");
        continue;
      }
      if (PROGRESS.test(line)) {
        droppedLines.push(lineNumber);
        reasons.set(lineNumber, "progress output");
        continue;
      }
      if (INSTALL_NOISE.test(line)) {
        droppedLines.push(lineNumber);
        reasons.set(lineNumber, "install noise");
        continue;
      }
      if (FRAMEWORK_NOISE.test(line)) {
        droppedLines.push(lineNumber);
        reasons.set(lineNumber, "framework output");
        continue;
      }
      if (seenNormalized.has(normalized)) {
        droppedLines.push(lineNumber);
        reasons.set(lineNumber, "duplicate lines");
        continue;
      }
      seenNormalized.add(normalized);
    }

    const coalesced = coalesceDroppedLines({
      lines,
      droppedLines,
      objectId: input.objectId,
      estimateTokens: ctx.estimateTokens,
      reasons,
    });
    const text = renderSelection(lines, new Set(droppedLines), coalesced.markers);

    return {
      compressorId: TEST_OUTPUT_COMPRESSOR_ID,
      compressorVersion: TEST_OUTPUT_COMPRESSOR_VERSION,
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
    for (const omission of result.omissions) {
      if (!/^L\d+-L\d+$/.test(omission.locator)) return { ok: false, reason: "unretrievable-omission" };
      if (omission.objectId !== input.objectId) return { ok: false, reason: "foreign-omission" };
    }

    // Anchor verification is the real postcondition: a smaller payload that lost the
    // exit code, a failing test name, or a file:line anchor is a broken result.
    for (const line of input.content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      // Stack frames past the per-trace cap are dropped deliberately, so an anchor
      // that lives only in a deep frame is not a postcondition. Everything else is.
      const load =
        EXIT_CODE.test(line) ||
        SUMMARY.test(line) ||
        FAILURE_MARKER.test(line) ||
        FAILURE_MESSAGE.test(line) ||
        (FILE_ANCHOR.test(line) && !STACK_FRAME.test(line));
      if (load && !result.text.includes(trimmed)) {
        return { ok: false, reason: "dropped-anchor" };
      }
    }
    return { ok: true };
  },
};
