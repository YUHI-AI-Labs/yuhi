import type { ScanResult, FileDecision, ModelTier } from "@yuhi/shared";
import {
  buildPreparedMetrics,
  buildPreparedRuntimeBoundary,
  type PreviewData,
  type ContextSavings,
  type PrepareReport,
} from "@yuhi/core";
import type { Translator } from "./i18n.js";
import { ui, actionBadge, symbols, heading, formatBytes } from "./ui.js";
import { formatGB } from "./local-ai.js";

function tokfmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
}
function bar(fraction: number, width = 22): string {
  const filled = Math.max(1, Math.round(fraction * width));
  return "█".repeat(filled) + "·".repeat(Math.max(0, width - filled));
}

const LIST_CAP = 25;

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function listGroup(title: string, decisions: FileDecision[]): void {
  if (decisions.length === 0) return;
  console.log("\n" + ui.bold(title) + ui.dim(`  (${decisions.length})`));
  const shown = decisions.slice(0, LIST_CAP);
  for (const d of shown) {
    console.log(`  ${actionBadge(d.action).padEnd(20)} ${d.relpath}`);
  }
  if (decisions.length > shown.length) {
    console.log(ui.dim(`  … and ${num(decisions.length - shown.length)} more`));
  }
}

export function renderScan(scan: ScanResult, t: Translator): void {
  console.log(heading(t("scan.title")));
  console.log(`${symbols.ok()} ${t("scan.inspected", { count: num(scan.filesInspected) })}`);

  const secretCount = scan.findings.length;
  if (secretCount > 0) {
    console.log(`${symbols.warn()} ${t("scan.secrets", { count: num(secretCount) })}`);
  } else {
    console.log(`${symbols.ok()} ${t("scan.noSecrets")}`);
  }
  console.log(`${symbols.ok()} ${t("scan.notModified")}`);

  const r = scan.riskSummary;
  if (secretCount > 0) {
    console.log("\n" + ui.bold(t("scan.risk")));
    console.log(`  ${ui.red("Critical")}: ${r.critical}`);
    console.log(`  ${ui.yellow("High")}:     ${r.high}`);
    console.log(`  Medium:   ${r.medium}`);
    console.log(`  ${ui.dim("Low")}:      ${r.low}`);
  }

  const binary = scan.files.filter((f) => f.flags.isBinary).length;
  const large = scan.files.filter((f) => f.flags.isLarge).length;
  const links = scan.files.filter((f) => f.flags.isSymlink).length;
  if (binary + large + links > 0) {
    console.log("\n" + ui.bold(t("scan.flags")));
    if (binary) console.log(`  ${symbols.bullet()} ${num(binary)} binary`);
    if (large) console.log(`  ${symbols.bullet()} ${num(large)} large`);
    if (links) console.log(`  ${symbols.bullet()} ${num(links)} symlink (not followed)`);
  }
}

export function renderPreview(p: PreviewData, t: Translator): void {
  console.log(heading(t("preview.title")));
  console.log(`${ui.bold(t("preview.agent"))}: ${p.agent}`);
  console.log(`${ui.bold(t("preview.source"))}: ${p.sourcePath}`);
  console.log(ui.dim(`${num(p.filesInspected)} files inspected`));

  if (p.decisions.length === 0) {
    console.log("\n" + symbols.warn() + " " + t("preview.empty"));
    return;
  }

  // Same vocabulary as the GUI: Sent to Claude / Prepared locally / Runtime only / Kept.
  const g = p.byAction;
  listGroup("Sent to Claude", g.allow);
  listGroup("Prepared locally", [
    ...g["prepare-locally"],
    ...g.redact,
    ...g["summarize-local"],
    ...g["metadata-only"],
  ]);
  listGroup("Runtime only", g.inject);
  listGroup("Kept on your machine", g["local-only"]);
  listGroup("Excluded", g.block);
  if (g.ask.length > 0) listGroup("Ask (blocks unless you approve)", g.ask);

  const sent = g.allow.length;
  const prepared =
    g["prepare-locally"].length + g.redact.length + g["summarize-local"].length + g["metadata-only"].length;
  const kept = g["local-only"].length + g.inject.length + g.block.length;
  console.log("\n" + ui.bold("Summary"));
  console.log(`  ${ui.green(num(sent) + " sent to " + p.agent)}  ${ui.dim("original files, unchanged")}`);
  console.log(`  ${ui.yellow(num(prepared) + " prepared locally")}  ${ui.dim("transformed before sending")}`);
  console.log(`  ${ui.gray(num(kept) + " kept on your machine")}  ${ui.dim("never sent to the AI")}`);
  console.log(`  ${symbols.ok()} 0 source files modified`);

  if (p.summary.symlinksSkipped > 0) {
    console.log(ui.dim(`  ${symbols.bullet()} ${num(p.summary.symlinksSkipped)} symlink(s) not followed`));
  }
}

export function renderStatus(
  p: PreviewData,
  savings: ContextSavings,
  changes: number,
  hasBaseline: boolean,
  t: Translator,
): void {
  console.log(heading("AI Context"));
  console.log(ui.dim(`  agent ${p.agent} · ${num(p.filesInspected)} files inspected · repo not modified\n`));

  const sent = p.summary.visible - p.summary.transformed;
  console.log(`  ${ui.green("Sent to Claude")}        ${num(sent)}`);
  console.log(`  ${ui.yellow("Prepared locally")}      ${num(p.summary.transformed)}`);
  console.log(`  ${ui.gray("Kept on your machine")}  ${num(p.summary.blocked + p.summary.localOnly)}`);

  // Context Before / After — what a raw launch would send vs. what Yuhi sends.
  const b = savings.before;
  const a = savings.after;
  const frac = b.tokens > 0 ? a.tokens / b.tokens : 1;
  console.log("\n" + ui.bold("  Context Before → After"));
  console.log(`  ${ui.dim("without Yuhi")}  ${ui.red(bar(1))}  ${num(b.files)} files · ≈${tokfmt(b.tokens)} tok`);
  console.log(`  ${ui.dim("with Yuhi   ")}  ${ui.green(bar(frac))}  ${num(a.files)} files · ≈${tokfmt(a.tokens)} tok`);
  const bits: string[] = [];
  if (savings.tokenReductionPct > 0) bits.push(`${savings.tokenReductionPct}% smaller`);
  if (savings.secretsRemoved > 0) bits.push(`${num(savings.secretsRemoved)} secret file(s) removed`);
  if (savings.noiseKeptLocalBytes > 0) bits.push(`${formatBytes(savings.noiseKeptLocalBytes)} noise kept local`);
  if (bits.length) console.log(`  ${ui.dim("→ " + bits.join(" · ") + "  (token est.)")}`);

  console.log(
    "\n  " + (hasBaseline ? ui.dim(t("status.changesSince", { count: num(changes) })) : ui.dim(t("status.noBaseline"))),
  );
  console.log(`\n${ui.dim(t("status.runHint"))}  ${ui.bold(`yuhi run ${p.agent}`)}`);
}

export function renderDiff(
  changes: { relpath: string; kind: string; before?: string; after?: string }[],
  hasPrevious: boolean,
  t: Translator,
): void {
  console.log(heading(t("diff.title")));
  if (!hasPrevious) return void console.log(ui.dim(t("diff.noPrev")));
  if (changes.length === 0) return void console.log(`${symbols.ok()} ${t("diff.none")}`);
  const mark: Record<string, string> = {
    added: ui.green("+ "),
    removed: ui.red("- "),
    "action-changed": ui.yellow("~ "),
    "content-changed": ui.cyan("Δ "),
  };
  const label: Record<string, string> = {
    added: t("diff.added"),
    removed: t("diff.removed"),
    "action-changed": t("diff.actionChanged"),
    "content-changed": t("diff.contentChanged"),
  };
  for (const c of changes) {
    const detail =
      c.kind === "action-changed" ? ` ${ui.dim(`${c.before} → ${c.after}`)}` : c.after ? ` ${ui.dim(c.after)}` : "";
    console.log(`  ${mark[c.kind] ?? "  "}${c.relpath}  ${ui.dim(`(${label[c.kind] ?? c.kind})`)}${detail}`);
  }
}

export function renderPrepareReport(res: PrepareReport): void {
  const r = res.report;
  const metrics = buildPreparedMetrics(res);
  const pct = metrics.estimatedReductionPercent.toFixed(1);
  const label = (s: string) => s.padEnd(26);

  console.log(heading("Prepared by Yuhi"));
  // Headline outcome — the value in five seconds. Honest about increases / no data.
  if (!r.hasData) {
    console.log("  " + ui.bold("Estimated Claude input avoided: unavailable") );
    console.log(ui.dim("  (no summarizable content in this run)"));
  } else if (r.tokensSaved >= 0) {
    console.log(
      "  " + ui.bold(ui.magenta(`Estimated context reduction: ${pct}%`)),
    );
    console.log(`  ${label("Estimated tokens avoided")}${num(metrics.estimatedTokensAvoided)} tokens`);
  } else {
    console.log(
      "  " +
        ui.bold(
          ui.yellow(
            `Estimated context INCREASED: ${num(-r.tokensSaved)} tokens (${Math.abs(metrics.estimatedReductionPercent).toFixed(1)}%)`,
          ),
        ),
    );
    console.log(ui.dim("  (preparation produced more tokens than the source — summary larger than tiny input)"));
  }
  console.log(ui.dim("  ────────────────────────────────────────────"));
  console.log(`  ${label("Estimated input before")}${num(r.beforeTokens)} tokens`);
  console.log(`  ${label("Estimated input after")}${num(r.afterTokens)} tokens`);
  console.log(`  ${label("Files excluded")}${num(metrics.filesExcluded)}`);
  console.log(`  ${label("Files kept local")}${num(metrics.filesKeptLocal)}`);
  console.log(`  ${label("Files summarized")}${num(r.filesSummarized)}`);
  console.log(`  ${label("Sensitive findings detected")}${num(metrics.sensitiveFindings)}`);
  console.log(`  ${label("Files containing findings")}${num(metrics.filesWithSensitiveFindings)}`);
  console.log(`  ${label("Sensitive values masked")}${num(metrics.sensitiveValuesMasked)}`);
  console.log(`  ${label("Files containing masked values")}${num(metrics.filesWithMaskedValues)}`);
  console.log(`  ${label("Prepared copies transformed")}${num(metrics.preparedFilesModified)}`);
  console.log(`  ${label("Original files modified")}${num(r.sourceModified)}`);
  const runtime = buildPreparedRuntimeBoundary();
  console.log(`  ${label("Initial context")}prepared by Yuhi`);
  console.log(`  ${label("Runtime start")}Claude Code starts in a Yuhi Prepared Workspace.`);
  console.log(`  ${label("Workspace boundary")}${runtime.workspaceBoundary}`);
  console.log(`  ${label("Workspace instruction")}present`);
  console.log(
    `  ${label("Filesystem enforcement")}${ui.yellow(runtime.filesystemEnforcement === "none" ? "not enabled" : runtime.filesystemEnforcement)}`,
  );
  console.log(`  ${label("OS sandbox")}${ui.yellow("not enabled")}`);
  console.log(
    ui.dim("  The agent may access files outside the Prepared Workspace if the runtime or user permits it."),
  );

  if (res.blocked.length > 0)
    console.log(
      ui.yellow(`  ${symbols.warn()} ${num(res.blocked.length)} file(s) blocked by the safety check (not included).`),
    );
  if (res.errors.length > 0) {
    console.log(
      ui.yellow(`  ${symbols.warn()} ${num(res.errors.length)} file(s) could not be prepared.`),
    );
    const reason = res.errors.find((e) => e.error)?.error;
    if (reason) console.log(ui.dim(`    reason: ${reason}`));
  }

  console.log(
    "\n" + `${symbols.ok()} Prepared output: ${ui.bold(res.outDir)}   ${ui.dim("Ready for review.")}`,
  );
  console.log(
    ui.dim(
      "  Estimated tokens. Actual usage and billing depend on the selected AI product,\n  provider behavior, caching, and pricing.",
    ),
  );
}

/** Show the recommended model tiers with sizes (live from Ollama when known). */
export function renderModelTiers(
  tiers: readonly ModelTier[],
  liveSizes: Map<string, number>,
  recommendedId: string,
): void {
  console.log(ui.bold("Recommended local models"));
  for (const m of tiers) {
    const live = liveSizes.get(m.id) ?? liveSizes.get(`${m.id}:latest`);
    const size = live !== undefined ? formatGB(live) : m.approxSize;
    const mark = m.id === recommendedId ? ui.green("●") : ui.dim("○");
    const rec = m.id === recommendedId ? ui.green("  (recommended)") : "";
    console.log(`  ${mark} ${ui.bold(m.id)}  ${ui.dim(size)}${rec}`);
    console.log(`      ${ui.dim(m.label + " · " + m.blurb)}`);
  }
}

export function renderExplain(d: FileDecision, t: Translator): void {
  console.log(heading(t("explain.header", { path: d.relpath })));
  console.log(`${ui.bold(t("explain.action"))}: ${actionBadge(d.action)}`);
  console.log(`${ui.bold(t("explain.rule"))}: ${d.ruleName}`);
  console.log(`${ui.bold(t("explain.reason"))}: ${d.reason}`);
  if (d.findings.length > 0) {
    console.log(`\n${ui.bold(t("explain.findings"))}:`);
    for (const f of d.findings) {
      console.log(`  ${symbols.bullet()} ${f.detector} (${f.severity}) — ${f.description} [${f.maskedPreview}]`);
    }
  }
  console.log("\n" + ui.dim(t("explain.override")));
}
