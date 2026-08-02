/**
 * Yuhi Preparation activity panel (WebviewView) — the `.vsc-panel` mock from the
 * OSS site, driven by REAL preparation state (never static mock numbers).
 *
 * Invariants enforced here (per product review):
 *  - A green check is rendered ONLY from completed/persisted state, never from
 *    intent or scheduling.
 *  - A rejected summary is a WARNING, never "Ready".
 *  - The panel restores after reload from persisted state (see the provider).
 *  - Theme variables only (no hard-coded light-theme colors); visible focus states.
 *
 * `renderActivityPanel` is pure and unit-tested; the provider wires it to VS Code.
 */

import { renderAgentPicker, type AgentPickerData } from "./agent-picker.js";
import {
  renderProgressiveContext,
  type ProgressiveContextViewModel,
} from "./progressive-context.js";
import type { YuhiModeSummary } from "@yuhi/core";

/** Lifecycle of the background document job, shown verbatim while it runs. */
export type BackgroundLifecycle = "queued" | "inspecting" | "summarizing" | "verifying";

/** The three real @yuhi/core Safety Mode presets (mirrors the `yuhi.safetyMode` enum). */
export type SafetyModeValue = "balanced" | "strict" | "maximum-privacy";

/**
 * The prepare-time settings shown BEFORE the first prepare. These are the current
 * values of the `yuhi.safetyMode` / `yuhi.compress` / `yuhi.tokenBudget` settings —
 * editing a control persists the SAME setting the prepare path already reads, so the
 * first Prepare uses the chosen values with no separate plumbing. `tokenBudget` is 0
 * for "no target".
 */
export interface PrepareSettings {
  safetyMode: SafetyModeValue;
  compressionMode: "off" | "auto" | "on";
  tokenBudget: number;
  permissionMode: "standard" | "plan" | "acceptEdits" | "auto" | "custom";
  sandboxPreset: "standard" | "guarded" | "locked-down";
}

export type ActivityPanelData =
  | { phase: "no-workspace" }
  | { phase: "not-prepared"; settings?: PrepareSettings }
  | {
      /** The window IS the Prepared Workspace — Claude Code (extension) is working here. */
      phase: "yuhi-mode";
      filesAvailable: number;
      filesExcluded: number;
      verifiedFiles?: number;
      warningFiles?: number;
      processingFailedFiles?: number;
      /** Documents still being inspected in the background (progress, not a warning). */
      documentsPending?: number;
      /** Whether the Claude Code VS Code extension is installed in this window. */
      claudeExtensionAvailable?: boolean;
      /** Whether the Claude Code extension has ACTUALLY opened (verified separately). */
      claudeExtensionActive?: boolean;
      /** Impact metrics to celebrate what Yuhi protected/reduced (all optional). */
      maskedValues?: number;
      reductionPercent?: number;
      estimatedTokensBefore?: number;
      estimatedTokensAfter?: number;
      compression?: {
        tokenBudget: number | null;
        preparedTokens: number;
        status: "within-budget" | "best-effort" | "no-budget";
      };
      filesTransformed?: number;
      /**
       * v0.3.4 agent picker — "one prepared repository, multiple agents". When present,
       * the picker (Claude Code / Codex + Context ID) replaces the single launch button.
       */
      picker?: AgentPickerData;
      /**
       * v0.3.5 Progressive Context — the honest background-processing surface, derived
       * ONLY from the public status file. Present once there is background work.
       */
      progressive?: ProgressiveContextViewModel;
      agentChangesDetected?: boolean;
      yuhiModeSummary?: YuhiModeSummary;
    }
  | {
      phase: "preparing";
      /** True while the initial BLOCKING preparation runs (Start must stay disabled). */
      blocking: boolean;
      /** Known once discovery completes. */
      filesDiscovered?: number;
      /** Background lifecycle stage (only meaningful once blocking is done). */
      lifecycle?: BackgroundLifecycle;
      current?: number;
      total?: number;
      /** A safe label (relpath) of the document currently being processed. */
      currentDoc?: string;
      /** Overall completion 0–100 for the progress bar (indeterminate when absent). */
      percent?: number;
      /** 0-based index of the current preparation phase, and the phase count. */
      stepIndex?: number;
      stepTotal?: number;
      /** Human label of the current phase (e.g. "Preparing safe copies"). */
      phaseLabel?: string;
      /** Elapsed seconds, shown so the user sees continuous activity. */
      elapsedSeconds?: number;
      compressionEnabled?: boolean;
      tokenBudget?: number;
    }
  | {
      phase: "ready";
      filesDiscovered: number;
      /** Documents whose inspection actually COMPLETED. */
      documentsInspected: number;
      /** Summaries rejected by verification (a warning, not a success). */
      summariesRejected: number;
      /** Physical existence of .yuhi/context/document-index.md. */
      contextIndex: boolean;
      /** Physical existence of .yuhi/context/AGENT_HANDOFF.md. */
      agentHandoff: boolean;
      verifiedFiles?: number;
      warningFiles?: number;
      backgroundPendingFiles?: number;
      processingFailedFiles?: number;
      reductionPercent?: number;
      estimatedTokensBefore?: number;
      estimatedTokensAfter?: number;
      compression?: {
        tokenBudget: number | null;
        preparedTokens: number;
        status: "within-budget" | "best-effort" | "no-budget";
      };
      /** Background enrichment still running (Start allowed; badge shows activity). */
      backgroundActive?: boolean;
      /** Impact metrics (sensitive values kept out of prepared copies, local transforms). */
      maskedValues?: number;
      filesTransformed?: number;
      /** v0.3.4 agent picker — replaces the single Start button when present. */
      picker?: AgentPickerData;
      /** v0.3.5 Progressive Context — honest background-processing surface. */
      progressive?: ProgressiveContextViewModel;
      agentChangesDetected?: boolean;
      yuhiModeSummary?: YuhiModeSummary;
    };

/** Message the webview posts back when a button is activated. */
export type ActivityPanelMessage =
  | { type: "prepare" }
  | { type: "startClaude" }
  | { type: "details" }
  | { type: "launchAgent"; agentId: string }
  | { type: "cancelBackground" }
  | { type: "refreshContext" };

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** A status line. `state`: done (✓) / warn (⚠) / active (spinner) / todo (·). */
function line(state: "done" | "warn" | "active" | "todo", text: string): string {
  const mark =
    state === "done"
      ? '<span class="ck ok" aria-hidden="true">✓</span>'
      : state === "warn"
        ? '<span class="ck warn" aria-hidden="true">⚠</span>'
        : state === "active"
          ? '<span class="ck spin" aria-hidden="true">◐</span>'
          : '<span class="ck todo" aria-hidden="true">·</span>';
  return `<div class="st ${state}">${mark}<span>${esc(text)}</span></div>`;
}

function button(id: string, label: string, opts: { primary?: boolean; disabled?: boolean } = {}): string {
  const cls = opts.primary ? "btn primary" : "btn";
  const dis = opts.disabled ? " disabled aria-disabled=\"true\"" : "";
  return `<button type="button" id="${id}" class="${cls}"${dis}>${esc(label)}</button>`;
}

function renderBudgetCard(
  budget: { tokenBudget: number | null; preparedTokens: number; status: "within-budget" | "best-effort" | "no-budget" } | undefined,
  fallbackPreparedTokens = 0,
): string {
  const status = !budget || budget.tokenBudget === null
    ? "No target"
    : budget.status === "within-budget"
      ? "Target achieved"
      : `Best effort — ${Math.max(0, budget.preparedTokens - budget.tokenBudget).toLocaleString()} over target`;
  return (
    `<div class="budgetCard"><div><span>Token Budget</span><b>${budget?.tokenBudget === null || !budget ? "No target" : budget.tokenBudget.toLocaleString()}</b></div>` +
    `<div><span>Prepared Tokens</span><b>${(budget?.preparedTokens ?? fallbackPreparedTokens).toLocaleString()}</b></div>` +
    `<div class="budgetStatus"><span>Status</span><b>${esc(status)}</b></div></div>`
  );
}

/**
 * Availability + background counts resolved from the single {@link YuhiModeSummary}
 * source when it is present. Every surface that shows these numbers reads THIS, so no
 * panel line recomputes independently. Falls back to the legacy per-field values only
 * when no summary has been attached yet (e.g. a state persisted before it was built).
 */
interface ResolvedCounts {
  verified: number;
  warning: number;
  compact: number;
  companions: number;
  blocked: number;
  failed: number;
  /** Background pending + processing (documents still being inspected locally). */
  pending: number;
  /** Total files the agent can use (verified + warning + compact + companions). */
  available: number;
}

function summaryCounts(s: YuhiModeSummary): ResolvedCounts {
  const a = s.contextAvailability;
  return {
    verified: a.availableVerified,
    warning: a.availableWithWarning,
    compact: a.compactRepresentations,
    companions: a.companionsAdded,
    blocked: a.knownRisksBlocked,
    failed: a.unavailableAfterFailure,
    pending: s.background.pending + s.background.processing,
    available: a.availableVerified + a.availableWithWarning + a.compactRepresentations + a.companionsAdded,
  };
}

/**
 * Format a real reduction percentage honestly: never round a genuine, tiny reduction
 * up or down to a misleading value. `82` → `82%`, `41.3` → `41.3%`, `0.36` → `0.36%`,
 * and a positive value that would round to zero renders `<0.01%` (never a fake `0%`).
 */
function fmtReductionPercent(p: number): string {
  if (p > 0 && p < 0.005) return "<0.01%";
  const rounded = Math.round(p * 100) / 100;
  const text = rounded.toFixed(2).replace(/\.?0+$/, "");
  return `${text}%`;
}

/**
 * The headline **Repository Optimization** dashboard — the product's value story in
 * five numbers. Driven ONLY by the single {@link YuhiModeSummary} (availability +
 * background + compression); no number is recomputed anywhere else. Honest by
 * construction: a null reduction renders "Not measured" (never a fake 0), a real
 * reduction is shown even when tiny, and the reduction is labelled EXACTLY "Estimated
 * context reduction" — never billing/API/cost savings. Internal reason codes
 * (kept-local / provider-unavailable / OCR-deferred) are intentionally kept OUT here.
 *
 * When `summary` is absent the SAME frame renders with placeholder slots so the user
 * sees what Yuhi is about to do BEFORE Prepare; the slots flip to real numbers after.
 */
function renderRepositoryOptimization(summary: YuhiModeSummary | undefined): string {
  const stat = (value: string, label: string, cls = ""): string =>
    `<div class="stat${cls ? ` ${cls}` : ""}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  if (!summary) {
    // Pre-Prepare frame: show the five slots Yuhi is about to fill.
    return (
      `<div class="optim" role="group" aria-label="Repository optimization">` +
      `<div class="optim-h">Repository Optimization</div>` +
      `<div class="optim-hero"><span>Estimated context reduction</span><b>Estimated</b>` +
      `<small>Prepare to measure this repository</small></div>` +
      `<div class="optim-grid">` +
      stat("—", "available immediately") +
      stat("Waiting…", "processing in background") +
      stat("—", "blocked (known risk)") +
      stat("—", "compact representations") +
      `</div>` +
      `<div class="optim-note">Only structure is compressed — implementation details are removed while APIs are preserved. ` +
      `Originals are preserved (never modified). The agent can still read the full original on demand.</div>` +
      `</div>`
    );
  }
  const e = summary.contextEfficiency;
  const c = summaryCounts(summary);
  const availableImmediately = c.verified + c.warning;
  const heroValue =
    e.representationReductionPercent === null
      ? "Not measured"
      : `✓ ${fmtReductionPercent(e.representationReductionPercent)}`;
  const beforeAfter =
    e.repositoryTokensBefore === null || e.repositoryTokensAfter === null
      ? `<small>Not measured</small>`
      : `<small>${e.repositoryTokensBefore.toLocaleString()} → ${e.repositoryTokensAfter.toLocaleString()} estimated tokens</small>`;
  return (
    `<div class="optim" role="group" aria-label="Repository optimization">` +
    `<div class="optim-h">Repository Optimization</div>` +
    `<div class="optim-hero"><span>Estimated context reduction</span><b>${esc(heroValue)}</b>${beforeAfter}</div>` +
    `<div class="optim-grid">` +
    stat(availableImmediately.toLocaleString(), "available immediately") +
    stat(c.pending.toLocaleString(), "processing in background") +
    stat(c.blocked.toLocaleString(), "blocked (known risk)") +
    stat(c.compact.toLocaleString(), "compact representations") +
    `</div>` +
    `<div class="optim-note">Only structure is compressed — implementation details are removed while APIs are preserved. ` +
    `Originals are preserved (never modified). The agent can still read the full original on demand.</div>` +
    `</div>`
  );
}

/**
 * The value-forward "Yuhi Mode Ready" header shown at the TOP of the Ready / Yuhi-Mode
 * surface. Four concrete lines derived ONLY from the summary; a line is omitted when its
 * count is 0, and a not-measured reduction reads "calculating…" rather than a fake number.
 */
function renderValueForwardReady(summary: YuhiModeSummary | undefined): string {
  if (!summary) return "";
  const e = summary.contextEfficiency;
  const c = summaryCounts(summary);
  const availableImmediately = c.verified + c.warning;
  const rows: string[] = [];
  if (availableImmediately > 0) {
    rows.push(line("done", `${availableImmediately.toLocaleString()} files immediately available`));
  }
  if (c.pending > 0) {
    rows.push(line("active", `${c.pending.toLocaleString()} documents processing`));
  }
  if (c.compact > 0) {
    rows.push(line("done", `${c.compact.toLocaleString()} compact representations`));
  }
  rows.push(
    e.representationReductionPercent === null
      ? line("active", "Repository reduction: calculating…")
      : line("done", `${fmtReductionPercent(e.representationReductionPercent)} repository reduction`),
  );
  const readyLine =
    summary.launchStatus === "blocked"
      ? ""
      : `<div class="vfready-go"><b>Ready.</b> ${esc(summary.agentCapabilities.selectedAgent || "Claude")} can start now.</div>`;
  return `<div class="vfready"><div class="vfready-h">Repository Optimization</div>${rows.join("")}${readyLine}</div>`;
}

function renderYuhiModeSummary(summary: YuhiModeSummary | undefined): string {
  if (!summary) return "";
  const a = summary.contextAvailability;
  const e = summary.contextEfficiency;
  const b = summary.background;
  const value = (n: number | null): string => n === null ? "Not measured" : n.toLocaleString();
  return `<div class="impact"><div class="impact-h">YUHI MODE — ${summary.launchStatus === "ready" ? "READY" : summary.launchStatus === "ready-with-warnings" ? "READY WITH WARNINGS" : "BLOCKED"}</div>` +
    `<div class="gen"><b>Agent capability</b><br>Agent: ${esc(summary.agentCapabilities.selectedAgent)}<br>Auto mode: ${summary.agentCapabilities.autoModeAvailable ? "Available" : "Unavailable for selected preset"}<br>Prepared Workspace: Active<br>Source changes: Review required</div>` +
    `<div class="gen"><b>What the agent can use</b><br>Verified files: ${a.availableVerified.toLocaleString()}<br>Available with warnings: ${a.availableWithWarning.toLocaleString()}<br>Compact representations: ${a.compactRepresentations.toLocaleString()}<br>Verified companions added: ${a.companionsAdded.toLocaleString()}<br>Known-risk files blocked: ${a.knownRisksBlocked.toLocaleString()}<br>Unavailable after failure: ${a.unavailableAfterFailure.toLocaleString()}</div>` +
    `<div class="gen"><b>Context efficiency</b><br>Repository representation: ${value(e.repositoryTokensBefore)} → ${value(e.repositoryTokensAfter)} estimated tokens<br>${e.representationReductionPercent === null ? "Reduction not measured" : `${fmtReductionPercent(e.representationReductionPercent)} smaller`}<br>Initial agent context: ${value(e.initialAgentContextTokens)} estimated tokens<br>Large artifacts represented compactly: ${e.largeArtifactsRepresented.toLocaleString()}</div>` +
    `<div class="gen"><b>Background result</b><br>Status: ${esc(b.status)}<br>Processed companions: ${b.completed.toLocaleString()}<br>Still available with warnings: ${b.companionUnavailable.toLocaleString()}<br>Pending: ${(b.pending + b.processing).toLocaleString()}<br>Original documents remain usable when shared with warnings.</div>` +
    `<div class="hint">Yuhi preserved the agent's capabilities, made useful repository context available with explicit confidence labels, reduced unnecessary representation, and kept source changes behind review.</div></div>`;
}

/** Human labels for the three Safety Mode presets (values mirror `yuhi.safetyMode`). */
const SAFETY_MODE_CHOICES: ReadonlyArray<readonly [SafetyModeValue, string]> = [
  ["balanced", "Balanced"],
  ["strict", "Strict"],
  ["maximum-privacy", "Maximum Privacy"],
];

/**
 * The pre-Prepare controls shown in the `not-prepared` state so Safety Mode /
 * Compression / Token Budget can be chosen BEFORE the first prepare. Each control
 * persists the same `yuhi.*` setting the prepare path reads; there is no dirty /
 * Re-prepare affordance here (nothing has been prepared yet). Token Budget is always
 * editable; entering a positive target automatically enables Compression.
 */
function prepareControls(s: PrepareSettings): string {
  const options = SAFETY_MODE_CHOICES.map(
    ([value, label]) =>
      `<option value="${value}"${value === s.safetyMode ? " selected" : ""}>${esc(label)}</option>`,
  ).join("");
  const budgetValue = s.tokenBudget > 0 ? String(s.tokenBudget) : "";
  const compressionOptions = ["auto", "on", "off"].map((value) =>
    `<option value="${value}"${value === s.compressionMode ? " selected" : ""}>${value === "off" ? "Off" : value === "auto" ? "Auto (Recommended)" : "On"}</option>`,
  ).join("");
  const permissionOptions = [["standard", "Standard"], ["plan", "Plan"], ["acceptEdits", "Accept Edits"], ["auto", "Auto"], ["custom", "Custom"]].map(
    ([value, label]) => `<option value="${value}"${value === s.permissionMode ? " selected" : ""}>${label}</option>`,
  ).join("");
  const sandboxOptions = [["standard", "Standard"], ["guarded", "Guarded (recommended)"], ["locked-down", "Locked Down"]].map(
    ([value, label]) => `<option value="${value}"${value === s.sandboxPreset ? " selected" : ""}>${label}</option>`,
  ).join("");
  return (
    `<div class="cfg">` +
    `<div class="ctl">` +
    `<label for="cfgSafety">Safety Mode</label>` +
    `<select id="cfgSafety" class="sel">${options}</select>` +
    `</div>` +
    `<div class="ctl">` +
    `<label for="cfgCompressionMode">Context Compression</label>` +
    `<select id="cfgCompressionMode" class="sel">${compressionOptions}</select>` +
    `</div>` +
    `<div class="ctl">` +
    `<label for="cfgBudget">Target Context Size (Token Budget)</label>` +
    `<input type="number" id="cfgBudget" class="num" min="1" max="1000000000" step="1000" placeholder="No target"` +
    ` value="${esc(budgetValue)}" aria-describedby="cfgBudgetHint cfgBudgetError"${s.compressionMode === "off" ? " disabled" : ""}>` +
    `<span id="cfgBudgetHint" class="hint">${s.compressionMode === "off" ? "Enable Context Compression to set a token budget." : "Positive whole number · blank means No limit"}</span>` +
    `<span id="cfgBudgetError" class="inputError" role="alert"></span>` +
    `</div><div class="ctl"><label for="cfgPermissionMode">Permission Mode</label><select id="cfgPermissionMode" class="sel">${permissionOptions}</select></div>` +
    `<div class="ctl"><label for="cfgSandboxPreset">Sandbox</label><select id="cfgSandboxPreset" class="sel">${sandboxOptions}</select></div>` +
    `<div class="gen"><b>Prepare with Yuhi</b><br>✓ Fast Yuhi Mode start<br>✓ Security scan and local protection<br>✓ Context compression with FULL fallback</div>` +
    `</div>`
  );
}

/** Render the panel body for a given state. Pure — no VS Code, no DOM globals. */
function renderBody(data: ActivityPanelData): { badge: string; badgeClass: string; body: string } {
  switch (data.phase) {
    case "no-workspace":
      return {
        badge: "—",
        badgeClass: "idle",
        body:
          `<p class="empty">Open a folder to prepare local context for Claude Code.</p>`,
      };
    case "not-prepared":
      return {
        badge: "Not prepared",
        badgeClass: "idle",
        body:
          `<p class="empty">Prepare this workspace to generate local context.</p>` +
          renderRepositoryOptimization(undefined) +
          prepareControls(data.settings ?? { safetyMode: "balanced", compressionMode: "auto", tokenBudget: 0, permissionMode: "standard", sandboxPreset: "guarded" }) +
          button("prepare", "Prepare with Yuhi", { primary: true }),
      };
    case "yuhi-mode": {
      // Single source: when the YuhiModeSummary is attached, every availability + background
      // count below reads from it (no independent recompute). Legacy per-field values are a
      // fallback only for a state persisted before the summary existed.
      const c = data.yuhiModeSummary ? summaryCounts(data.yuhiModeSummary) : undefined;
      const filesAvailable = c ? c.available : data.filesAvailable;
      const filesExcluded = c ? c.blocked : data.filesExcluded;
      const verifiedFiles = c ? c.verified : data.verifiedFiles;
      const warningFiles = c ? c.warning : data.warningFiles;
      const processingFailed = c ? c.failed : (data.processingFailedFiles ?? 0);
      const pending = c ? c.pending : (data.documentsPending ?? 0);
      const reduction = data.reductionPercent;
      // When the single-source summary is present the Repository Optimization dashboard
      // carries the reduction hero — don't render a second, lower-precision one.
      const reductionHero = data.yuhiModeSummary
        ? ""
        : `<div class="reductionHero"><span>Estimated context reduction</span>` +
          `<b>${reduction === undefined ? "Not measured" : `${reduction.toFixed(1)}%`}</b>` +
          (data.estimatedTokensBefore !== undefined && data.estimatedTokensAfter !== undefined
            ? `<small>${data.estimatedTokensBefore.toLocaleString()} → ${data.estimatedTokensAfter.toLocaleString()} estimated tokens</small>`
            : "") +
          `</div>`;
      const budgetCard = renderBudgetCard(data.compression, data.estimatedTokensAfter ?? 0);
      const checks =
        // Blue "Yuhi Mode" = this window IS the Prepared Workspace. Whether the
        // Claude Code extension has actually opened is a SEPARATE state (shown only
        // once its activation succeeds), so we do not claim it here.
        line("done", "This window is the Prepared Workspace") +
        (data.claudeExtensionActive
          ? line("done", "Claude Code extension active")
          : line("todo", "Claude Code extension: use Open Claude Code")) +
        line("done", "Agent Auto Mode available inside the verified sandbox") +
        line("done", `${filesAvailable} file${filesAvailable === 1 ? "" : "s"} available`) +
        (verifiedFiles !== undefined
          ? line("done", `${verifiedFiles} verified`)
          : "") +
        ((warningFiles ?? 0) > 0
          ? line("warn", `${warningFiles} available with warning`)
          : "") +
        (filesExcluded > 0
          ? line("warn", `${filesExcluded} file${filesExcluded === 1 ? "" : "s"} kept on this computer`)
          : "") +
        (pending > 0
          ? line("active", `${pending} document${pending === 1 ? "" : "s"} processing in the background`)
          : "") +
        (processingFailed > 0
          ? line("warn", `${processingFailed} background processing failed`)
          : "");
      const openBtn =
        data.claudeExtensionAvailable === false
          ? button("startClaude", "Install Claude Code")
          : button("startClaude", "Open Claude Code", { primary: true });
      // Celebrate the impact: masked values, context reduction, transforms.
      const stat = (value: string, label: string): string =>
        `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
      const stats: string[] = [];
      if (data.maskedValues !== undefined && data.maskedValues > 0) {
        stats.push(stat(data.maskedValues.toLocaleString(), "sensitive values masked"));
      }
      if (data.filesTransformed !== undefined && data.filesTransformed > 0) {
        stats.push(
          stat(String(data.filesTransformed), `file${data.filesTransformed === 1 ? "" : "s"} transformed`),
        );
      }
      const impact = stats.length
        ? `<div class="impact"><div class="impact-h">Yuhi protected your data</div><div class="impact-grid">${stats.join("")}</div></div>`
        : "";
      // v0.3.4 — when the agent picker is present it REPLACES the single launch button:
      // the same prepared repository is reusable across agents (Claude Code / Codex).
      const launch = data.picker ? renderAgentPicker(data.picker) : openBtn;
      // v0.3.5 — the honest Progressive Context surface (public-status only).
      const progressive = data.progressive ? renderProgressiveContext(data.progressive) : "";
      const changes = data.agentChangesDetected
        ? `<div class="gen"><b>AI changes detected</b><br>Review first. Nothing is applied automatically.</div>` +
          button("reviewChanges", "Review changes", { primary: true })
        : "";
      return {
        badge: "Yuhi Mode",
        badgeClass: "mode",
        body:
          `<div class="modehdr" role="heading" aria-level="2">◆ YUHI MODE</div>` +
          renderValueForwardReady(data.yuhiModeSummary) +
          renderRepositoryOptimization(data.yuhiModeSummary) +
          renderYuhiModeSummary(data.yuhiModeSummary) +
          reductionHero +
          budgetCard +
          checks +
          impact +
          progressive +
          changes +
          button("details", "Review files") +
          launch,
      };
    }
    case "preparing": {
      // Background (non-blocking) enrichment has its own lifecycle labels.
      const backgroundLabel =
        data.lifecycle === "inspecting"
          ? "Inspecting documents"
          : data.lifecycle === "summarizing"
            ? "Summarizing locally"
            : data.lifecycle === "verifying"
              ? "Verifying summaries"
              : undefined;
      const title = data.blocking
        ? "Preparing your workspace…"
        : backgroundLabel
          ? `${backgroundLabel}…`
          : "Finishing up…";
      // Step / phase line.
      const stepLine =
        data.stepIndex !== undefined && data.stepTotal
          ? `Step ${data.stepIndex + 1} of ${data.stepTotal}${data.phaseLabel ? ` · ${esc(data.phaseLabel)}` : ""}`
          : data.phaseLabel
            ? esc(data.phaseLabel)
            : "Working locally on your machine";
      // Counts + elapsed give a continuous "it's moving" signal.
      const counts =
        data.current !== undefined && data.total !== undefined && data.total > 0
          ? `${data.current.toLocaleString()} of ${data.total.toLocaleString()} files`
          : data.filesDiscovered !== undefined
            ? `${data.filesDiscovered.toLocaleString()} files`
            : "";
      const elapsed = data.elapsedSeconds !== undefined ? `${data.elapsedSeconds}s` : "";
      const meta = [counts, elapsed].filter(Boolean).join(" · ");
      const contextMeta = data.compressionEnabled
        ? `Context Compression: On · Token Budget: ${data.tokenBudget && data.tokenBudget > 0 ? data.tokenBudget.toLocaleString() : "No target"} · Estimated reduction: calculating…`
        : "Context Compression: Off · Token reduction: Not measured";
      // Determinate bar when we have a percent; otherwise an indeterminate shimmer.
      const pct = data.percent !== undefined ? Math.max(2, Math.min(100, Math.round(data.percent))) : undefined;
      const bar =
        pct !== undefined
          ? `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>`
          : `<div class="bar indeterminate"><div class="bar-fill"></div></div>`;
      const percentText = pct !== undefined ? `<div class="pct">${pct}%</div>` : "";
      return {
        badge: data.blocking ? "Preparing" : "Enriching",
        badgeClass: "busy",
        body:
          renderRepositoryOptimization(undefined) +
          `<div class="prep">` +
          `<div class="prep-head"><span class="ck spin big" aria-hidden="true">◐</span>` +
          `<div class="prep-headtext"><div class="prep-title">${esc(title)}</div>` +
          `<div class="prep-step">${stepLine}</div></div>${percentText}</div>` +
          bar +
          (meta ? `<div class="prep-meta">${meta}</div>` : "") +
          `<div class="prep-meta">${esc(contextMeta)}</div>` +
          (data.currentDoc ? `<div class="sub">${esc(data.currentDoc)}</div>` : "") +
          `<div class="prep-note">Nothing has been sent to Claude Code yet.</div>` +
          `</div>` +
          // Start is disabled while the initial blocking preparation runs; during
          // background enrichment the user can already launch.
          button("startClaude", data.blocking ? "Preparing…" : "Start Claude Code", {
            primary: true,
            disabled: !!data.blocking,
          }),
      };
    }
    case "ready": {
      // Single source: prefer the summary's availability + background counts when present.
      const rc = data.yuhiModeSummary ? summaryCounts(data.yuhiModeSummary) : undefined;
      const readyVerified = rc ? rc.verified : data.verifiedFiles;
      const readyWarning = rc ? rc.warning : (data.warningFiles ?? 0);
      const readyPending = rc ? rc.pending : (data.backgroundPendingFiles ?? 0);
      const readyFailed = rc ? rc.failed : (data.processingFailedFiles ?? 0);
      // When the single-source summary is present the Repository Optimization dashboard
      // carries the reduction hero — don't render a second, lower-precision one.
      const reductionHero = data.yuhiModeSummary
        ? ""
        : `<div class="reductionHero"><span>Estimated context reduction</span>` +
          `<b>${data.reductionPercent === undefined ? "Not measured" : `${data.reductionPercent.toFixed(1)}%`}</b>` +
          (data.estimatedTokensBefore !== undefined && data.estimatedTokensAfter !== undefined
            ? `<small>${data.estimatedTokensBefore.toLocaleString()} → ${data.estimatedTokensAfter.toLocaleString()} estimated tokens</small>`
            : `<small>Context Compression: Off</small>`) +
          `</div>`;
      const budgetCard = renderBudgetCard(data.compression, data.estimatedTokensAfter ?? 0);
      const warnings = data.summariesRejected > 0;
      const checks =
        line("done", `${data.filesDiscovered} files discovered`) +
        (readyVerified !== undefined ? line("done", `${readyVerified} verified`) : "") +
        ((readyWarning ?? 0) > 0
          ? line("warn", `${readyWarning} available with warning`)
          : "") +
        (readyPending > 0
          ? line("active", `${readyPending} processing in the background`)
          : "") +
        (readyFailed > 0
          ? line("warn", `${readyFailed} processing failed`)
          : "") +
        line("done", `${data.documentsInspected} documents inspected`) +
        (warnings
          ? line(
              "warn",
              `${data.summariesRejected} summary${data.summariesRejected === 1 ? "" : "s"} rejected by verification`,
            )
          : "") +
        line(data.contextIndex ? "done" : "todo", "Context index created") +
        line(data.agentHandoff ? "done" : "todo", "Agent handoff ready");
      const preparationImpact =
        `<div class="impact"><div class="impact-h">What Yuhi prepared</div><div class="impact-grid">` +
        `<div class="stat"><b>${(data.maskedValues ?? 0).toLocaleString()}</b><span>sensitive values kept out of prepared copies</span></div>` +
        `<div class="stat"><b>${(data.filesTransformed ?? 0).toLocaleString()}</b><span>files transformed locally</span></div>` +
        `</div></div>`;
      const gen = data.contextIndex
        ? data.documentsInspected > 0
          ? `<div class="gen">Context generated → <b>.yuhi/context/</b><br>document-index.md · verified companions · AGENT_HANDOFF.md</div>`
          : `<div class="gen"><b>Initial context index ready.</b><br>No verified document companion has been created yet. Background enrichment starts after Yuhi Mode opens.</div>`
        : "";
      // v0.3.5 — the honest Progressive Context surface, shown on the Ready surface too.
      const progressive = data.progressive ? renderProgressiveContext(data.progressive) : "";
      const changes = data.agentChangesDetected
        ? `<div class="gen"><b>AI changes detected</b><br>Review first. Nothing is applied automatically.</div>` +
          button("reviewChanges", "Review changes", { primary: true })
        : "";
      return {
        badge: data.backgroundActive
          ? "Enriching…"
          : warnings
            ? "Ready with warnings"
            : "Ready",
        badgeClass: data.backgroundActive ? "busy" : warnings ? "warn" : "ok",
        body:
          renderValueForwardReady(data.yuhiModeSummary) +
          renderRepositoryOptimization(data.yuhiModeSummary) +
          renderYuhiModeSummary(data.yuhiModeSummary) +
          reductionHero +
          budgetCard +
          checks +
          preparationImpact +
          gen +
          progressive +
          changes +
          button("details", "Open details") +
          (data.picker
            ? renderAgentPicker(data.picker)
            : button("startClaude", "Start Claude Code", { primary: true })),
      };
    }
  }
}

/**
 * Full self-contained HTML for the WebviewView. CSP-locked to a nonce; theme
 * variables only. `cspSource` is `webview.cspSource`.
 */
export function renderActivityPanel(
  data: ActivityPanelData,
  cspSource: string,
  nonce: string,
  version?: string,
): string {
  const { badge, badgeClass, body } = renderBody(data);
  const versionLine = version ? `<div class="ver">Yuhi v${esc(version)}</div>` : "";
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 10px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: transparent;
  }
  .panel {
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,.35)));
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    padding: 12px;
  }
  .ph { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 10px; }
  .ph .brand { letter-spacing: .02em; }
  .badge {
    margin-left: auto; font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
    border: 1px solid currentColor; border-radius: 999px; padding: 1px 8px; opacity: .9;
  }
  .badge.ok   { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #57a15a)); }
  .badge.warn { color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, #cc9b00)); }
  .badge.busy { color: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); }
  .badge.mode { color: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); }
  .badge.idle { color: var(--vscode-descriptionForeground); }
  .modehdr {
    font-size: 16px; font-weight: 800; letter-spacing: .08em; margin: 0 0 12px;
    color: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
  }
  .impact {
    margin: 12px 0 4px; padding: 11px 12px; border-radius: 8px;
    border: 1px solid var(--vscode-charts-blue, var(--vscode-textLink-foreground));
    background: var(--vscode-editorWidget-background, rgba(74,160,255,.06));
  }
  .impact-h {
    font-size: 11px; text-transform: uppercase; letter-spacing: .06em; font-weight: 700;
    color: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); margin-bottom: 8px;
  }
  .impact-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
  .stat { display: flex; flex-direction: column; gap: 1px; }
  .stat b {
    font-size: 18px; font-weight: 800; font-variant-numeric: tabular-nums;
    color: var(--vscode-foreground); line-height: 1.1;
  }
  .stat span { font-size: 10.5px; color: var(--vscode-descriptionForeground); }
  .st { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12.5px; }
  .st .ck { width: 1em; text-align: center; flex: none; }
  .st .ck.ok   { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #57a15a)); font-weight: 700; }
  .st .ck.warn { color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, #cc9b00)); font-weight: 700; }
  .st .ck.todo { color: var(--vscode-descriptionForeground); }
  .st.todo span:last-child { color: var(--vscode-descriptionForeground); }
  .sub { margin: 0 0 2px 22px; font-size: 11px; color: var(--vscode-descriptionForeground);
         white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .empty { color: var(--vscode-descriptionForeground); font-size: 12.5px; margin: 2px 0 12px; }
  .gen {
    margin: 10px 0; font-size: 11px; color: var(--vscode-descriptionForeground);
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.08));
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
    border-radius: 6px; padding: 7px 9px; line-height: 1.5;
  }
  .gen b { color: var(--vscode-textLink-foreground); }
  .btn {
    display: block; width: 100%; margin-top: 8px; padding: 6px 10px;
    font-family: inherit; font-size: 12.5px; text-align: center; cursor: pointer;
    border-radius: 4px;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: 1px solid var(--vscode-button-border, transparent);
  }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn.primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  .btn.primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  @media (prefers-reduced-motion: no-preference) { .spin { animation: spin 1.2s linear infinite; display: inline-block; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* Prominent preparation progress — the "it's actively working" surface. */
  .prep { margin: 2px 0 4px; }
  .prep-head { display: flex; align-items: center; gap: 10px; }
  .prep .spin.big { font-size: 18px; color: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); }
  .prep-headtext { min-width: 0; flex: 1; }
  .prep-title { font-size: 14.5px; font-weight: 650; }
  .prep-step { font-size: 11.5px; color: var(--vscode-descriptionForeground);
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
  .pct { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums;
         color: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); flex: none; }
  .bar { position: relative; height: 8px; margin: 11px 0 7px; border-radius: 999px; overflow: hidden;
         background: var(--vscode-progressBar-background, rgba(128,128,128,.25)); opacity: .55; }
  .bar-fill { height: 100%; border-radius: 999px;
              background: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
              transition: width .35s ease; }
  .bar.indeterminate { opacity: .9; }
  .bar.indeterminate .bar-fill { width: 40%; }
  @media (prefers-reduced-motion: no-preference) {
    .bar.indeterminate .bar-fill { animation: slide 1.25s ease-in-out infinite; }
  }
  @media (prefers-reduced-motion: reduce) { .bar.indeterminate .bar-fill { width: 100%; } }
  @keyframes slide { 0% { margin-left: -42%; } 100% { margin-left: 100%; } }
  .prep-meta { font-size: 12px; color: var(--vscode-foreground); font-variant-numeric: tabular-nums; }
  .prep-note { margin-top: 7px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .reductionHero { margin: 10px 0 14px; padding: 14px; border: 1px solid var(--vscode-focusBorder);
    border-radius: 8px; display: grid; gap: 3px; background: var(--vscode-editorWidget-background); }
  .reductionHero span { font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
    color: var(--vscode-descriptionForeground); font-weight: 700; }
  .reductionHero b { font-size: 30px; line-height: 1.1; font-variant-numeric: tabular-nums;
    color: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); }
  .reductionHero small { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  /* Repository Optimization dashboard — the five-number value story. */
  .optim {
    margin: 12px 0; padding: 12px; border-radius: 8px;
    border: 1px solid var(--vscode-charts-blue, var(--vscode-textLink-foreground));
    background: var(--vscode-editorWidget-background, rgba(74,160,255,.06));
  }
  .optim-h {
    font-size: 11px; text-transform: uppercase; letter-spacing: .06em; font-weight: 700;
    color: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); margin-bottom: 10px;
  }
  .optim-hero { display: grid; gap: 3px; margin-bottom: 12px; }
  .optim-hero span {
    font-size: 11px; text-transform: uppercase; letter-spacing: .05em; font-weight: 700;
    color: var(--vscode-descriptionForeground);
  }
  .optim-hero b {
    font-size: 30px; line-height: 1.1; font-variant-numeric: tabular-nums;
    color: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
  }
  .optim-hero small { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .optim-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
  .optim-note {
    margin-top: 11px; font-size: 10.5px; line-height: 1.5;
    color: var(--vscode-descriptionForeground);
  }
  /* Value-forward "Yuhi Mode Ready" header — concrete outcomes at the top. */
  .vfready {
    margin: 4px 0 12px; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--vscode-testing-iconPassed, var(--vscode-charts-green, #57a15a));
    background: var(--vscode-editorWidget-background, rgba(87,161,90,.06));
  }
  .vfready-h {
    font-size: 13px; font-weight: 700; letter-spacing: .02em; margin-bottom: 6px;
    color: var(--vscode-foreground);
  }
  .vfready-go {
    margin-top: 8px; padding-top: 8px; font-size: 12.5px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
    color: var(--vscode-descriptionForeground);
  }
  .vfready-go b { color: var(--vscode-foreground); }
  .budgetCard { margin: 0 0 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .budgetCard > div { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; display: grid; gap: 2px; }
  .budgetCard .budgetStatus { grid-column: 1 / -1; }
  .budgetCard span { font-size: 10.5px; color: var(--vscode-descriptionForeground); }
  .budgetCard b { font-size: 13px; font-variant-numeric: tabular-nums; }
  /* Pre-Prepare settings (Safety Mode / Compression / Token Budget). */
  .cfg { display: flex; flex-direction: column; gap: 10px; margin: 4px 0 12px; }
  .ctl { display: flex; flex-direction: column; gap: 4px; }
  .ctl > label:first-child {
    font-size: 11px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600;
    color: var(--vscode-descriptionForeground);
  }
  .sel, .num {
    width: 100%; padding: 4px 6px; font-family: inherit; font-size: 12.5px;
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    background: var(--vscode-input-background, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,.35)));
    border-radius: 4px;
  }
  .num:disabled { opacity: .5; }
  .hint { font-size: 10.5px; color: var(--vscode-descriptionForeground); }
  .inputError { min-height: 1.2em; font-size: 10.5px; color: var(--vscode-errorForeground); }
  .sel:focus-visible, .num:focus-visible, .tog input:focus-visible {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px;
  }
  .tog { display: flex; align-items: center; gap: 8px; font-size: 12.5px; cursor: pointer; }
  .tog input { accent-color: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); }
  /* v0.3.4 agent picker — "Prepared once. Reusable across agents." */
  .agentPicker { margin-top: 12px; }
  .agentPickerHead {
    font-size: 11px; text-transform: uppercase; letter-spacing: .06em; font-weight: 700;
    color: var(--vscode-descriptionForeground); margin-bottom: 8px;
  }
  .agentBtns { display: flex; flex-wrap: wrap; gap: 8px; }
  .agentChoice { flex: 1 1 120px; min-width: 120px; }
  .agentBtn {
    display: block; width: 100%; padding: 6px 10px;
    font-family: inherit; font-size: 12.5px; text-align: center; cursor: pointer;
    border-radius: 4px;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: 1px solid var(--vscode-button-border, transparent);
  }
  .agentBtn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .agentBtn.primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  .agentBtn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .agentBtn:disabled { opacity: .5; cursor: default; }
  .agentBtn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .agentHint {
    margin-top: 4px; font-size: 10.5px; line-height: 1.4;
    color: var(--vscode-descriptionForeground);
  }
  .agentDirty {
    margin-top: 10px; padding: 8px 10px; border-radius: 6px;
    border: 1px solid var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, #cc9b00));
    background: var(--vscode-inputValidation-warningBackground, rgba(204,155,0,.08));
    display: flex; flex-direction: column; gap: 3px;
  }
  .agentDirty b { color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, #cc9b00)); }
  .agentDirty span { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .agentCtx { margin-top: 12px; display: flex; align-items: baseline; gap: 8px; }
  .agentCtxLabel {
    font-size: 10px; text-transform: uppercase; letter-spacing: .06em; font-weight: 700;
    color: var(--vscode-descriptionForeground);
  }
  .agentCtxId {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
    color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis;
  }
  .agentTagline {
    margin-top: 6px; font-size: 11px; font-style: italic;
    color: var(--vscode-descriptionForeground);
  }
  /* v0.3.5 Progressive Context card — honest background-processing surface. */
  .pcard {
    margin: 12px 0 4px; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,.35)));
    background: var(--vscode-editorWidget-background, rgba(128,128,128,.06));
  }
  .pc-h {
    font-size: 11px; text-transform: uppercase; letter-spacing: .06em; font-weight: 700;
    color: var(--vscode-descriptionForeground); margin-bottom: 8px;
  }
  .ver {
    margin-top: 8px; text-align: right; font-size: 10px; letter-spacing: .04em;
    color: var(--vscode-descriptionForeground); opacity: .8;
  }
</style>
</head>
<body>
  <div class="panel" role="region" aria-label="Yuhi preparation status">
    <div class="ph"><span class="brand">YUHI · Preparation</span><span class="badge ${badgeClass}">${esc(badge)}</span></div>
    ${body}
    ${versionLine}
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    // v0.3.5 adds the background Cancel / Refresh Context buttons; each posts its id.
    for (const id of ["prepare", "startClaude", "details", "cancelBackground", "refreshContext", "reviewChanges"]) {
      const el = document.getElementById(id);
      if (el && !el.disabled) el.addEventListener("click", () => vscode.postMessage({ type: id }));
    }
    // v0.3.4 agent picker — each enabled agent button launches into the SAME prepared run.
    document.querySelectorAll(".agentBtn").forEach((el) => {
      if (el.disabled) return;
      el.addEventListener("click", () =>
        vscode.postMessage({ type: "launchAgent", agentId: el.getAttribute("data-agent") }));
    });
    // Pre-Prepare settings — persist the same yuhi.* config the prepare path reads.
    const safety = document.getElementById("cfgSafety");
    if (safety) safety.addEventListener("change", () => vscode.postMessage({ type: "setSafetyMode", value: safety.value }));
    const compress = document.getElementById("cfgCompressionMode");
    const budget = document.getElementById("cfgBudget");
    const budgetHint = document.getElementById("cfgBudgetHint");
    const budgetError = document.getElementById("cfgBudgetError");
    if (compress) compress.addEventListener("change", () => {
      if (budget) budget.disabled = compress.value === "off";
      if (budgetHint) budgetHint.textContent = compress.value === "off"
        ? "Enable Context Compression to set a token budget."
        : "Positive whole number · blank means No limit";
      if (budgetError) budgetError.textContent = "";
      vscode.postMessage({ type: "setCompressionMode", value: compress.value });
    });
    const permission = document.getElementById("cfgPermissionMode");
    if (permission) permission.addEventListener("change", () => vscode.postMessage({ type: "setPermissionMode", value: permission.value }));
    const sandbox = document.getElementById("cfgSandboxPreset");
    if (sandbox) sandbox.addEventListener("change", () => vscode.postMessage({ type: "setSandboxPreset", value: sandbox.value }));
    if (budget) {
      let budgetTimer;
      budget.addEventListener("input", () => {
        if (budgetError) budgetError.textContent = "";
        clearTimeout(budgetTimer);
        budgetTimer = setTimeout(() => {
          const raw = budget.value.trim();
          if (raw === "") {
            vscode.postMessage({ type: "setTokenBudget", value: null });
            return;
          }
          const value = Number(raw);
          if (!Number.isInteger(value) || value <= 0) {
            if (budgetError) budgetError.textContent = "Enter a positive whole number, or leave blank for No target.";
            return;
          }
          if (value > 1000000000) {
            if (budgetError) budgetError.textContent = "Token Budget must be 1,000,000,000 or less.";
            return;
          }
          vscode.postMessage({ type: "setTokenBudget", value });
        }, 250);
      });
    }
  </script>
</body></html>`;
}
