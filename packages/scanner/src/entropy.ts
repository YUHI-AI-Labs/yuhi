/** Shannon entropy (bits per char) of a string. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Mask a secret so it is safe to display: keep a short prefix, asterisks after. */
export function maskSecret(value: string): string {
  const keep = Math.min(4, Math.max(0, value.length - 2));
  const stars = "*".repeat(Math.min(16, Math.max(4, value.length - keep)));
  const prefix = value.slice(0, keep);
  const suffix = value.length > 40 ? ` (len ${value.length})` : "";
  return `${prefix}${stars}${suffix}`;
}
