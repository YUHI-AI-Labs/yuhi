import * as vscode from "vscode";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PreparedMetrics, PublicPreparedContextSummary } from "@yuhi/core";
import {
  renderActivityPanel,
  type ActivityPanelData,
  type BackgroundLifecycle,
  type PrepareSettings,
  type SafetyModeValue,
} from "./activity-panel.js";
import type { AgentPickerData } from "./agent-picker.js";
import type { ProgressiveContextViewModel } from "./progressive-context.js";

export const YUHI_ACTIVITY_VIEW_ID = "yuhi.workspace";
const STATE_KEY = "yuhi.activityPanel.v1";

/** Extra real-run detail the panel needs beyond PreparedMetrics. */
export interface PreparedDetail {
  outDir: string;
  documentsInspected: number;
  summariesRejected: number;
  backgroundActive?: boolean;
  compression?: {
    tokenBudget: number | null;
    preparedTokens: number;
    status: "within-budget" | "best-effort" | "no-budget";
  };
  publicSummary?: PublicPreparedContextSummary;
}

/**
 * The Yuhi Preparation activity panel. Renders {@link renderActivityPanel} and
 * persists its state to a Memento so it survives a window reload (the webview is
 * disposed/recreated on reload; in-memory events would otherwise be lost).
 */
export class YuhiActivityProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private data: ActivityPanelData;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly memento: vscode.Memento,
    private readonly version: string,
    private readonly onReveal?: () => void,
  ) {
    this.data = memento.get<ActivityPanelData>(STATE_KEY) ?? { phase: "not-prepared" };
    // Reflect Settings edits (yuhi.safetyMode / compress / tokenBudget) into the
    // pre-Prepare controls so the panel and VS Code Settings stay in sync.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          this.data.phase === "not-prepared" &&
          (e.affectsConfiguration("yuhi.safetyMode") ||
            e.affectsConfiguration("yuhi.compress") ||
            e.affectsConfiguration("yuhi.tokenBudget"))
        ) {
          this.setNotPrepared();
        }
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.onReveal?.();
    });
    view.webview.onDidReceiveMessage((message: { type?: string }) => this.onMessage(message));
    this.render(); // restore persisted state after reload
  }

  private onMessage(message: { type?: string; value?: unknown; agentId?: unknown }): void {
    switch (message?.type) {
      case "prepare":
        void vscode.commands.executeCommand("yuhi.prepareAndStartClaude");
        break;
      case "startClaude":
        void vscode.commands.executeCommand(
          this.data.phase === "ready" || this.data.phase === "yuhi-mode"
            ? "yuhi.openClaudeHere"
            : "yuhi.prepareAndStartClaude",
        );
        break;
      // v0.3.4 agent picker — launch the chosen agent into the SAME prepared run. The
      // extension host resolves the allowlisted adapter; an unknown id can't be launched.
      case "launchAgent":
        if (typeof message.agentId === "string") {
          void vscode.commands.executeCommand("yuhi.launchAgent", message.agentId);
        }
        break;
      case "details":
        void vscode.commands.executeCommand("yuhi.reviewPrepared");
        break;
      // v0.3.5 Progressive Context — the host command drives the controller (cancel the
      // background run / recompute + record the Context Revision). Never re-prepares.
      case "cancelBackground":
        void vscode.commands.executeCommand("yuhi.cancelBackground");
        break;
      case "refreshContext":
        void vscode.commands.executeCommand("yuhi.refreshContext");
        break;
      case "reviewChanges":
        void vscode.commands.executeCommand("yuhi.reviewAgentChanges");
        break;
      // Pre-Prepare settings. Persist the SAME yuhi.* config the prepare path reads
      // (no separate plumbing), then re-render so the panel reflects the new value.
      case "setSafetyMode": {
        const v = message.value;
        if (v === "balanced" || v === "strict" || v === "maximum-privacy") {
          void this.updateConfig("safetyMode", v);
        }
        break;
      }
      case "setCompress":
        void this.updateConfig("compress", message.value === true);
        break;
      case "setTokenBudget": {
        if (message.value === null || message.value === "") {
          void this.updateTokenBudget(0);
          break;
        }
        const n = typeof message.value === "number" ? message.value : Number(message.value);
        if (!Number.isInteger(n) || n <= 0 || n > 1_000_000_000) {
          void vscode.window.showWarningMessage(
            "Yuhi: Token Budget must be a positive whole number up to 1,000,000,000, or left blank for No target.",
          );
          break;
        }
        void this.updateTokenBudget(n);
        break;
      }
    }
  }

  private async updateConfig(key: string, value: unknown): Promise<void> {
    await vscode.workspace
      .getConfiguration("yuhi")
      .update(key, value, vscode.ConfigurationTarget.Workspace);
    // The onDidChangeConfiguration listener re-renders; call directly too so the
    // panel updates even when the effective value did not change target scope.
    if (this.data.phase === "not-prepared") this.setNotPrepared();
  }

  private async updateTokenBudget(value: number): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("yuhi");
    await cfg.update("tokenBudget", value, vscode.ConfigurationTarget.Workspace);
    if (this.data.phase === "not-prepared") this.setNotPrepared();
  }

  private set(data: ActivityPanelData): void {
    this.data = data;
    void this.memento.update(STATE_KEY, data);
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    this.view.webview.html = renderActivityPanel(
      this.data,
      this.view.webview.cspSource,
      nonce(),
      this.version,
    );
  }

  // ---- public state transitions (called from extension.ts) ----

  setNoWorkspace(): void {
    this.set({ phase: "no-workspace" });
  }

  setNotPrepared(): void {
    this.set({ phase: "not-prepared", settings: readPrepareSettings() });
  }

  /** Initial BLOCKING preparation is running; Start Claude Code stays disabled. */
  setPreparing(
    blocking: boolean,
    detail: {
      filesDiscovered?: number;
      percent?: number;
      stepIndex?: number;
      stepTotal?: number;
      phaseLabel?: string;
      current?: number;
      total?: number;
      currentDoc?: string;
      elapsedSeconds?: number;
    } = {},
  ): void {
    this.set({
      phase: "preparing",
      blocking,
      ...(blocking
        ? {
            compressionEnabled: readPrepareSettings().compress,
            tokenBudget: readPrepareSettings().tokenBudget,
          }
        : {}),
      ...(detail.filesDiscovered !== undefined ? { filesDiscovered: detail.filesDiscovered } : {}),
      ...(detail.percent !== undefined ? { percent: detail.percent } : {}),
      ...(detail.stepIndex !== undefined ? { stepIndex: detail.stepIndex } : {}),
      ...(detail.stepTotal !== undefined ? { stepTotal: detail.stepTotal } : {}),
      ...(detail.phaseLabel !== undefined ? { phaseLabel: detail.phaseLabel } : {}),
      ...(detail.current !== undefined ? { current: detail.current } : {}),
      ...(detail.total !== undefined ? { total: detail.total } : {}),
      ...(detail.currentDoc !== undefined ? { currentDoc: detail.currentDoc } : {}),
      ...(detail.elapsedSeconds !== undefined ? { elapsedSeconds: detail.elapsedSeconds } : {}),
    });
  }

  /** Background document job lifecycle (non-blocking; Start is allowed). */
  setBackgroundLifecycle(
    lifecycle: BackgroundLifecycle,
    current?: number,
    total?: number,
    currentDoc?: string,
  ): void {
    const filesDiscovered =
      this.data.phase === "preparing" || this.data.phase === "ready"
        ? this.data.filesDiscovered
        : undefined;
    // Background inspection has no per-file sub-progress, so a determinate bar would
    // freeze at a single value for the whole (up to 60s) inspection and read as
    // stuck. Omit `percent` → the panel renders an indeterminate shimmer that sweeps
    // continuously (pure CSS, no events needed), which honestly conveys "working"
    // while the "N of M files · filename" text carries the concrete state.
    this.set({
      phase: "preparing",
      blocking: false,
      ...(filesDiscovered !== undefined ? { filesDiscovered } : {}),
      lifecycle,
      ...(current !== undefined ? { current } : {}),
      ...(total !== undefined ? { total } : {}),
      ...(currentDoc ? { currentDoc } : {}),
    });
  }

  /**
   * Preparation reached a launch-able state. Checks are derived from REAL data:
   * document-index.md / AGENT_HANDOFF.md are checked for physical existence, and a
   * rejected summary renders a warning (never "Ready").
   */
  setPrepared(
    metrics: PreparedMetrics,
    _runLabel?: string,
    _sandboxed = true,
    detail?: PreparedDetail,
  ): void {
    const contextIndex = detail
      ? existsSync(path.join(detail.outDir, ".yuhi", "context", "document-index.md"))
      : false;
    const agentHandoff = detail
      ? existsSync(path.join(detail.outDir, ".yuhi", "context", "AGENT_HANDOFF.md"))
      : false;
    this.set({
      phase: "ready",
      filesDiscovered: metrics.filesInspected,
      documentsInspected: detail?.documentsInspected ?? 0,
      summariesRejected: detail?.summariesRejected ?? 0,
      contextIndex,
      agentHandoff,
      ...(detail?.publicSummary?.reductionPercent !== null && detail?.publicSummary?.reductionPercent !== undefined
        ? { reductionPercent: detail.publicSummary.reductionPercent }
        : {}),
      ...(detail?.publicSummary?.originalEstimatedTokens !== null && detail?.publicSummary?.originalEstimatedTokens !== undefined
        ? { estimatedTokensBefore: detail.publicSummary.originalEstimatedTokens }
        : {}),
      ...(detail?.publicSummary?.preparedEstimatedTokens !== null && detail?.publicSummary?.preparedEstimatedTokens !== undefined
        ? { estimatedTokensAfter: detail.publicSummary.preparedEstimatedTokens }
        : {}),
      ...(detail?.compression ? { compression: detail.compression } : {}),
      ...(detail?.backgroundActive ? { backgroundActive: true } : {}),
    });
  }

  /** This window IS the Prepared Workspace — show the blue "Yuhi Mode" panel. */
  setYuhiMode(detail: {
    filesAvailable: number;
    filesExcluded: number;
    documentsPending?: number;
    claudeExtensionAvailable?: boolean;
    claudeExtensionActive?: boolean;
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
    /** v0.3.4 agent picker reconstructed from the on-disk manifest (Context ID). */
    picker?: AgentPickerData;
  }): void {
    this.set({
      phase: "yuhi-mode",
      filesAvailable: detail.filesAvailable,
      filesExcluded: detail.filesExcluded,
      ...(detail.documentsPending !== undefined ? { documentsPending: detail.documentsPending } : {}),
      ...(detail.claudeExtensionAvailable !== undefined
        ? { claudeExtensionAvailable: detail.claudeExtensionAvailable }
        : {}),
      ...(detail.claudeExtensionActive !== undefined
        ? { claudeExtensionActive: detail.claudeExtensionActive }
        : {}),
      ...(detail.maskedValues !== undefined ? { maskedValues: detail.maskedValues } : {}),
      ...(detail.reductionPercent !== undefined ? { reductionPercent: detail.reductionPercent } : {}),
      ...(detail.estimatedTokensBefore !== undefined
        ? { estimatedTokensBefore: detail.estimatedTokensBefore }
        : {}),
      ...(detail.estimatedTokensAfter !== undefined
        ? { estimatedTokensAfter: detail.estimatedTokensAfter }
        : {}),
      ...(detail.compression ? { compression: detail.compression } : {}),
      ...(detail.filesTransformed !== undefined ? { filesTransformed: detail.filesTransformed } : {}),
      ...(detail.picker ? { picker: detail.picker } : {}),
    });
  }

  /**
   * v0.3.4 — attach (or clear) the agent picker on the current Ready / Yuhi-Mode
   * surface. Availability is resolved asynchronously by the host (short timeout), so
   * this merges into whatever Ready/Yuhi-Mode data is already shown without disturbing
   * any other phase. A no-op when the panel is not on a launchable surface.
   */
  applyAgentPicker(picker: AgentPickerData | undefined): void {
    if (this.data.phase !== "ready" && this.data.phase !== "yuhi-mode") return;
    const next = { ...this.data };
    if (picker) next.picker = picker;
    else delete next.picker;
    this.set(next);
  }

  /**
   * v0.3.5 — attach (or clear) the Progressive Context surface on the current
   * Ready / Yuhi-Mode panel. Driven ONLY by the public status file (via the
   * controller). Merges into whatever launchable data is already shown, so polling
   * updates never disturb any other phase; a no-op elsewhere.
   */
  applyProgressiveContext(progressive: ProgressiveContextViewModel | undefined): void {
    if (this.data.phase !== "ready" && this.data.phase !== "yuhi-mode") return;
    const next = { ...this.data };
    if (progressive) next.progressive = progressive;
    else delete next.progressive;
    this.set(next);
  }

  /** The agent id currently shown as launching, if any (drives the "Launching…" label). */
  currentPickerLaunching(): string | undefined {
    if (this.data.phase !== "ready" && this.data.phase !== "yuhi-mode") return undefined;
    return this.data.picker?.agents.find((a) => a.launching)?.id;
  }

  /** Recovery needed — surfaced as an empty/prepare state; the reason is shown via a notification. */
  setRecoveryRequired(_reason: string): void {
    this.set({ phase: "not-prepared" });
  }

  /** Agent changes are surfaced via notifications + the Review panel; the activity badge stays. */
  setAgentChangesDetected(): void {
    if (this.data.phase !== "ready" && this.data.phase !== "yuhi-mode") return;
    this.set({ ...this.data, agentChangesDetected: true });
  }

  clearAgentChangesDetected(): void {
    if (this.data.phase !== "ready" && this.data.phase !== "yuhi-mode") return;
    const next = { ...this.data };
    delete next.agentChangesDetected;
    this.set(next);
  }
}

/** Read the current pre-Prepare settings from the `yuhi.*` configuration. */
function readPrepareSettings(): PrepareSettings {
  const cfg = vscode.workspace.getConfiguration("yuhi");
  const rawMode = cfg.get<string>("safetyMode");
  const safetyMode: SafetyModeValue =
    rawMode === "strict" || rawMode === "maximum-privacy" ? rawMode : "balanced";
  const compress = cfg.get<boolean>("compress") === true;
  const rawBudget = cfg.get<number>("tokenBudget");
  const tokenBudget = typeof rawBudget === "number" && rawBudget > 0 ? Math.floor(rawBudget) : 0;
  return { safetyMode, compress, tokenBudget };
}

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 24; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
