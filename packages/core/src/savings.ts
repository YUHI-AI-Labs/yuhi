import { isVisibleToExternalAgent } from "@yuhi/shared";
import type { Plan } from "./plan.js";

export interface ContextSizeFigure {
  files: number;
  bytes: number;
  tokens: number;
}

/**
 * Context "Before / After" — the value story surfaced by `yuhi status`.
 *
 * "Before" = what a raw agent launch at the repo root would start from (every
 * inspected, non-symlink file). "After" = the Yuhi-generated context the agent
 * actually receives (files visible to it). Tokens are a rough estimate
 * (~4 bytes/token) — clearly an estimate, never presented as exact.
 */
export interface ContextSavings {
  before: ContextSizeFigure;
  after: ContextSizeFigure;
  /** Files containing detected secrets that were blocked or masked. */
  secretsRemoved: number;
  /** Bytes kept on the machine via `local-only` (noise/private not sent). */
  noiseKeptLocalBytes: number;
  /** Token reduction as a percentage (0–100). */
  tokenReductionPct: number;
}

const toTokens = (bytes: number): number => Math.round(bytes / 4);

export function contextSavings(plan: Plan): ContextSavings {
  const sizeByPath = new Map(plan.scan.files.map((f) => [f.relpath, f]));

  let beforeBytes = 0;
  let beforeFiles = 0;
  for (const f of plan.scan.files) {
    if (f.flags.isSymlink) continue;
    beforeBytes += f.size;
    beforeFiles += 1;
  }

  let afterBytes = 0;
  let afterFiles = 0;
  let secretsRemoved = 0;
  let noiseKeptLocalBytes = 0;
  for (const d of plan.evaluation.decisions) {
    const size = sizeByPath.get(d.relpath)?.size ?? 0;
    if (isVisibleToExternalAgent(d.action)) {
      afterBytes += size;
      afterFiles += 1;
    }
    if (d.action === "local-only") noiseKeptLocalBytes += size;
    if (
      d.findings.length > 0 &&
      (d.action === "block" || d.action === "redact" || d.action === "prepare-locally")
    ) {
      secretsRemoved += 1;
    }
  }

  const tokenReductionPct =
    beforeBytes > 0 ? Math.max(0, Math.round((1 - afterBytes / beforeBytes) * 100)) : 0;

  return {
    before: { files: beforeFiles, bytes: beforeBytes, tokens: toTokens(beforeBytes) },
    after: { files: afterFiles, bytes: afterBytes, tokens: toTokens(afterBytes) },
    secretsRemoved,
    noiseKeptLocalBytes,
    tokenReductionPct,
  };
}
