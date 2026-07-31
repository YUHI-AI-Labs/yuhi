/**
 * Decode file bytes to text, detecting a legacy Japanese encoding (Shift-JIS /
 * CP932) when UTF-8 decoding fails. Japanese CSV/Excel exports are frequently
 * Shift-JIS; reading them as UTF-8 turns headers like 氏名/学籍番号 into mojibake,
 * which hides identifier columns from de-identification and leaves real names
 * visible to any reader that opens the file with the correct encoding.
 *
 * Strategy: decode as UTF-8; if it produced replacement characters (U+FFFD), try
 * Shift-JIS and keep it only when it produces strictly fewer replacements. Pure
 * ASCII and valid UTF-8 always stay UTF-8.
 */
export function decodeTextBuffer(buffer: Buffer | Uint8Array): string {
  const bytes = buffer instanceof Buffer ? buffer : Buffer.from(buffer);
  const utf8 = bytes.toString("utf8");
  const utf8Replacements = countReplacements(utf8);
  if (utf8Replacements === 0) return utf8;
  try {
    const sjis = new TextDecoder("shift-jis", { fatal: false }).decode(bytes);
    if (countReplacements(sjis) < utf8Replacements) return sjis;
  } catch {
    // A runtime without Shift-JIS support (missing ICU) — fall back to UTF-8.
  }
  return utf8;
}

function countReplacements(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0xfffd) count += 1;
  }
  return count;
}
