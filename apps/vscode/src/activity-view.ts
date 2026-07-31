import * as vscode from "vscode";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PreparedMetrics } from "@yuhi/core";
import {
  renderActivityPanel,
  type ActivityPanelData,
  type BackgroundLifecycle,
} from "./activity-panel.js";

export const YUHI_ACTIVITY_VIEW_ID = "yuhi.workspace";
const STATE_KEY = "yuhi.activityPanel.v1";

/** Extra real-run detail the panel needs beyond PreparedMetrics. */
export interface PreparedDetail {
  outDir: string;
  documentsInspected: number;
  summariesRejected: number;
  backgroundActive?: boolean;
}

/**
 * The Yuhi Preparation activity panel. Renders {@link renderActivityPanel} and
 * persists its state to a Memento so it survives a window reload (the webview is
 * disposed/recreated on reload; in-memory events would otherwise be lost).
 */
export class YuhiActivityProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private data: ActivityPanelData;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly onReveal?: () => void,
  ) {
    this.data = memento.get<ActivityPanelData>(STATE_KEY) ?? { phase: "not-prepared" };
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

  private onMessage(message: { type?: string }): void {
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
      case "details":
        void vscode.commands.executeCommand("yuhi.reviewPrepared");
        break;
    }
  }

  private set(data: ActivityPanelData): void {
    this.data = data;
    void this.memento.update(STATE_KEY, data);
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    this.view.webview.html = renderActivityPanel(this.data, this.view.webview.cspSource, nonce());
  }

  // ---- public state transitions (called from extension.ts) ----

  setNoWorkspace(): void {
    this.set({ phase: "no-workspace" });
  }

  setNotPrepared(): void {
    this.set({ phase: "not-prepared" });
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
    filesTransformed?: number;
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
      ...(detail.filesTransformed !== undefined ? { filesTransformed: detail.filesTransformed } : {}),
    });
  }

  /** Recovery needed — surfaced as an empty/prepare state; the reason is shown via a notification. */
  setRecoveryRequired(_reason: string): void {
    this.set({ phase: "not-prepared" });
  }

  /** Agent changes are surfaced via notifications + the Review panel; the activity badge stays. */
  setAgentChangesDetected(): void {
    /* no panel change; handled by the Review flow */
  }
}

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 24; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
