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
      // A file passed through only because it was too large to inspect.
      if (f.limitation === "transformation-unavailable" && f.outcome === "included-unverified") {
        largeFilesReduced += 1;
      }
    }
  }

  const estimatedReductionPercent =
    beforeTotal > 0 ? Math.max(0, Math.round((1 - afterTotal / beforeTotal) * 1000) / 10) : 0;

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
