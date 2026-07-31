import { describe, expect, it } from "vitest";
import { decodeTextBuffer } from "./text-encoding.js";

/** Encode UTF-8 text to Shift-JIS the way a Node runtime with ICU can decode it. */
function toShiftJis(text: string): Buffer {
  // Build the bytes via the inverse of TextDecoder using a small known map is
  // overkill; use the round-trip guarantee: these Japanese chars all exist in
  // CP932. We rely on iconv-equivalent bytes captured here for determinism.
  // 学籍番号,氏名\n123456,テスト\n in Shift-JIS:
  return Buffer.from([
    0x8a, 0x77, 0x90, 0xd0, 0x94, 0xd4, 0x8d, 0x86, 0x2c, 0x8e, 0x81, 0x96,
    0xbc, 0x0a, 0x39, 0x39, 0x30, 0x31, 0x39, 0x31, 0x2c, 0x83, 0x65, 0x83,
    0x58, 0x83, 0x67, 0x0a,
  ]);
}

describe("decodeTextBuffer", () => {
  it("keeps valid UTF-8 unchanged", () => {
    const buf = Buffer.from("受診者番号,氏名\nA-1,山田\n", "utf8");
    expect(decodeTextBuffer(buf)).toBe("受診者番号,氏名\nA-1,山田\n");
  });

  it("keeps plain ASCII unchanged", () => {
    const buf = Buffer.from("id,name\n1,alice\n", "utf8");
    expect(decodeTextBuffer(buf)).toBe("id,name\n1,alice\n");
  });

  it("decodes Shift-JIS/CP932 instead of leaving mojibake", () => {
    const decoded = decodeTextBuffer(toShiftJis(""));
    // UTF-8 decoding of these bytes yields replacement characters; Shift-JIS
    // recovers the real Japanese headers so identifier columns are recognized.
    expect(decoded).toContain("学籍番号");
    expect(decoded).toContain("氏名");
    expect(decoded).toContain("テスト");
    expect(decoded).not.toContain("�");
  });
});
