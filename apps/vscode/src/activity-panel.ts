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
  compress: boolean;
  tokenBudget: number;
}

export type ActivityPanelData =
  | { phase: "no-workspace" }
  | { phase: "not-prepared"; settings?: PrepareSettings }
  | {
      /** The window IS the Prepared Workspace — Claude Code (extension) is working here. */
      phase: "yuhi-mode";
      filesAvailable: number;
      filesExcluded: number;
      /** Documents still being inspected in the background (progress, not a warning). */
      documentsPending?: number;
      /** Whether the Claude Code VS Code extension is installed in this window. */
      claudeExtensionAvailable?: boolean;
      /** Whether the Claude Code extension has ACTUALLY opened (verified separately). */
      claudeExtensionActive?: boolean;
      /** Impact metrics to celebrate what Yuhi protected/reduced (all optional). */
      maskedValues?: number;
      reductionPercent?: number;
      filesTransformed?: number;
      /**
       * v0.3.4 agent picker — "one prepared repository, multiple agents". When present,
       * the picker (Claude Code / Codex + Context ID) replaces the single launch button.
       */
      picker?: AgentPickerData;
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
      /** Background enrichment still running (Start allowed; badge shows activity). */
      backgroundActive?: boolean;
      /** v0.3.4 agent picker — replaces the single Start button when present. */
      picker?: AgentPickerData;
    };

/** Message the webview posts back when a button is activated. */
export type ActivityPanelMessage =
  | { type: "prepare" }
  | { type: "startClaude" }
  | { type: "details" }
  | { type: "launchAgent"; agentId: string };

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
 * Re-prepare affordance here (nothing has been prepared yet). Token Budget is enabled
 * only while Compression is on.
 */
function prepareControls(s: PrepareSettings): string {
  const options = SAFETY_MODE_CHOICES.map(
    ([value, label]) =>
      `<option value="${value}"${value === s.safetyMode ? " selected" : ""}>${esc(label)}</option>`,
  ).join("");
  const budgetValue = s.tokenBudget > 0 ? String(s.tokenBudget) : "";
  return (
    `<div class="cfg">` +
    `<div class="ctl">` +
    `<label for="cfgSafety">Safety Mode</label>` +
    `<select id="cfgSafety" class="sel">${options}</select>` +
    `</div>` +
    `<div class="ctl">` +
    `<label for="cfgCompress">Context Compression</label>` +
    `<label class="tog"><input type="checkbox" id="cfgCompress"${s.compress ? " checked" : ""}>` +
    `<span>${s.compress ? "On" : "Off"}</span></label>` +
    `</div>` +
    `<div class="ctl">` +
    `<label for="cfgBudget">Token Budget</label>` +
    `<input type="number" id="cfgBudget" class="num" min="0" step="1000" placeholder="No target"` +
    ` value="${esc(budgetValue)}"${s.compress ? "" : " disabled"}>` +
    `</div>` +
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
          prepareControls(data.settings ?? { safetyMode: "balanced", compress: false, tokenBudget: 0 }) +
          button("prepare", "Prepare with Yuhi", { primary: true }),
      };
    case "yuhi-mode": {
      const pending = data.documentsPending ?? 0;
      const checks =
        // Blue "Yuhi Mode" = this window IS the Prepared Workspace. Whether the
        // Claude Code extension has actually opened is a SEPARATE state (shown only
        // once its activation succeeds), so we do not claim it here.
        line("done", "This window is the Prepared Workspace") +
        (data.claudeExtensionActive
          ? line("done", "Claude Code extension active")
          : line("todo", "Claude Code extension: use Open Claude Code")) +
        line("done", `${data.filesAvailable} file${data.filesAvailable === 1 ? "" : "s"} available`) +
        (data.filesExcluded > 0
          ? line("warn", `${data.filesExcluded} file${data.filesExcluded === 1 ? "" : "s"} excluded by recommendation`)
          : "") +
        (pending > 0
          ? line("active", `${pending} document${pending === 1 ? "" : "s"} processing in the background`)
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
      if (data.reductionPercent !== undefined && data.reductionPercent > 0) {
        stats.push(stat(`${data.reductionPercent.toFixed(0)}%`, "context reduced"));
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
      return {
        badge: "Yuhi Mode",
        badgeClass: "mode",
        body:
          `<div class="modehdr" role="heading" aria-level="2">◆ YUHI MODE</div>` +
          checks +
          impact +
          button("details", "Review file decisions") +
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
          `<div class="prep">` +
          `<div class="prep-head"><span class="ck spin big" aria-hidden="true">◐</span>` +
          `<div class="prep-headtext"><div class="prep-title">${esc(title)}</div>` +
          `<div class="prep-step">${stepLine}</div></div>${percentText}</div>` +
          bar +
          (meta ? `<div class="prep-meta">${meta}</div>` : "") +
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
      const warnings = data.summariesRejected > 0;
      const checks =
        line("done", `${data.filesDiscovered} files discovered`) +
        line("done", `${data.documentsInspected} documents inspected`) +
        (warnings
          ? line(
              "warn",
              `${data.summariesRejected} summary${data.summariesRejected === 1 ? "" : "s"} rejected by verification`,
            )
          : "") +
        line(data.contextIndex ? "done" : "todo", "Context index created") +
        line(data.agentHandoff ? "done" : "todo", "Agent handoff ready");
      const gen = data.contextIndex
        ? `<div class="gen">Context generated → <b>.yuhi/context/</b><br>document-index.md · summaries/ · AGENT_HANDOFF.md</div>`
        : "";
      return {
        badge: data.backgroundActive
          ? "Enriching…"
          : warnings
            ? "Ready with warnings"
            : "Ready",
        badgeClass: data.backgroundActive ? "busy" : warnings ? "warn" : "ok",
        body:
          checks +
          gen +
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
    for (const id of ["prepare", "startClaude", "details"]) {
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
    const compress = document.getElementById("cfgCompress");
    if (compress) compress.addEventListener("change", () => vscode.postMessage({ type: "setCompress", value: compress.checked }));
    const budget = document.getElementById("cfgBudget");
    if (budget) budget.addEventListener("change", () => vscode.postMessage({ type: "setTokenBudget", value: Number(budget.value) || 0 }));
  </script>
</body></html>`;
}
