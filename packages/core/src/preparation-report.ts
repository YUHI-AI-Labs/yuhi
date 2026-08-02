/**
 * v0.3 Yuhi Preparation Report — the shareable proof-of-value artifact.
 *
 * "See how much of your repository your AI actually needs." Concrete, measurable
 * outcomes (never an opaque grade). Exportable to terminal / Markdown / JSON / SVG,
 * with a PUBLIC-SAFE guarantee: every format contains ONLY aggregate numbers — no
 * filenames, paths, secret types, PII, org names, or usernames — so it is safe to
 * paste into a README, a PR comment, or a social post.
 *
 * Note on wording: "Prepared artifacts" (not "AI-ready files"), because one source
 * document can produce several artifacts (e.g. a PDF → a sanitized Markdown companion).
 * Reporting "Source files" separately keeps the comparison honest.
 */
import { safetyModeLabel, type SafetyMode, DEFAULT_PREPARE_SAFETY_MODE } from "@yuhi/shared";
import type { AiReadinessReport } from "./ai-readiness-report.js";
import type { PublicPreparedContextSummary } from "./public-prepared-summary.js";

export interface PreparationReport {
  /** The resolved effective Safety Mode this run used (internal value). */
  safetyMode: SafetyMode;
  sourceFiles: number;
  preparedArtifacts: number;
  documentsPrepared: number;
  /** Credential/secret FILES kept fully local (never delivered) — i.e. an unresolved
   *  credential. A `.env` whose values are safely redacted is delivered, so it is NOT
   *  counted here; its redactions count under `identifiersTransformed`. */
  secretsBlocked: number;
  /** Total sensitive VALUES redacted or pseudonymized across delivered files —
   *  includes PII masks (names/emails/IDs) AND secret redactions (e.g. `.env`
   *  `${VAR}` placeholders), not PII alone. */
  identifiersTransformed: number;
  largeFilesExcluded: number;
  /** Explicitly an estimate of agent-accessible content reduction, not token savings. */
  estimatedReductionPercent: number;
  status: "ready" | "ready-with-warning";
  context?: PublicPreparedContextSummary;
}

export type ReportFormat = "terminal" | "markdown" | "json" | "svg";

/** Build the report from the readiness numbers + the total source file count. */
export function buildPreparationReport(
  readiness: AiReadinessReport,
  totalSourceFiles: number,
  opts: { warning?: boolean; safetyMode?: SafetyMode; context?: PublicPreparedContextSummary } = {},
): PreparationReport {
  return {
    safetyMode: opts.safetyMode ?? DEFAULT_PREPARE_SAFETY_MODE,
    sourceFiles: Math.max(totalSourceFiles, readiness.preparedFiles),
    preparedArtifacts: readiness.preparedFiles,
    documentsPrepared: readiness.documentsSummarized,
    secretsBlocked: readiness.secretsBlocked,
    identifiersTransformed: readiness.piiTransformed,
    largeFilesExcluded: readiness.largeFilesReduced,
    estimatedReductionPercent: readiness.estimatedReductionPercent,
    status: opts.warning ? "ready-with-warning" : "ready",
    ...(opts.context ? { context: opts.context } : {}),
  };
}

/** Thousands separator without locale surprises (Date/Intl-free environment safe). */
const group = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The rows shown in the terminal/Markdown views. Large-files row appears only when > 0. */
function rows(r: PreparationReport): [string, number][] {
  const base: [string, number][] = [
    ["Source files", r.sourceFiles],
    ["Prepared artifacts", r.preparedArtifacts],
    ["Documents prepared", r.documentsPrepared],
    ["Secrets blocked", r.secretsBlocked],
    ["Identifiers transformed", r.identifiersTransformed],
  ];
  if (r.largeFilesExcluded > 0) base.push(["Large files excluded", r.largeFilesExcluded]);
  return base;
}

const footer = (r: PreparationReport): string =>
  r.status === "ready"
    ? "Ready for Claude Code."
    : "Ready for Claude Code — some items need review.";

function terminal(r: PreparationReport): string {
  const rs = rows(r);
  const labelW = Math.max(...rs.map(([k]) => k.length));
  const valW = Math.max(...rs.map(([, v]) => group(v).length));
  const lines = ["Repository Ready", ""];
  for (const [k, v] of rs) lines.push(`  ${k.padEnd(labelW)}  ${group(v).padStart(valW)}`);
  lines.push(
    "",
    `  Estimated repository reduction: ${r.estimatedReductionPercent}%`,
    `  Safety Mode: ${safetyModeLabel(r.safetyMode)}`,
    "",
    footer(r),
  );
  if (r.context) {
    lines.push(
      "",
      "Context preparation",
      `  Original estimated tokens  ${r.context.originalEstimatedTokens === null ? "Not measured" : group(r.context.originalEstimatedTokens)}`,
      `  Prepared estimated tokens  ${r.context.preparedEstimatedTokens === null ? "Not measured" : group(r.context.preparedEstimatedTokens)}`,
      `  Tokens reduced             ${r.context.reducedTokens === null ? "Not measured" : group(r.context.reducedTokens)}`,
      `  Estimated reduction        ${r.context.reductionPercent === null ? "Not measured" : `${r.context.reductionPercent.toFixed(1)}%`}`,
      `  Token Budget               ${r.context.tokenBudget === null ? "No target" : group(r.context.tokenBudget)}`,
      `  Token Budget status        ${r.context.tokenBudgetStatus}`,
    );
  }
  return lines.join("\n");
}

function markdown(r: PreparationReport): string {
  const contextRows = r.context
    ? [
        `| Original estimated tokens | ${r.context.originalEstimatedTokens === null ? "Not measured" : group(r.context.originalEstimatedTokens)} |`,
        `| Prepared estimated tokens | ${r.context.preparedEstimatedTokens === null ? "Not measured" : group(r.context.preparedEstimatedTokens)} |`,
        `| Tokens reduced | ${r.context.reducedTokens === null ? "Not measured" : group(r.context.reducedTokens)} |`,
        `| **Estimated context reduction** | **${r.context.reductionPercent === null ? "Not measured" : `${r.context.reductionPercent.toFixed(1)}%`}** |`,
        `| Token Budget | ${r.context.tokenBudget === null ? "No target" : group(r.context.tokenBudget)} |`,
        `| Token Budget status | ${r.context.tokenBudgetStatus} |`,
      ]
    : [];
  return [
    "## Repository Ready",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    ...rows(r).map(([k, v]) => `| ${k} | ${group(v)} |`),
    `| **Estimated repository reduction** | **${r.estimatedReductionPercent}%** |`,
    `| Safety Mode | ${safetyModeLabel(r.safetyMode)} |`,
    ...contextRows,
    "",
    `Status: **${footer(r)}**`,
    "",
    "_Estimated reduction is a measure of agent-accessible content, not actual model token savings._",
  ].join("\n");
}

/** A shields-style badge SVG: "Prepared with Yuhi | 94% reduced". Fully self-contained. */
function svg(r: PreparationReport): string {
  const left = "Prepared with Yuhi";
  const right = `${r.estimatedReductionPercent}% reduced`;
  const cw = 6.5; // approx char width at 11px
  const lw = Math.round(left.length * cw) + 16;
  const rw = Math.round(right.length * cw) + 16;
  const total = lw + rw;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(left)}: ${esc(right)}">`,
    `<rect rx="3" width="${total}" height="20" fill="#555"/>`,
    `<rect rx="3" x="${lw}" width="${rw}" height="20" fill="#3fb950"/>`,
    `<rect x="${lw}" width="4" height="20" fill="#3fb950"/>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11">`,
    `<text x="${lw / 2}" y="14">${esc(left)}</text>`,
    `<text x="${lw + rw / 2}" y="14">${esc(right)}</text>`,
    `</g></svg>`,
  ].join("");
}

/**
 * Render the report. Every format is PUBLIC-SAFE: the report contains only aggregate
 * counts and a percentage — never a filename, path, secret type, or identity.
 */
export function formatPreparationReport(r: PreparationReport, format: ReportFormat): string {
  switch (format) {
    case "markdown":
      return markdown(r);
    case "json":
      return JSON.stringify(r, null, 2);
    case "svg":
      return svg(r);
    case "terminal":
    default:
      return terminal(r);
  }
}
