/**
 * v0.3 Phase 2b-1 — the "Repository Ready" surface.
 *
 * Renders the shareable {@link PreparationReport} (aggregate numbers only) as a
 * clean card inside the existing Context Savings webview, plus the copy/export
 * helpers the extension host uses. Every value that leaves this surface — copied
 * or exported — is produced by core's `formatPreparationReport`, which is
 * PUBLIC-SAFE: it contains ONLY aggregate counts and a percentage, never a
 * filename, path, secret type, or identity.
 *
 * `renderRepositoryReadyCard` returns markup ONLY (no <script>): it is embedded
 * into the review webview, which already owns the single `acquireVsCodeApi()`
 * handle and wires the button ids below to `vscode.postMessage`.
 */
import { formatPreparationReport, type PreparationReport, type ReportFormat } from "@yuhi/core";

/** Messages the review webview posts for the Repository Ready actions. */
export type RepositoryReadyMessage =
  | { type: "copyPublicReport" }
  | { type: "exportPublicReport" };

/** The export formats offered in the quick-pick (label + core format + extension). */
export const REPOSITORY_READY_EXPORT_FORMATS: readonly {
  label: string;
  format: ReportFormat;
  extension: string;
}[] = [
  { label: "Markdown (.md)", format: "markdown", extension: "md" },
  { label: "JSON (.json)", format: "json", extension: "json" },
  { label: "SVG badge (.svg)", format: "svg", extension: "svg" },
];

/** Public-safe Markdown that "Copy public report" writes to the clipboard. */
export function repositoryReadyClipboardText(report: PreparationReport): string {
  return formatPreparationReport(report, "markdown");
}

/** Public-safe content that "Export…" writes to the chosen file. */
export function repositoryReadyExportText(
  report: PreparationReport,
  format: ReportFormat,
): string {
  return formatPreparationReport(report, format);
}

/** Thousands separator without locale surprises (mirrors core's report grouping). */
const group = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The five headline metric rows, always shown in this order. */
function headlineMetrics(r: PreparationReport): [string, number][] {
  return [
    ["Source files", r.sourceFiles],
    ["Prepared artifacts", r.preparedArtifacts],
    ["Documents prepared", r.documentsPrepared],
    ["Secrets blocked", r.secretsBlocked],
    ["Identifiers transformed", r.identifiersTransformed],
  ];
}

/**
 * The Repository Ready card markup. Pure; reuses the review webview's existing
 * classes (`.card`, `.summary-grid`, `.metric`, `.button`, …) so it needs no new
 * CSS. Values are numbers only — nothing here can leak a path, filename, or
 * identity. The button ids (`copyPublicReport` / `exportPublicReport`) are wired
 * by the host webview's script.
 */
export function renderRepositoryReadyCard(report: PreparationReport): string {
  const warning = report.status === "ready-with-warning";
  const heading = warning ? "Ready — review warnings" : "Repository Ready";
  const badge = warning ? "REVIEW WARNINGS" : "READY";
  const badgeStyle = warning ? ' style="color:var(--warn)"' : "";
  const metrics = headlineMetrics(report)
    .map(([k, v]) => `<div class="metric"><span>${k}</span><b>${group(v)}</b></div>`)
    .join("");
  const largeFiles =
    report.largeFilesExcluded > 0
      ? `<div class="metric"><span>Large files excluded</span><b>${group(report.largeFilesExcluded)}</b></div>`
      : "";
  return (
    `<section class="card" id="repositoryReady" style="margin-bottom:24px">` +
    `<div class="inside">` +
    `<div class="hero-top"><div class="eyebrow">YUHI · PUBLIC REPORT</div>` +
    `<div class="ready"${badgeStyle}>${badge}</div></div>` +
    `<h2 style="margin:6px 0 4px">${heading}</h2>` +
    `<p class="sub">A shareable summary of how much of your repository your AI actually needs. ` +
    `Aggregate numbers only — safe to paste into a README, PR, or post (no filenames, paths, or secrets).</p>` +
    `<div class="summary-grid">` +
    metrics +
    `<div class="metric reduction"><span>Estimated accessible-content reduction</span>` +
    `<b>${report.estimatedReductionPercent}%</b>` +
    `<div class="explanation">An estimate of agent-accessible content, not model token savings.</div></div>` +
    largeFiles +
    `</div>` +
    `<div class="actions" style="margin-top:16px">` +
    `<button class="button" id="copyPublicReport">Copy public report</button>` +
    `<button class="button" id="exportPublicReport">Export…</button></div>` +
    `<p class="note">Copy and Export emit the public-safe report only — aggregate numbers, ` +
    `never source paths, filenames, or content.</p>` +
    `</div></section>`
  );
}
