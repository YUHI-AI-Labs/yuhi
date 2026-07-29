import { createHash } from "node:crypto";

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Stable short id derived from a hash (for workspace ids). */
export function shortId(seed: string): string {
  return sha256(seed).slice(0, 12);
}
