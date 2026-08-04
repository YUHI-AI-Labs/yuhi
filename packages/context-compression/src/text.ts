/**
 * Generic text compressor — the always-available last resort (spec §7: "fallback").
 *
 * Keeps a head and a tail window and withholds the middle, with an `L<from>-L<to>`
 * locator the store resolves via `getLines()`. Line-based rather than byte-based so
 * that a retrieval lands on whole lines, which is what an agent can act on.
 */

import {
  throwIfAborted,
  type CompressContext,
  type CompressInput,
  type CompressResult,
  type Compressor,
  type VerifyOutcome,
} from "./contract.js";

export const TEXT_COMPRESSOR_ID = "text-window";
export const TEXT_COMPRESSOR_VERSION = "1";

const HEAD_LINES = 60;
const TAIL_LINES = 40;
/** Below this, a window view costs more than it saves. */
const MIN_LINES = HEAD_LINES + TAIL_LINES + 20;

/**
 * Real Claude Code traffic taught us this case: a JSON file is ONE line, so a Read or
 * Grep of it arrives as a single 20 KB line. A line-based window can remove nothing
 * from one line, so long single-line content is windowed by BYTES instead, with a
 * `B<start>-B<end>` locator the store resolves through `getRange`.
 */
const MIN_CHARS_FOR_BYTE_WINDOW = 6_000;
const HEAD_CHARS = 2_400;
const TAIL_CHARS = 800;

export const textCompressor: Compressor = {
  id: TEXT_COMPRESSOR_ID,
  version: TEXT_COMPRESSOR_VERSION,

  supports(): boolean {
    return true;
  },

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  },

  async compress(input: CompressInput, ctx: CompressContext): Promise<CompressResult> {
    throwIfAborted(ctx);
    const lines = input.content.split("\n");
    const tokensBefore = ctx.estimateTokens(input.content);

    if (lines.length < MIN_LINES && Buffer.byteLength(input.content, "utf8") >= MIN_CHARS_FOR_BYTE_WINDOW) {
      return byteWindow(input, ctx, tokensBefore);
    }

    if (lines.length < MIN_LINES) {
      // Honest no-op: `verify()` rejects it and the runtime delivers the scanned
      // original instead of a view that is longer than the content.
      return {
        compressorId: TEXT_COMPRESSOR_ID,
        compressorVersion: TEXT_COMPRESSOR_VERSION,
        text: input.content,
        anchors: [],
        omissions: [],
        removed: [],
        tokensBefore,
        tokensAfter: tokensBefore,
      };
    }

    const head = lines.slice(0, HEAD_LINES);
    const tail = lines.slice(lines.length - TAIL_LINES);
    const from = HEAD_LINES + 1;
    const to = lines.length - TAIL_LINES;
    const middle = lines.slice(HEAD_LINES, lines.length - TAIL_LINES).join("\n");
    const locator = `L${from}-L${to}`;
    const marker = `… ${to - from + 1} lines withheld → retrieve ${locator} …`;
    const text = [...head, marker, ...tail].join("\n");

    return {
      compressorId: TEXT_COMPRESSOR_ID,
      compressorVersion: TEXT_COMPRESSOR_VERSION,
      text,
      anchors: [marker],
      omissions: [
        {
          objectId: input.objectId,
          locator,
          kind: "text-lines",
          tokensOmitted: ctx.estimateTokens(middle),
          items: to - from + 1,
        },
      ],
      removed: [{ kind: "text-lines", count: to - from + 1 }],
      tokensBefore,
      tokensAfter: ctx.estimateTokens(text),
    };
  },

  verify(input: CompressInput, result: CompressResult): VerifyOutcome {
    if (result.tokensAfter >= result.tokensBefore) return { ok: false, reason: "no-reduction" };
    for (const omission of result.omissions) {
      if (!/^(L\d+-L\d+|B\d+-B\d+)$/.test(omission.locator)) return { ok: false, reason: "unretrievable-omission" };
      if (omission.objectId !== input.objectId) return { ok: false, reason: "foreign-omission" };
    }
    for (const anchor of result.anchors) {
      if (!result.text.includes(anchor)) return { ok: false, reason: "missing-anchor" };
    }
    return { ok: true };
  },
};

/**
 * Byte-window view of long single-line content. Boundaries are byte offsets into the
 * ORIGINAL bytes, so the retrieval lands exactly where the marker says it does.
 */
function byteWindow(input: CompressInput, ctx: CompressContext, tokensBefore: number): CompressResult {
  const bytes = Buffer.from(input.content, "utf8");
  const from = HEAD_CHARS;
  const to = bytes.byteLength - TAIL_CHARS;
  const omittedBytes = to - from;
  const locator = `B${from}-B${to}`;
  const marker = `… ${omittedBytes} bytes withheld → retrieve ${locator} …`;
  const text = `${bytes.subarray(0, HEAD_CHARS).toString("utf8")}\n${marker}\n${bytes.subarray(bytes.byteLength - TAIL_CHARS).toString("utf8")}`;

  return {
    compressorId: TEXT_COMPRESSOR_ID,
    compressorVersion: TEXT_COMPRESSOR_VERSION,
    text,
    anchors: [marker],
    omissions: [
      {
        objectId: input.objectId,
        locator,
        kind: "text-bytes",
        tokensOmitted: ctx.estimateTokens(bytes.subarray(from, to).toString("utf8")),
        items: omittedBytes,
      },
    ],
    removed: [{ kind: "text-bytes", count: omittedBytes }],
    tokensBefore,
    tokensAfter: ctx.estimateTokens(text),
  };
}
