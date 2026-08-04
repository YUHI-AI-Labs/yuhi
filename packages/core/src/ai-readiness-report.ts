/**
 * v0.3 AI Readiness Report — the primary, adoption-facing surface.
 *
 * "Turn any repository into an AI-ready repository." A plain-language summary of what
 * Yuhi did, in OUTCOMES rather than policy terminology:
 *
 *   Repository Ready
 *   Secrets blocked          18
 *   Documents summarized     42
 *   PII transformed         103
 *   Large files reduced      15
 *   Prepared files          317
 *   Estimated reduction      94%
 *
 * Pure projection of the prepared file list — the VS Code view / CLI render it.
 */

/** The manifest facts this report reads (a subset of a prepared file entry). */
export interface ReadinessFile {
  omitted?: boolean;
  outcome?: string;
  failureCategory?: string;
  limitation?: string;
  maskedValues?: number;
  /** TRUE when the untransformed original was delivered as a verification fallback.
   *  `limitation: "transformation-unavailable"` alone is ambiguous — it covers BOTH
   *  "too large to inspect" and "transform could not be verified" — and conflating
   *  them reported a raw fallback as a "large file excluded" (#12/#13). */
  rawFallback?: boolean;
  beforeChars?: number;
  afterChars?: number;
  document?: { deliveredArtifactType?: string; redactionCount?: number };
}

export interface AiReadinessReport {
  secretsBlocked: number;
  documentsSummarized: number;
  piiTransformed: number;
  largeFilesReduced: number;
  preparedFiles: number;
  /** Conservative estimate of agent-accessible content reduction — NOT token savings. */
  estimatedReductionPercent: number;
  /** True when the workspace is ready to open (no hard failure). */
  ready: boolean;
}

function isSanitizedCompanion(t?: string): boolean {
  return t === "sanitized-pdf-companion" || t === "sanitized-docx-companion" || t === "sanitized-pptx-companion";
}

/**
 * Build the AI Readiness Report from the prepared file entries. Counts are honest and
 * derived from the delivered state, and the reduction figure is explicitly an estimate.
 */
export function buildAiReadinessReport(files: readonly ReadinessFile[]): AiReadinessReport {
  let secretsBlocked = 0;
  let documentsSummarized = 0;
  let piiTransformed = 0;
  let largeFilesReduced = 0;
  let preparedFiles = 0;
  let beforeTotal = 0;
  let afterTotal = 0;

  for (const f of files) {
    beforeTotal += Math.max(0, f.beforeChars ?? 0);
    // A credential/private key kept out of the workspace (omitted for that reason).
    if (f.failureCategory === "unresolved-secret") {
      secretsBlocked += 1;
      continue; // not delivered → contributes nothing to afterTotal
    }
    if (f.omitted) continue; // excluded/kept-local → not agent-accessible
    preparedFiles += 1;
    afterTotal += Math.max(0, f.afterChars ?? 0);

    if (isSanitizedCompanion(f.document?.deliveredArtifactType)) {
      documentsSummarized += 1;
      piiTransformed += Math.max(0, f.document?.redactionCount ?? 0);
    } else if (f.document?.deliveredArtifactType === "safe-placeholder") {
      // A large/uninspectable document delivered as a placeholder = reduced.
      largeFilesReduced += 1;
    } else {
      piiTransformed += Math.max(0, f.maskedValues ?? 0);
      // Only a genuine size/inspection passthrough is a reduced large artifact. A
      // verification fallback (`rawFallback`) is neither large nor excluded and is
      // reported through `DeliveryIntegritySummary` instead.
      if (
        f.rawFallback !== true &&
        f.limitation === "transformation-unavailable" &&
        f.outcome === "included-unverified"
      ) {
        largeFilesReduced += 1;
      }
    }
  }

  // NO clamp. Pseudonymization can make the prepared context LARGER than the source
  // (ASCII tokens replacing short multi-byte values), and `Math.max(0, ...)` turned a
  // real -23.1% into a headline "0%" while the very same run printed -23.1% twelve
  // lines further down. CLAUDE.md fixes the formula as
  // (before - after) / before * 100 and permits 0.0% only when `before` is zero.
  const estimatedReductionPercent =
    beforeTotal > 0 ? Math.round((1 - afterTotal / beforeTotal) * 1000) / 10 : 0;

  return {
    secretsBlocked,
    documentsSummarized,
    piiTransformed,
    largeFilesReduced,
    preparedFiles,
    estimatedReductionPercent,
    ready: true,
  };
}

export interface AiReadinessScore {
  /** 0–100 overall readiness (a heuristic indicator, not a guarantee). */
  score: number;
  categories: { name: string; stars: number; detail: string }[];
}

const clampStars = (n: number): number => Math.max(0, Math.min(5, Math.round(n)));

/**
 * Compute the shareable AI Readiness Score (0–100) + per-category star ratings from
 * the readiness report and a structure signal. Deterministic and honest: it rewards
 * "prepared" outcomes (secrets handled, documents converted, context reduced, clear
 * structure). It is a readiness INDICATOR, never a safety guarantee.
 */
export function buildAiReadinessScore(
  report: AiReadinessReport,
  structure?: { categories: number; topModules: number },
): AiReadinessScore {
  // Secrets: Yuhi always keeps credentials local, so this is high by construction;
  // finding + blocking some is the ideal "handled" signal.
  const secretStars = 5;
  // Documents: share of documents converted to companions vs left as placeholders.
  const totalDocs = report.documentsSummarized + report.largeFilesReduced;
  const docStars =
    totalDocs === 0 ? 5 : clampStars(1 + (report.documentsSummarized / totalDocs) * 4);
  // Structure: clear, recognizable layout scores higher.
  const structStars = structure
    ? clampStars(1 + Math.min(4, structure.categories - 1) * 0.8 + Math.min(1, structure.topModules / 4))
    : 4;
  // Context reduction: more reduction → higher, capped honestly.
  const r = report.estimatedReductionPercent;
  const ctxStars = r >= 90 ? 5 : r >= 70 ? 4 : r >= 50 ? 3 : r >= 25 ? 2 : r > 0 ? 1 : 3;

  const categories = [
    { name: "Secrets blocked", stars: secretStars, detail: `${report.secretsBlocked} blocked` },
    { name: "Documents prepared", stars: docStars, detail: `${report.documentsSummarized} prepared` },
    { name: "Repository structure", stars: structStars, detail: `${report.preparedFiles} files` },
    { name: "Context reduction", stars: ctxStars, detail: `${report.estimatedReductionPercent}%` },
  ];
  const score = Math.round((categories.reduce((n, c) => n + c.stars, 0) / (categories.length * 5)) * 100);
  return { score, categories };
}

const starBar = (n: number): string => "★".repeat(clampStars(n)) + "☆".repeat(5 - clampStars(n));

/** Shareable badge text, e.g. "AI Ready 92/100". */
export function aiReadinessBadge(score: AiReadinessScore): string {
  return `AI Ready ${score.score}/100`;
}

export function formatAiReadinessScore(score: AiReadinessScore): string {
  const lines = [`Repository Ready    ${score.score} / 100`, ""];
  const w = Math.max(...score.categories.map((c) => c.name.length));
  for (const c of score.categories) {
    lines.push(`  ${c.name.padEnd(w)}  ${starBar(c.stars)}  ${c.detail}`);
  }
  return lines.join("\n");
}

/** Render the report as the plain-language block shown after `yuhi prepare`. */
export function formatAiReadinessReport(r: AiReadinessReport): string {
  const pad = (n: number) => String(n).padStart(4);
  return [
    "Repository Ready",
    "",
    `  Secrets blocked      ${pad(r.secretsBlocked)}`,
    `  Documents summarized ${pad(r.documentsSummarized)}`,
    `  PII transformed      ${pad(r.piiTransformed)}`,
    `  Large files reduced  ${pad(r.largeFilesReduced)}`,
    "",
    `  Prepared files       ${pad(r.preparedFiles)}`,
    `  Estimated reduction  ${String(r.estimatedReductionPercent).padStart(3)}%`,
    "",
    "Ready for Claude Code.",
  ].join("\n");
}
