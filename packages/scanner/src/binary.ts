/**
 * Heuristic binary detection: a NUL byte in the first chunk, or a high ratio of
 * non-text bytes. Conservative — we prefer to treat ambiguous files as binary so
 * we do not run text detectors (or redaction) on them.
 */
export function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  if (len === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const b = buf[i]!;
    if (b === 0) return true; // NUL => definitely binary
    // Control chars except tab(9), LF(10), CR(13), FF(12), ESC(27)
    if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27) suspicious++;
  }
  return suspicious / len > 0.3;
}
