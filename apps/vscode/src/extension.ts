import * as vscode from "vscode";
import type { RetrievalMode } from "@yuhi/context-gateway";
import {
  DYNAMIC_COMMAND_ID,
  DYNAMIC_SCOPE_NOTICE,
  DYNAMIC_TERMINAL_NAME,
  handleStartupFailure as handleDynamicStartupFailure,
  panelView as dynamicPanelView,
  preflight as dynamicPreflight,
  startDynamicSession,
  type DynamicContextHost,
  type DynamicSessionHandle,
} from "./dynamic-context.js";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, access, mkdir, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { constants as FS } from "node:fs";
import { spawn, execFile } from "node:child_process";
import {
  buildPreparedMetrics,
  buildPreparedFileDecisions,
  buildPreparedRuntimeBoundary,
  buildSafePreparedRunSummary,
  lookupOnPath,
  managedWorkspaceBaseDir,
  prepareWorkspaceOutcome,
  runBackgroundForRun,
  requestBackgroundCancel,
  readPublicStatus,
  computeRevisionId,
  capturePatchSession,
  loadPatchSession,
  reviewPatchSession,
  readPrivateRunSourceBinding,
  applyPatchSession,
  undoPatch,
  discardPreparedChanges,
  privatePatchSessionDir,
  reduceProgressiveContextState,
  runInit,
  DEFAULT_DISCLOSURE_SAFETY_MODE,
  DEFAULT_CONTEXT_DETAIL,
  DEFAULT_PREPARE_SAFETY_MODE,
  isSafetyMode,
  isContextId,
  safetyModeLabel,
  checkSafetyModeFreshness,
  type SafetyMode,
  type PrepareReport,
  type PreparedFileEntry,
  type PreparationProgressEvent,
  type ProgressiveContextState,
  type PublicBackgroundStatus,
  type PatchReviewResult,
  type PrivatePatchSessionState,
  type CompressionReport,
  type PublicPreparedContextSummary,
} from "@yuhi/core";
import { createLocalModelProvider, localModelReadiness, INFERENCE_FAILURE_ACTIONS } from "@yuhi/local";
import {
  DEFAULT_LOCAL_MODEL,
  MODEL_TIERS,
  CONFIG_FILENAME,
  isYuhiError,
  type LocalModelConfig,
  type LocalModelProvider,
  type ModelTier,
  type HealthResult,
} from "@yuhi/shared";
import { loadConfig } from "@yuhi/config";
import { parseDocument } from "yaml";
import { renderSavingsHtml, type ReviewData } from "./webview.js";
import {
  repositoryReadyClipboardText,
  repositoryReadyExportText,
  REPOSITORY_READY_EXPORT_FORMATS,
} from "./repository-ready.js";
import { YUHI_ACTIVITY_VIEW_ID, YuhiActivityProvider, type PreparedDetail } from "./activity-view.js";
import { ProgressiveContextController } from "./progressive-context.js";
import { PREPARED_WINDOW_TITLE, PREPARED_WORKBENCH_COLORS } from "./branding.js";
import { validatePreparedWorkspace, type RecoveryReason } from "./recovery.js";
import { renderAgentChangeReviewHtml, selectedApplicableChanges } from "./agent-review.js";
import {
  CLAUDE_INTEGRATION,
  CLAUDE_SANDBOX_RELPATH,
  claudeSandboxPolicyDiagnostic,
  LAUNCH_COMMANDS,
  appendLaunchAudit,
  buildSummary,
  classifyOutcome,
  canOpen,
  formatSummaryDetail,
  normalizePreparedSession,
  preparedStatusTooltipLines,
  runPrepareAndOpen,
  runPrepareAndStartClaude,
  runVisibleLaunchCommand,
  openPreparedWorkspace,
  writePreparedArtifacts,
  writeAndVerifyClaudeSandboxPolicy,
  configureClaudeWorkspacePolicyDefaults,
  type ClaudePermissionMode,
  type YuhiSandboxPreset,
  type ClaudeMode,
  type LaunchHost,
  type VisibleLaunchFailureKind,
} from "./launch.js";
import { createDefaultRegistry, DEFAULT_DETECT_TIMEOUT_MS } from "@yuhi/agents";
import type { AgentCommand } from "@yuhi/shared";
import type { AgentRunOutcome } from "@yuhi/agents";
import {
  detectAgents,
  buildAgentPickerData,
  runAgentLaunch,
  preparedContextFromRun,
  readLastAgentId,
  rememberLastAgentId,
  PICKER_AGENT_IDS,
  PICKER_AGENT_DISPLAY_NAMES,
  PICKER_DETECT_TIMEOUT_MS,
  type PickerAgentId,
  type AgentPickerData,
} from "./agent-picker.js";

const OLLAMA_DOWNLOAD = "https://ollama.com/download";

// ---- status bar ----
type StatusState =
  | "ready"
  | "ollama-missing"
  | "ollama-stopped"
  | "model-missing"
  | "inference-failed"
  | "preparing"
  | "ready-for-review"
  | "agent-changes"
  | "recovery-required"
  | "failed";

const STATUS: Record<StatusState, { text: string; icon: string; command?: string; tip: string }> = {
  ready: { text: "Yuhi ready", icon: "shield", command: "yuhi.prepareWorkspace", tip: "Prepare this workspace locally before sending to Claude." },
  "ollama-missing": { text: "Ollama missing", icon: "warning", command: "yuhi.setupLocalAI", tip: "Local AI runtime not found. Run Setup Local AI." },
  "ollama-stopped": { text: "Ollama stopped", icon: "debug-disconnect", command: "yuhi.doctor", tip: "Ollama is installed but not running. Start it, then run Doctor." },
  "model-missing": { text: "Model missing", icon: "cloud-download", command: "yuhi.setupLocalAI", tip: "No local model installed. Run Setup Local AI." },
  "inference-failed": { text: "Inference failed", icon: "error", command: "yuhi.doctor", tip: "Ollama is installed but generation failed. Run Doctor for the reason and fixes." },
  preparing: { text: "Yuhi is processing…", icon: "sync~spin", tip: "Yuhi is processing your workspace locally…" },
  "ready-for-review": { text: "Ready for review", icon: "eye", command: "yuhi.reviewPrepared", tip: "Preparation complete. Review what would be sent." },
  "agent-changes": { text: "AI changes detected", icon: "diff", command: "yuhi.reviewAgentChanges", tip: "Review agent changes. Nothing is applied automatically." },
  "recovery-required": { text: "Recovery required", icon: "warning", command: "yuhi.restartFlow", tip: "Choose a source folder and create a new safe Prepared Workspace." },
  failed: { text: "Preparation failed", icon: "error", command: "yuhi.doctor", tip: "Preparation failed. Run Doctor to diagnose." },
};

let statusBar: vscode.StatusBarItem;
function setStatus(state: StatusState): void {
  const s = STATUS[state];
  statusBar.text = `$(${s.icon}) ${s.text}`;
  statusBar.tooltip = `Yuhi: ${s.tip}`;
  statusBar.command = s.command;
  statusBar.show();
}

// ---- shared state ----
let lastReport: PrepareReport | undefined;
let lastReportRoot: string | undefined;
/** The real @yuhi/core Safety Mode the current prepared run (lastReport) used. */
let lastReportSafetyMode: SafetyMode | undefined;
let reviewPanel: vscode.WebviewPanel | undefined;
const confirmedWarningIncludes = new Set<string>();
let preparedStatusBar: vscode.StatusBarItem | undefined;
let reviewingOpenedPreparedWorkspace = false;
let preparedSandboxVerified = false;
let yuhiOutput: vscode.OutputChannel | undefined;
let pendingReviewDecision: ((decision: "open" | "cancel") => void) | undefined;
let activityProvider: YuhiActivityProvider | undefined;
// v0.3.5 Progressive Context — drives the panel from the PUBLIC status file only.
let progressiveController: ProgressiveContextController | undefined;
let progressivePoll: ReturnType<typeof setInterval> | undefined;
let claudeOpenPromise: Promise<boolean> | undefined;
let visibleCommandRunning = false;
let activePrepareController: AbortController | undefined;
let activePrepareDone: Promise<void> | undefined;
let restartFlowRunning = false;
let recoveryReason: RecoveryReason | undefined;
let currentIsPreparedWorkspace = false;
let extensionContext: vscode.ExtensionContext | undefined;
let agentReviewPanel: vscode.WebviewPanel | undefined;
let sourceAgentChangeWatcher: vscode.FileSystemWatcher | undefined;
let agentReviewMutationRunning = false;
let suppressAgentWatcherUntil = 0;
let agentSessionStarted = false;
const PREPARATION_WATCHDOG_MS = 10 * 60_000;
const LAST_ORIGINAL_WORKSPACE_KEY = "yuhi.lastOriginalWorkspace";

const CLAUDE_OPEN_COMMANDS = [
  "claude-vscode.sidebar.open",
  "claude-vscode.editor.openLast",
] as const;

// v0.3.4 — "one prepared repository, multiple agents". The allowlisted adapter
// registry (Claude Code / Codex). Adapters load lazily on first `get(id)`; importing
// it here costs nothing until an agent is actually detected or launched. An id outside
// the allowlist is rejected by the registry and can never be launched.
const agentRegistry = createDefaultRegistry();
let agentLaunchRunning = false;

/** POSIX single-quote a token so a terminal command is assembled from safe tokens
 *  (never an unescaped path/arg). Mirrors the launch-primitive quoting. */
function shQuoteToken(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * A launch runner that drives the adapter's assembled command (executable + argv
 * ARRAY) in a labelled VS Code terminal whose cwd IS the prepared repository —
 * preserving the existing observable launch behavior (working dir = prepared repo,
 * argv handling). The terminal inherits the user's shell environment; the adapter's
 * allow-listed `env` is not force-applied to an interactive terminal.
 */
// --- v0.4.0 Dynamic Context -------------------------------------------------------
/** One session per window. A second start replaces the first rather than racing it. */
let dynamicSession: DynamicSessionHandle | undefined;
let dynamicStatusBar: vscode.StatusBarItem | undefined;

function dynamicHost(): DynamicContextHost {
  return {
    createTerminal: ({ name, cwd, env }) => {
      const term = vscode.window.createTerminal({ name, cwd, env });
      return { sendText: (t, nl) => term.sendText(t, nl), show: () => term.show(), dispose: () => term.dispose() };
    },
    log: (line) => yuhiOutput?.appendLine(line),
    setStatus: (text, tooltip) => {
      if (!dynamicStatusBar) {
        dynamicStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
        dynamicStatusBar.command = "yuhi.showDynamicStats";
      }
      dynamicStatusBar.text = text;
      dynamicStatusBar.tooltip = tooltip;
      dynamicStatusBar.show();
    },
    clearStatus: () => dynamicStatusBar?.hide(),
    showMessage: (m) => void vscode.window.showInformationMessage(m),
    showWarning: (m) => void vscode.window.showWarningMessage(m),
    choose: async (message, choices) => vscode.window.showWarningMessage(message, ...choices),
    onStatsChanged: (view) => {
      // The panel keeps this in its own section; static metrics are untouched.
      activityProvider?.setDynamic(view);
    },
  };
}

/**
 * Resolve the Prepared Workspace to run the dynamic session in.
 *
 * The point of this indirection is that the user picks a FOLDER, not a prepared-run path.
 * Three cases, in order of preference:
 *   1. this window IS a Prepared Workspace → use it;
 *   2. this window prepared one earlier in the session → reuse it;
 *   3. otherwise prepare the open folder now, then use the result.
 *
 * The terminal's cwd is independent of the window's folder, so a source-folder window can
 * host the session without opening a second window or asking which agent again.
 */
async function resolveDynamicPreparedRoot(): Promise<string | undefined> {
  if (reviewingOpenedPreparedWorkspace) return firstWorkspaceRoot();
  if (lastReport?.outDir) return lastReport.outDir;

  const source = firstWorkspaceRoot();
  if (!source) return undefined;
  await commandPrepare();
  return lastReport?.outDir;
}

async function commandLaunchClaudeDynamic(): Promise<void> {
  const preparedRoot = await resolveDynamicPreparedRoot();
  const insidePrepared = reviewingOpenedPreparedWorkspace || preparedRoot !== undefined;
  // The sandbox policy lives in the Prepared Workspace; write and verify it for the root we
  // are about to launch into, rather than trusting a flag set for a different window.
  let sandboxVerified = preparedSandboxVerified;
  if (preparedRoot && !sandboxVerified) {
    try {
      await writeAndVerifyClaudeSandboxPolicy(preparedRoot, preparedRoot);
      sandboxVerified = true;
    } catch {
      sandboxVerified = (await claudeSandboxPolicyDiagnostic(preparedRoot)).valid;
    }
  }

  const check = dynamicPreflight({
    preparedRoot,
    insidePreparedWorkspace: insidePrepared,
    sandboxVerified,
    claudeAvailable: await claudeCliAvailable(),
  });
  if (!check.ok) {
    void vscode.window.showWarningMessage(`Yuhi: ${check.message}`);
    return;
  }

  if (dynamicSession) {
    void vscode.window.showInformationMessage(
      "Yuhi: a dynamic context session is already running in this window. Close its terminal to end it.",
    );
    return;
  }

  const host = dynamicHost();
  const mode = dynamicRetrievalModeSetting();
  try {
    dynamicSession = await startDynamicSession(host, {
      preparedWorkspace: check.preparedRoot,
      claudeCommand: "claude",
      retrievalMode: mode,
    });
  } catch (err) {
    // NEVER downgrade silently: the user asked for dynamic context.
    const reason = err instanceof Error ? err.message : "unknown";
    const choice = await handleDynamicStartupFailure(host, reason);
    if (choice === "Retry") return commandLaunchClaudeDynamic();
    if (choice === "Open Doctor Output") yuhiOutput?.show(true);
    if (choice === "Start normal Claude Code") await commandOpenClaudeHere();
    return;
  }

  void vscode.window.showInformationMessage(`Yuhi: ${DYNAMIC_SCOPE_NOTICE}`);
  yuhiOutput?.appendLine(`[dynamic] ${DYNAMIC_SCOPE_NOTICE}`);
}

/** Closing the dedicated terminal ends the session: gateway down, evidence flushed. */
function watchDynamicTerminalClose(): vscode.Disposable {
  return vscode.window.onDidCloseTerminal((term) => {
    if (term.name !== DYNAMIC_TERMINAL_NAME || !dynamicSession) return;
    const session = dynamicSession;
    dynamicSession = undefined;
    void session.close().then(() => {
      void vscode.window.showInformationMessage("Yuhi: dynamic context session complete. Gateway stopped.");
    });
  });
}

function dynamicRetrievalModeSetting(): RetrievalMode {
  const configured = vscode.workspace.getConfiguration("yuhi").get<string>("dynamicContext.retrievalMode");
  return configured === "conditional" || configured === "required" ? configured : "disabled";
}

async function claudeCliAvailable(): Promise<boolean> {
  try {
    const registry = createDefaultRegistry();
    const adapter = await registry.get("claude");
    return (await adapter.detect({ timeoutMs: DEFAULT_DETECT_TIMEOUT_MS })).available;
  } catch {
    return false;
  }
}

function agentTerminalRunner(displayName: string): (command: AgentCommand) => Promise<AgentRunOutcome> {
  return async (command) => {
    const term = vscode.window.createTerminal({ name: `Yuhi · ${displayName}`, cwd: command.cwd });
    const line = [command.file, ...command.args].map(shQuoteToken).join(" ");
    term.sendText(line, true);
    term.show();
    return { exitCode: 0, signal: null };
  };
}

/** Is the selected Safety Mode out of date vs the prepared run? (DIRTY gate.) */
function preparedRunIsDirty(report: PrepareReport): boolean {
  return !checkSafetyModeFreshness(report.safetyMode, currentSafetyMode()).fresh;
}

/** The shared prepared context the picker launches into, plus whether the DIRTY gate
 *  applies. One resolver for BOTH surfaces:
 *   - the source window's Ready surface (freshly prepared run) → DIRTY gate applies;
 *   - an OPENED Prepared Workspace (Yuhi-Mode) → the context is immutable/completed,
 *     so the source-vs-selected dirty gate is NOT applied (picker stays enabled).
 *  Returns undefined when there is no valid `sha256:` Context ID (e.g. a legacy run),
 *  so the caller falls back to the single launch button. */
interface AgentPickerSource {
  contextId: string;
  outDir: string;
  runId: string;
  dirty: boolean;
}
function currentPickerSource(): AgentPickerSource | undefined {
  const report = lastReport;
  if (!report?.contextId || !isContextId(report.contextId)) return undefined;
  return {
    contextId: report.contextId,
    outDir: report.outDir,
    runId: report.runId,
    // An opened Prepared Workspace is an immutable, completed context.
    dirty: reviewingOpenedPreparedWorkspace ? false : preparedRunIsDirty(report),
  };
}

/** Detect availability (short timeout — never hangs) and build the picker for a source.
 *  Best-effort: returns undefined on any failure so the panel just shows the single
 *  launch button. Nothing here surfaces an absolute path — only the `sha256:` id. */
async function buildAgentPickerFor(
  source: AgentPickerSource,
  launchingAgentId: string | null = null,
): Promise<AgentPickerData | undefined> {
  try {
    const availabilities = await detectAgents(agentRegistry, [...PICKER_AGENT_IDS], {
      timeoutMs: PICKER_DETECT_TIMEOUT_MS,
    });
    const lastAgentId = extensionContext ? readLastAgentId(extensionContext.globalState) : undefined;
    return buildAgentPickerData({
      contextId: source.contextId,
      availabilities,
      ...(lastAgentId ? { lastAgentId } : {}),
      dirty: source.dirty,
      launchingAgentId,
    });
  } catch {
    return undefined;
  }
}

/**
 * Push the agent picker onto the current Ready / Yuhi-Mode surface: two launch actions
 * (Claude Code / Codex), the run's Context ID, the last-used agent as the default, and
 * the DIRTY gate where it applies. Best-effort — never destabilizes the panel.
 */
async function refreshAgentPicker(launchingAgentId: string | null = null): Promise<void> {
  const source = currentPickerSource();
  if (!activityProvider || !source) return;
  const picker = await buildAgentPickerFor(source, launchingAgentId);
  if (picker) activityProvider.applyAgentPicker(picker);
}

/**
 * Launch the chosen agent into the SAME prepared run — reusing one prepared repository
 * across agents. Routed entirely through the registry adapter (detect → prepare →
 * launch); an unknown id can't be launched. Honors the DIRTY gate where it applies,
 * remembers the last-used agent, and ALWAYS returns the UI to a usable state (a failed
 * or blocked launch is never left stuck in "Launching…"). The working directory is the
 * prepared repository (source window: the prepared run's outDir; Yuhi-Mode: this window).
 */
async function commandLaunchAgent(agentId: string): Promise<void> {
  if (agentLaunchRunning) return;
  const source = currentPickerSource();
  if (!source) {
    void vscode.window.showWarningMessage("Yuhi: prepare a repository before launching an agent.");
    return;
  }
  if (!(PICKER_AGENT_IDS as readonly string[]).includes(agentId)) {
    void vscode.window.showWarningMessage("Yuhi: that agent is not available.");
    return;
  }
  const id = agentId as PickerAgentId;
  const displayName = PICKER_AGENT_DISPLAY_NAMES[id];
  const patchSessionId = randomUUID();
  let inheritPatchSessionId: string | undefined;
  agentLaunchRunning = true;
  try {
    const availabilities = await detectAgents(agentRegistry, [...PICKER_AGENT_IDS], {
      timeoutMs: PICKER_DETECT_TIMEOUT_MS,
    });
    const availability = availabilities.find((a) => a.id === id);
    const result = await runAgentLaunch({
      registry: agentRegistry,
      id,
      context: preparedContextFromRun({
        contextId: source.contextId,
        outDir: source.outDir,
        runId: source.runId,
      }),
      dirty: source.dirty,
      ...(availability ? { availability } : {}),
      runner: agentTerminalRunner(displayName),
      forwardedArgs: [],
      beforeLaunch: async () => {
        const managedBase = managedWorkspaceBaseDir();
        try {
          const previous = await loadPatchSession(managedBase, source.runId);
          const previousReview = await reviewPatchSession(previous);
          if (previousReview.changes.length > 0) {
            const choice = await vscode.window.showWarningMessage(
              `Yuhi found ${previousReview.changes.length} unreviewed change(s) from the previous agent session.`,
              "Review Changes",
              "Start New Session",
            );
            if (choice !== "Start New Session") {
              if (choice === "Review Changes") await commandReviewAgentChanges();
              throw new Error("previous-session-review-required");
            }
            inheritPatchSessionId = previous.sessionId;
          }
        } catch (error) {
          if (error instanceof Error && error.message === "previous-session-review-required") throw error;
          // No earlier session is the normal first-launch state.
        }
        const sourceBinding = await readPrivateRunSourceBinding(managedBase, source.runId);
        const publicStatus = await readPublicStatus(source.outDir).catch(() => undefined);
        const revisionId = publicStatus?.revisionId ?? computeRevisionId({
          baseContextId: source.contextId,
          files: [],
        });
        await capturePatchSession({
          managedBase,
          runId: source.runId,
          sessionId: patchSessionId,
          contextId: source.contextId,
          revisionId,
          preparedRoot: source.outDir,
          sourceRoot: sourceBinding.sourceRoot,
          agentId: id,
          ...(inheritPatchSessionId ? { inheritFromSessionId: inheritPatchSessionId } : {}),
        });
        const statusAfterSnapshot = await readPublicStatus(source.outDir).catch(() => undefined);
        if (statusAfterSnapshot?.revisionId && statusAfterSnapshot.revisionId !== revisionId) {
          throw new Error("context-revision-changed-during-snapshot");
        }
      },
      onLaunchingChange: (launchingId) => {
        // Reflect launching → picker so the UI shows "Launching…" and, on settle,
        // returns to a usable state (never stuck).
        const lastAgentId = extensionContext ? readLastAgentId(extensionContext.globalState) : undefined;
        activityProvider?.applyAgentPicker(
          buildAgentPickerData({
            contextId: source.contextId,
            availabilities,
            ...(lastAgentId ? { lastAgentId } : {}),
            dirty: source.dirty,
            launchingAgentId: launchingId,
          }),
        );
      },
      rememberLast: (rememberedId) =>
        extensionContext ? rememberLastAgentId(extensionContext.globalState, rememberedId) : undefined,
    });
    if (result.status === "blocked-dirty") {
      void vscode.window
        .showWarningMessage(
          "Yuhi: the selected Safety Mode differs from the prepared run. Re-prepare before launching either agent.",
          "Review Prepared Context",
        )
        .then((choice) => {
          if (choice === "Review Prepared Context") void commandReview();
        });
    } else if (result.status === "unavailable") {
      void vscode.window.showWarningMessage(`Yuhi: ${result.installHint}`);
    } else if (result.status === "failed") {
      void vscode.window.showErrorMessage(
        `Yuhi: could not launch ${displayName}. The panel returned to a ready state — try again, or launch the other agent.`,
      );
    } else if (result.status === "launched") {
      agentSessionStarted = true;
    }
  } finally {
    agentLaunchRunning = false;
    // Re-resolve availability + clear any launching flag (last-used may have changed).
    await refreshAgentPicker();
  }
}

// ---- helpers ----
function firstWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function quarantineBaseDir(): string {
  return path.join(path.dirname(managedWorkspaceBaseDir()), "quarantine");
}

function isManagedYuhiWorkspace(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  const storage = path.resolve(path.dirname(managedWorkspaceBaseDir()));
  return resolved === storage || resolved.startsWith(`${storage}${path.sep}`);
}

async function reconcilePreparedWorkspace(
  workspace: string,
  expectedWorkspace?: string,
) {
  return await validatePreparedWorkspace({
    workspace,
    ...(expectedWorkspace ? { expectedWorkspace } : {}),
    managedBase: managedWorkspaceBaseDir(),
    quarantineBase: quarantineBaseDir(),
  });
}

function enterRecovery(reason: RecoveryReason, message: string): void {
  recoveryReason = reason;
  reviewingOpenedPreparedWorkspace = false;
  preparedSandboxVerified = false;
  setStatus("recovery-required");
  activityProvider?.setRecoveryRequired(message);
  preparedStatusBar?.hide();
  appendSafeRecoveryCheckpoint("recovery-required", reason);
}

async function showRecoveryRequired(reason: RecoveryReason, message: string): Promise<void> {
  enterRecovery(reason, message);
  const choice = await vscode.window.showWarningMessage(
    message,
    {
      modal: true,
      detail: "This run cannot be opened because it was removed, quarantined, incomplete, or invalid. Create a new safe Prepared Workspace to continue.",
    },
    "Choose Source Folder and Prepare Again",
    "Open Source Workspace",
    "Dismiss Previous Run",
  );
  if (choice === "Choose Source Folder and Prepare Again") {
    await vscode.commands.executeCommand("yuhi.restartFlow");
  } else if (choice === "Open Source Workspace") {
    await vscode.commands.executeCommand("yuhi.openSourceWorkspace");
  } else if (choice === "Dismiss Previous Run") {
    await vscode.commands.executeCommand("yuhi.dismissPreviousRun");
  }
}

type PreparedRecoveryAction =
  | "open-agent"
  | "return-original"
  | "review"
  | "exclude-retry"
  | "choose-another"
  | "unavailable";

async function originalWorkspaceForRun(runId?: string): Promise<string | undefined> {
  const bound = runId
    ? await readPrivateRunSourceBinding(managedWorkspaceBaseDir(), runId).catch(() => undefined)
    : undefined;
  const candidate =
    bound?.sourceRoot ??
    extensionContext?.globalState.get<string>(LAST_ORIGINAL_WORKSPACE_KEY);
  if (!candidate || isManagedYuhiWorkspace(candidate)) return undefined;
  try {
    await access(candidate, FS.R_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

async function returnToOriginalWorkspace(runId?: string): Promise<boolean> {
  const original = await originalWorkspaceForRun(runId);
  if (!original) return false;
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(original), false);
  return true;
}

async function retryExcludingBlockedFiles(): Promise<void> {
  if (!lastReport || !extensionContext) return;
  const original = await originalWorkspaceForRun(lastReport.runId);
  if (!original) {
    await commandRestartFlow(extensionContext);
    return;
  }
  const blocked = lastReport.files
    .filter((file) => file.status === "error" || file.status === "blocked")
    .map((file) => file.relpath);
  if (blocked.length === 0) {
    await vscode.window.showInformationMessage(
      "No explicitly blocked files were found. Choose another Original Workspace or review the preparation details.",
    );
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    "Exclude blocked files and prepare again?",
    {
      modal: true,
      detail:
        `${blocked.length} blocked file(s) will be excluded from a new run. ` +
        "The current incomplete run remains immutable and cannot launch an agent.",
    },
    "Exclude and Prepare Again",
    "Cancel",
  );
  if (choice !== "Exclude and Prepare Again") return;
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(original), false);
  const target = await pickYuhiLaunchTarget(extensionContext);
  if (target) await startClaudeFromSourceWorkspace(extensionContext, original, target);
}

async function showPreparedWorkspaceRecovery(root: string): Promise<void> {
  currentIsPreparedWorkspace = true;
  const runId = lastReport?.runId ?? await currentPreparedRunId(root);
  const state = await reconcilePreparedWorkspace(root, root);
  const incomplete = state.kind === "recovery-required" &&
    (state.reason === "preparation-incomplete" || state.reason === "unresolved-high-risk");
  const blockedCount = lastReport?.files.filter(
    (file) => file.status === "error" || file.status === "blocked",
  ).length ?? 0;
  const originalAvailable = await originalWorkspaceForRun(runId) !== undefined;
  const items: (vscode.QuickPickItem & { action: PreparedRecoveryAction })[] = incomplete
    ? [
        {
          label: "$(warning) Preparation incomplete",
          description: state.kind === "recovery-required" ? state.reason : "blocked",
          detail: `${blockedCount} blocked or unavailable file(s). Agent launch is unavailable.`,
          action: "unavailable",
        },
        {
          label: "$(open-preview) Review blocked files",
          detail: "Review metadata-safe reasons and unavailable actions.",
          action: "review",
        },
        {
          label: "$(exclude) Exclude blocked files and prepare again",
          detail: "Creates a new run. Raw fallback is never used.",
          action: "exclude-retry",
        },
        {
          label: "$(folder-opened) Choose another Original Workspace",
          action: "choose-another",
        },
      ]
    : [
        {
          label: "$(comment-discussion) Open Claude Code in this Prepared Workspace",
          detail: preparedSandboxVerified
            ? "Continue the verified Prepared Workspace."
            : "Available after Yuhi verifies the Prepared Workspace sandbox policy.",
          action: preparedSandboxVerified ? "open-agent" : "unavailable",
        },
        {
          label: "$(folder) Return to Original Workspace",
          description: originalAvailable ? "Detected automatically" : "Original location unavailable",
          action: originalAvailable ? "return-original" : "unavailable",
        },
        {
          label: "$(open-preview) Review Preparation",
          action: "review",
        },
        {
          label: "$(folder-opened) Choose Another Workspace",
          action: "choose-another",
        },
      ];
  const picked = await vscode.window.showQuickPick(items, {
    title: incomplete ? "Preparation incomplete" : "This is a Yuhi Prepared Workspace",
    placeHolder: "Choose the next safe action",
  });
  if (!picked) return;
  if (picked.action === "open-agent") await commandOpenClaudeHere();
  else if (picked.action === "return-original") await returnToOriginalWorkspace(runId);
  else if (picked.action === "review") await commandReview();
  else if (picked.action === "exclude-retry") await retryExcludingBlockedFiles();
  else if (picked.action === "choose-another" && extensionContext) {
    await commandRestartFlow(extensionContext);
  } else if (picked.action === "unavailable") {
    await vscode.window.showInformationMessage(
      incomplete
        ? "Agent launch is unavailable until preparation completes successfully."
        : "This action is currently unavailable. Choose another recovery action.",
    );
  }
}

function appendSafeRecoveryCheckpoint(stage: string, result: string): void {
  yuhiOutput?.appendLine(JSON.stringify({
    runId: lastReport?.runId ?? "not-available",
    stage,
    result,
  }));
}

/** Walk up from `start` to find the directory that holds yuhi.yaml; else the workspace root. */
function resolveConfigDir(start: string): string | undefined {
  let dir = start;
  const stop = path.parse(dir).root;
  // walk up until a yuhi.yaml is found
  // (bounded by filesystem root)
  while (true) {
    if (existsSync(path.join(dir, CONFIG_FILENAME))) return dir;
    if (dir === stop) break;
    dir = path.dirname(dir);
  }
  return firstWorkspaceRoot();
}

/** Load the configured local-model settings (falls back to DEFAULT_LOCAL_MODEL). */
async function localModelConfig(root: string): Promise<Partial<LocalModelConfig>> {
  try {
    const { config } = await loadConfig(root);
    const lm = config.local_model;
    if (!lm) return {};
    return { provider: lm.provider, endpoint: lm.endpoint, model: lm.model, timeoutMs: lm.timeout_ms };
  } catch {
    return {};
  }
}

async function buildProvider(root: string): Promise<LocalModelProvider> {
  return createLocalModelProvider(await localModelConfig(root));
}

async function configuredModel(root: string): Promise<string> {
  const cfg = await localModelConfig(root);
  return cfg.model ?? DEFAULT_LOCAL_MODEL.model;
}

/** Is the `ollama` binary on PATH? Uses `ollama --version`; never installs. */
function ollamaBinaryAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ollama", ["--version"], { timeout: 8000 }, (err) => resolve(!err));
  });
}

/** Best-effort: read live on-disk sizes for installed models from /api/tags. */
async function liveModelSizes(endpoint: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/api/tags`, { method: "GET" });
    if (!res.ok) return out;
    const body = (await res.json()) as { models?: { name?: string; size?: number }[] };
    for (const m of body.models ?? []) {
      if (typeof m.name === "string" && typeof m.size === "number") out.set(m.name, m.size);
    }
  } catch {
    /* offline / not running — fall back to approx sizes */
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  return `~${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---- doctor ----
interface DoctorState {
  ollamaBinary: boolean;
  health: HealthResult;
  model: string;
  modelInstalled: boolean;
  inference: { ok: boolean; reason?: string };
  yuhiWritable: boolean;
  hasConfig: boolean;
  status: StatusState;
}

async function runDoctorChecks(root: string): Promise<DoctorState> {
  const provider = await buildProvider(root);
  const model = await configuredModel(root);
  const ollamaBinary = await ollamaBinaryAvailable();
  // Readiness includes an INFERENCE smoke test — never report ready on API+model alone.
  const readiness = await localModelReadiness(provider, { model });
  const health: HealthResult = {
    ok: readiness.apiReachable,
    detail: readiness.apiReachable ? `reachable (${readiness.models.length} model(s))` : "not reachable",
    endpoint: provider.endpoint,
    ...(readiness.apiReachable ? { models: readiness.models } : {}),
  };
  const modelInstalled = readiness.modelInstalled;
  const hasConfig = existsSync(path.join(root, CONFIG_FILENAME));

  let yuhiWritable = false;
  try {
    const dir = path.join(root, ".yuhi");
    await mkdir(dir, { recursive: true });
    await access(dir, FS.W_OK);
    yuhiWritable = true;
  } catch {
    yuhiWritable = false;
  }

  let status: StatusState = "ready";
  if (!ollamaBinary && !readiness.apiReachable) status = "ollama-missing";
  else if (!readiness.apiReachable) status = "ollama-stopped";
  else if (!modelInstalled) status = "model-missing";
  else if (!readiness.inference.ok) status = "inference-failed";

  return { ollamaBinary, health, model, modelInstalled, inference: readiness.inference, yuhiWritable, hasConfig, status };
}

async function refreshStatus(root: string | undefined): Promise<DoctorState | undefined> {
  if (!root) {
    setStatus("ready");
    return undefined;
  }
  const state = await runDoctorChecks(root);
  setStatus(state.status);
  return state;
}

async function commandDoctor(): Promise<void> {
  const root = firstWorkspaceRoot();
  if (!root) {
    void vscode.window.showInformationMessage("Yuhi: open a folder to run Doctor.");
    return;
  }
  const s = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Yuhi: running checks…" },
    () => runDoctorChecks(root),
  );
  setStatus(s.status);

  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  const detail = [
    `${mark(s.ollamaBinary)} Ollama installed${s.ollamaBinary ? "" : " — not found on PATH"}`,
    `${mark(s.health.ok)} Ollama running — ${s.health.detail}`,
    `${mark(s.modelInstalled)} Model "${s.model}" installed${s.modelInstalled ? "" : " — not pulled yet"}`,
    `${mark(s.inference.ok)} Inference${s.inference.ok ? " — smoke test passed" : ` failed — ${s.inference.reason ?? "unknown"}`}`,
    `${mark(s.yuhiWritable)} .yuhi is writable`,
    `${mark(s.hasConfig)} yuhi.yaml present${s.hasConfig ? "" : " — not initialized"}`,
    ...(s.status === "inference-failed"
      ? ["", "Suggested actions:", ...INFERENCE_FAILURE_ACTIONS.map((a) => `  • ${a}`)]
      : []),
  ].join("\n");

  const actions: string[] = [];
  if (!s.ollamaBinary || !s.modelInstalled) actions.push("Setup Local AI");
  if (!s.hasConfig) actions.push("Initialize");
  if (s.status === "ready") actions.push("Prepare Workspace");

  const heading =
    s.status === "ready" ? "Yuhi is ready." : "Yuhi found something to fix.";
  const choice = await vscode.window.showInformationMessage(
    heading,
    { modal: true, detail },
    ...actions,
  );
  if (choice === "Setup Local AI") await vscode.commands.executeCommand("yuhi.setupLocalAI");
  else if (choice === "Initialize") await initializeProject(root);
  else if (choice === "Prepare Workspace") await vscode.commands.executeCommand("yuhi.prepareWorkspace");
}

// ---- setup local ai ----
async function commandSetupLocalAI(): Promise<void> {
  const root = firstWorkspaceRoot();
  if (!root) {
    void vscode.window.showInformationMessage("Yuhi: open a folder first.");
    return;
  }

  // 1) Binary must exist — we never install Ollama for the user.
  if (!(await ollamaBinaryAvailable())) {
    const pick = await vscode.window.showErrorMessage(
      "Ollama is not installed. Yuhi uses a local Ollama runtime to prepare your files on-device.",
      "Install Ollama",
    );
    if (pick === "Install Ollama") {
      await vscode.env.openExternal(vscode.Uri.parse(OLLAMA_DOWNLOAD));
    }
    return;
  }

  // 2) Offer the recommended tiers; prefer live size for already-installed models.
  const cfg = await localModelConfig(root);
  const endpoint = cfg.endpoint ?? DEFAULT_LOCAL_MODEL.endpoint;
  const sizes = await liveModelSizes(endpoint);
  const preselect = DEFAULT_LOCAL_MODEL.model;
  const items: (vscode.QuickPickItem & { tier: ModelTier })[] = MODEL_TIERS.map((tier) => {
    const live = sizes.get(tier.id);
    const size = live !== undefined ? formatBytes(live) : tier.approxSize;
    const installed = sizes.has(tier.id) ? " · installed" : "";
    return {
      label: tier.id === preselect ? `$(star-full) ${tier.id}` : tier.id,
      description: `${tier.label} · ${size}${installed}`,
      detail: tier.blurb,
      tier,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: "Yuhi — choose a local model",
    placeHolder: "qwen3:1.7b is recommended for most machines",
    ignoreFocusOut: true,
  });
  if (!picked) return;
  const model = picked.tier.id;

  // Already installed → just save + smoke test, no download needed.
  if (sizes.has(model)) {
    await saveModelToConfig(root, model);
    await smokeTest(root, model);
    void refreshStatus(root);
    return;
  }

  // 3) Explicit, modal confirmation before ANY download.
  const live = sizes.get(model);
  const sizeLabel = live !== undefined ? formatBytes(live) : picked.tier.approxSize;
  const go = await vscode.window.showWarningMessage(
    `Download "${model}" locally?`,
    {
      modal: true,
      detail:
        `Yuhi will run "ollama pull ${model}" to download the model (${sizeLabel}) to your machine. ` +
        `Nothing about your code is sent anywhere — this only fetches the model weights from Ollama. ` +
        `You can cancel at any time.`,
    },
    "Download",
  );
  if (go !== "Download") return;

  // 4) Pull with progress + cancellation. Never auto-pulls; this is the explicit action.
  const ok = await pullModel(model);
  if (!ok) {
    void refreshStatus(root);
    return;
  }

  // 5) Smoke test, then persist to yuhi.yaml.
  await saveModelToConfig(root, model);
  await smokeTest(root, model);
  void refreshStatus(root);
}

/** Run `ollama pull <model>` with a progress notification and a cancel button. */
function pullModel(model: string): Thenable<boolean> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Yuhi: downloading ${model} (local)`,
      cancellable: true,
    },
    (progress, token) =>
      new Promise<boolean>((resolve) => {
        const child = spawn("ollama", ["pull", model]);
        let lastPct = 0;
        let stderrTail = "";

        const onChunk = (buf: Buffer) => {
          const text = buf.toString();
          stderrTail = (stderrTail + text).slice(-500);
          // ollama emits \r-updated progress lines; take the last segment.
          const seg = text.split(/[\r\n]+/).filter(Boolean).pop();
          if (!seg) return;
          const pctMatch = seg.match(/(\d{1,3})%/);
          if (pctMatch) {
            const pct = Math.min(100, Number(pctMatch[1]));
            const inc = Math.max(0, pct - lastPct);
            lastPct = pct;
            progress.report({ message: seg.trim(), increment: inc });
          } else {
            progress.report({ message: seg.trim() });
          }
        };
        child.stdout.on("data", onChunk);
        child.stderr.on("data", onChunk);

        token.onCancellationRequested(() => {
          child.kill("SIGTERM");
          void vscode.window.showInformationMessage(`Yuhi: cancelled download of ${model}.`);
          resolve(false);
        });

        child.on("error", (err) => {
          void vscode.window.showErrorMessage(
            `Yuhi: could not run "ollama pull" — ${(err as Error).message}. Is Ollama installed and on your PATH?`,
          );
          resolve(false);
        });
        child.on("close", (code) => {
          if (token.isCancellationRequested) return; // already resolved
          if (code === 0) {
            resolve(true);
          } else {
            void vscode.window.showErrorMessage(
              `Yuhi: "ollama pull ${model}" failed (exit ${code}). ${stderrTail.trim().slice(-200)}`,
            );
            resolve(false);
          }
        });
      }),
  );
}

/** Generate a tiny local completion to confirm the model actually runs. */
async function smokeTest(root: string, model: string): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Yuhi: testing ${model}…` },
    async () => {
      try {
        const provider = createLocalModelProvider({ ...(await localModelConfig(root)), model });
        const out = await provider.generate("Reply with the single word: ready.", {
          maxTokens: 16,
          temperature: 0,
          timeoutMs: 60_000,
        });
        void vscode.window.showInformationMessage(
          `Yuhi: local model "${model}" is ready. (test reply: "${out.trim().slice(0, 40)}")`,
        );
      } catch (e) {
        void vscode.window.showWarningMessage(
          `Yuhi: "${model}" was saved, but the smoke test did not complete: ${errText(e)}`,
        );
      }
    },
  );
}

/** Persist the chosen model into yuhi.yaml, preserving comments. Creates config if missing. */
async function saveModelToConfig(root: string, model: string): Promise<void> {
  const configPath = path.join(root, CONFIG_FILENAME);
  if (!existsSync(configPath)) runInit(root);
  const raw = await readFile(configPath, "utf8");
  const doc = parseDocument(raw);
  if (doc.getIn(["local_model", "provider"]) === undefined)
    doc.setIn(["local_model", "provider"], DEFAULT_LOCAL_MODEL.provider);
  if (doc.getIn(["local_model", "endpoint"]) === undefined)
    doc.setIn(["local_model", "endpoint"], DEFAULT_LOCAL_MODEL.endpoint);
  if (doc.getIn(["local_model", "timeout_ms"]) === undefined)
    doc.setIn(["local_model", "timeout_ms"], DEFAULT_LOCAL_MODEL.timeoutMs);
  doc.setIn(["local_model", "model"], model);
  await writeFile(configPath, doc.toString(), "utf8");
}

// ---- prepare workspace ----
const PREPARATION_PHASES = ["discover", "scan", "prepare", "context", "verify"] as const;

export function preparationProgressUpdate(
  event: PreparationProgressEvent,
  previousTarget: number,
): { target: number; increment: number; message: string } {
  const phaseIndex = Math.max(0, PREPARATION_PHASES.indexOf(event.phase));
  const phaseSize = 100 / PREPARATION_PHASES.length;
  const fraction =
    event.total !== undefined && event.total > 0 && event.current !== undefined
      ? Math.min(1, Math.max(0, event.current / event.total))
      : 0;
  const target = Math.max(
    previousTarget,
    Math.min(100, phaseIndex * phaseSize + fraction * phaseSize),
  );
  const count =
    event.current !== undefined && event.total !== undefined
      ? ` · ${event.current.toLocaleString()}/${event.total.toLocaleString()}`
      : "";
  return {
    target,
    increment: Math.max(0, target - previousTarget),
    message:
      `Step ${phaseIndex + 1} of ${PREPARATION_PHASES.length} · ${event.label}${count}` +
      ` · ${event.elapsedSeconds}s · Yuhi is processing locally…`,
  };
}

/**
 * The Safety Mode selected in the workspace setting (`yuhi.safetyMode`). Validated
 * with `isSafetyMode`; falls back to the core default when unset/invalid.
 */
function currentSafetyMode(): SafetyMode {
  const raw = vscode.workspace.getConfiguration("yuhi").get<SafetyMode>("safetyMode");
  return isSafetyMode(raw) ? raw : DEFAULT_PREPARE_SAFETY_MODE;
}

/**
 * The v0.3.3 Context Compression options selected in the workspace settings
 * (`yuhi.compress` / `yuhi.tokenBudget`). `tokenBudget` is normalized so `0`
 * (the "no budget" default) and any non-positive/invalid value become `null`
 * (best-effort with no target) — matching what @yuhi/core expects. When compress
 * is off, NOTHING compression-related is threaded into the prepare call.
 */
/**
 * Lazily load the shipped `typescript-runtime.js` bundle and inject it for the core
 * structure compressor. Called ONLY when Context Compression is enabled, right before a
 * prepare — never at activation — so the ~9MB compiler is loaded on demand and only once
 * (even across multiple prepares). The require path is computed (`__dirname`) so esbuild
 * does not bundle the sibling chunk into extension.js. If the bundle is missing or corrupt
 * the global stays unset: the compressor reports `compressor-unavailable` and keeps files
 * FULL — never a crash and never an absolute path/error leaked into the public report.
 */
let typeScriptRuntimeLoaded = false;
function ensureTypeScriptRuntime(): void {
  if (typeScriptRuntimeLoaded) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const runtime = require(path.join(__dirname, "typescript-runtime.js"));
    (globalThis as { __yuhiTypeScriptRuntime?: unknown }).__yuhiTypeScriptRuntime =
      runtime?.default ?? runtime;
    typeScriptRuntimeLoaded = true;
  } catch {
    /* runtime bundle missing/corrupt → leave unset → compressor-unavailable → FULL */
  }
}

function currentCompressionOptions(): { compress: boolean; tokenBudget: number | null; compressionMode: "off" | "auto" | "on" } {
  const cfg = vscode.workspace.getConfiguration("yuhi");
  const rawMode = cfg.get<string>("compressionMode");
  const mode = rawMode === "off" || rawMode === "on" ? rawMode : "auto";
  const compress = mode !== "off";
  const rawBudget = cfg.get<number>("tokenBudget");
  const tokenBudget =
    typeof rawBudget === "number" && Number.isFinite(rawBudget) && rawBudget > 0
      && mode !== "off" ? Math.floor(rawBudget)
      : null;
  return { compress, tokenBudget, compressionMode: mode };
}

async function prepareWorkspaceForLaunch(
  root: string,
  excludeRelpaths: readonly string[] = [],
  safetyMode: SafetyMode = currentSafetyMode(),
  includeWithWarningRelpaths: readonly string[] = [],
): Promise<PrepareReport | undefined> {
  // Onboarding gates: config + local AI must be ready before preparing.
  if (!existsSync(path.join(root, CONFIG_FILENAME))) {
    const init = await vscode.window.showInformationMessage(
      "Set up this folder for Claude Code with Yuhi?",
      {
        modal: true,
        detail:
          "Yuhi needs a yuhi.yaml policy before it can prepare the initial context. " +
          "Initialize creates the local policy file in the selected source folder. Claude Code will not be opened in that source folder.",
      },
      "Initialize",
      "Cancel",
    );
    if (init !== "Initialize") return undefined;
    await initializeProject(root);
    if (!existsSync(path.join(root, CONFIG_FILENAME))) return undefined;
  }
  setStatus("preparing");
  activityProvider?.setPreparing(true);
  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Preparing with Yuhi",
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({
          message: "Yuhi is preparing your workspace locally before Claude Code opens.",
        });
        const provider = await buildProvider(root);
        const controller = new AbortController();
        activePrepareController = controller;
        token.onCancellationRequested(() => controller.abort());
        const startedAt = Date.now();
        let currentPhase = "Discovering files";
        let hasStructuredProgress = false;
        let creditedProgress = 0;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        let longRunningNotice: ReturnType<typeof setTimeout> | undefined;
        let sixtySecondNotice: ReturnType<typeof setTimeout> | undefined;
        let elapsedNotice: ReturnType<typeof setInterval> | undefined;
        try {
          elapsedNotice = setInterval(() => {
            const seconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
            progress.report({
              message: `${currentPhase} · ${seconds}s elapsed · Yuhi is processing locally…`,
            });
          }, 5_000);
          longRunningNotice = setTimeout(() => {
            progress.report({
              message:
                `${currentPhase} · Yuhi preparation is still running. Large workspaces may take longer.`,
            });
          }, 20_000);
          sixtySecondNotice = setTimeout(() => {
            progress.report({
              message:
                "Yuhi is still preparing your workspace. No files have been sent to Claude Code yet.",
            });
          }, 60_000);
          const { compress, tokenBudget, compressionMode } = currentCompressionOptions();
          const decisionConfig = vscode.workspace.getConfiguration("yuhi");
          const includeWithWarningExtensions =
            decisionConfig.get<string[]>("alwaysIncludeWarningExtensions") ?? [];
          const excludeExtensions = decisionConfig.get<string[]>("alwaysExcludeExtensions") ?? [];
          // Load the shipped TypeScript runtime ONLY when compression will actually run.
          if (compress) ensureTypeScriptRuntime();
          const preparation = prepareWorkspaceOutcome(root, {
            provider,
            safetyMode,
            // v0.3.3 opt-in Context Compression. Threaded exactly like safetyMode:
            // only sent when the user enabled `yuhi.compress`; the token budget is
            // omitted (best-effort, no target) when `yuhi.tokenBudget` is 0/none.
            ...(compress ? { compress: true } : {}),
            compressionMode,
            ...(compress && tokenBudget !== null ? { tokenBudget } : {}),
            deferDocumentInspection: true,
            // v0.3.3 — the foreground (launch) prepare makes ZERO local-model
            // summarize calls: Ollama never runs on the critical path, so a slow or
            // stalled model can't delay Yuhi Mode. Files that would need local
            // summarization are kept LOCAL (reason: local-summary-deferred) and NOT
            // shared — they are not auto-processed later in this version. Connecting
            // these to a background worker is the first task of v0.3.4. The per-file
            // timeout / budget / circuit-breaker in core are the reliability machinery
            // that background work will reuse.
            deferLocalSummary: true,
            signal: controller.signal,
            onProgress: (msg) => {
              currentPhase = msg;
              if (!hasStructuredProgress) {
                progress.report({ message: `${msg} · Yuhi is processing locally…` });
              }
            },
            onProgressDetail: (event) => {
              hasStructuredProgress = true;
              currentPhase = event.label;
              const update = preparationProgressUpdate(event, creditedProgress);
              creditedProgress = update.target;
              progress.report({
                increment: update.increment,
                message: update.message,
              });
              // Drive the big, live progress in the sidebar panel too, so the user
              // sees continuous activity — not just the small notification toast.
              const stepIndex = Math.max(0, PREPARATION_PHASES.indexOf(event.phase));
              activityProvider?.setPreparing(true, {
                percent: update.target,
                stepIndex,
                stepTotal: PREPARATION_PHASES.length,
                phaseLabel: event.label,
                ...(event.current !== undefined ? { current: event.current } : {}),
                ...(event.total !== undefined ? { total: event.total } : {}),
                elapsedSeconds: event.elapsedSeconds,
              });
            },
            excludeRelpaths,
            includeWithWarningRelpaths,
            includeWithWarningExtensions,
            excludeExtensions,
          });
          activePrepareDone = preparation.then(() => undefined, () => undefined);
          const outcome = await Promise.race([
            preparation,
            new Promise<never>((_resolve, reject) => {
              watchdog = setTimeout(() => {
                controller.abort();
                reject(new Error("Yuhi preparation watchdog timeout."));
              }, PREPARATION_WATCHDOG_MS);
            }),
          ]);
          if (outcome.kind === "cancelled") {
            setStatus("ready");
            void vscode.window.showInformationMessage(
              "Yuhi preparation was cancelled. No files were sent to Claude Code. You can start again at any time.",
              "Start Again",
            ).then((choice) => {
              if (choice === "Start Again") void vscode.commands.executeCommand("yuhi.restartFlow");
            });
            return undefined;
          }
          // v0.3.5 — background document preparation NO LONGER runs on this (source)
          // prepare path. It is started fire-and-forget AFTER Yuhi Mode is ready, in the
          // opened Prepared Workspace window (see startProgressiveContext), and the panel
          // is driven honestly from the PUBLIC status file — never blocking launch.
          progress.report({
            increment: Math.max(0, 100 - creditedProgress),
            message: "Preparation complete · Ready for review",
          });
          // Record the resolved Safety Mode this run actually prepared under so the
          // review can render the selector state + dirty banner (item 5).
          lastReportSafetyMode = safetyMode;
          return outcome.report;
        } finally {
          if (watchdog) clearTimeout(watchdog);
          if (longRunningNotice) clearTimeout(longRunningNotice);
          if (sixtySecondNotice) clearTimeout(sixtySecondNotice);
          if (elapsedNotice) clearInterval(elapsedNotice);
          if (activePrepareController === controller) activePrepareController = undefined;
          activePrepareDone = undefined;
        }
      },
    );
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      setStatus("ready");
      void vscode.window.showInformationMessage("Yuhi: preparation cancelled.");
      return undefined;
    }
    throw e;
  }
}

/** Real-run detail for the activity panel (document counts + prepared output dir). */
function activityDetail(report: PrepareReport, backgroundActive = false): PreparedDetail {
  const a = report.tabularAcceptance;
  const documentsInspected =
    (a?.pdfInspected ?? 0) + (a?.ocrProcessed ?? 0) + (a?.textDocumentsInspected ?? 0);
  return {
    outDir: report.outDir,
    documentsInspected,
    summariesRejected: a?.documentSummariesRejected ?? 0,
    ...(report.publicSummary ? { publicSummary: report.publicSummary } : {}),
    ...(report.yuhiModeSummary ? { yuhiModeSummary: report.yuhiModeSummary } : {}),
    ...(report.compression
      ? {
          compression: {
            tokenBudget: report.compression.targetBudget,
            preparedTokens: report.compression.preparedTokens,
            status: report.compression.status,
          },
        }
      : {}),
    ...(backgroundActive ? { backgroundActive: true } : {}),
  };
}

/**
 * v0.3.5 Progressive Context host wiring. Every displayed number comes from the
 * PUBLIC status file (`<preparedDir>/.yuhi/background-status.json`); the PRIVATE
 * queue state (the internal background root under the managed base) is NEVER read
 * here. `readStatus` is the ONLY background surface this extension reads.
 */
function buildProgressiveContextController(
  provider?: LocalModelProvider,
): ProgressiveContextController {
  return new ProgressiveContextController({
    runBackground: (input) =>
      runBackgroundForRun({
        runId: input.runId,
        preparedDir: input.preparedDir,
        signal: input.signal,
        ...(provider ? { providerFactory: () => provider } : {}),
        pdfTextExtractor: localPdfTextExtractor,
        ocrExtractor: localPdfOcrExtractor,
      }),
    cancelBackground: (input) =>
      requestBackgroundCancel({ runId: input.runId, preparedDir: input.preparedDir }),
    // SECURITY BOUNDARY: read ONLY the public status file — never the private queue.
    readStatus: (preparedDir) => readPublicStatus(preparedDir),
    computeRevision: ({ baseContextId, status }) =>
      reduceProgressiveContextState({
        baseContextId,
        // Project the path-safe public items into the reducer's public-item shape.
        backgroundItems: status.items.map((item) => ({
          itemId: "",
          runId: "",
          contextId: baseContextId,
          // The revision is derived from PUBLISHED artifacts; a withheld original has
          // no agent-visible path, so its public identity stands in for one.
          relpath: item.relpath ?? item.documentId ?? item.displayName ?? "",
          kind: item.kind,
          priority: 0,
          createdAt: 0,
          status: item.status,
          ...(item.preparedRelpath ? { preparedRelpath: item.preparedRelpath } : {}),
        })),
      }),
    recordRevision: (preparedDir, state) => recordContextRevision(preparedDir, state),
    onView: (view) => {
      activityProvider?.applyProgressiveContext(view);
      const preparedDir = lastReport?.outDir;
      if (preparedDir) {
        void readFile(path.join(preparedDir, ".yuhi", "yuhi-mode-summary.json"), "utf8")
          .then((raw) => activityProvider?.applyYuhiModeSummary(JSON.parse(raw)))
          .catch(() => {});
      }
    },
  });
}

function execFileText(
  command: string,
  args: string[],
  options: { signal?: AbortSignal; maxBuffer?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

/** Local-only text-layer extraction. No document bytes or output leave the machine. */
async function localPdfTextExtractor(absPath: string): Promise<{ text: string; method: "pdf-text"; pageCount?: number }> {
  const text = await execFileText("pdftotext", ["-layout", absPath, "-"]).catch(() => "");
  const pageCount = text ? text.split("\f").length : undefined;
  return { text, method: "pdf-text", ...(pageCount ? { pageCount } : {}) };
}

/** Local OCR fallback. Rendered pages live in a private temporary dir and are removed. */
async function localPdfOcrExtractor(absPath: string): Promise<{ text: string; method: "ocr"; pageCount?: number }> {
  const temp = await mkdtemp(path.join(tmpdir(), "yuhi-ocr-"));
  try {
    const prefix = path.join(temp, "page");
    await execFileText("pdftoppm", ["-f", "1", "-l", "50", "-png", "-r", "150", absPath, prefix]);
    const pages = (await readdir(temp)).filter((name) => name.endsWith(".png")).sort();
    const texts: string[] = [];
    for (const page of pages) {
      const file = path.join(temp, page);
      const text = await execFileText("tesseract", [file, "stdout", "-l", "eng+jpn"])
        .catch(() => execFileText("tesseract", [file, "stdout", "-l", "eng"]));
      texts.push(text);
    }
    return { text: texts.join("\f"), method: "ocr", pageCount: pages.length };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * Record the USED Context Revision into the session manifest (`.yuhi/session.json`).
 * Best-effort and path-safe: it only stores the base Context ID, the revision number,
 * the deterministic revisionId, and a timestamp. Keeps the SAME baseContextId.
 */
async function recordContextRevision(
  preparedDir: string,
  state: ProgressiveContextState,
): Promise<void> {
  const target = path.join(preparedDir, ".yuhi", "session.json");
  try {
    const raw = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
    raw.contextRevision = {
      baseContextId: state.baseContextId,
      revision: state.revision,
      revisionId: state.revisionId,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(target, JSON.stringify(raw, null, 2) + "\n", "utf8");
  } catch {
    // A missing/locked session file must never break the Refresh action.
  }
}

/**
 * Start (or resume) Progressive Context for an opened Prepared Workspace window, AFTER
 * Yuhi Mode is ready. Fire-and-forget: the worker never blocks launch, and the panel is
 * driven by polling the PUBLIC status file (so it survives a reload). Idempotent — a
 * second call supersedes the previous controller.
 */
function startProgressiveContext(
  report: PrepareReport,
  filesAvailable: number,
  provider?: LocalModelProvider,
): void {
  stopProgressiveContext();
  const controller = buildProgressiveContextController(provider);
  progressiveController = controller;
  controller.start({
    runId: report.runId,
    preparedDir: report.outDir,
    baseContextId: report.contextId ?? "",
    filesAvailable,
    startWorker: true,
  });
  // Poll the public status so live progress is honest and survives a reload. Stops once
  // a terminal status has been observed (the worker's own final write still lands).
  let sawWork = false;
  let ticks = 0;
  progressivePoll = setInterval(() => {
    ticks += 1;
    void controller.refreshFromDisk().then(() => {
      if (controller.currentView()) sawWork = true;
      const settled = sawWork && !controller.isRunning();
      if (settled || ticks > 400) stopProgressiveContextPollOnly();
    });
  }, 1_500);
}

/** Stop only the poll timer (the controller keeps its last view). */
function stopProgressiveContextPollOnly(): void {
  if (progressivePoll) {
    clearInterval(progressivePoll);
    progressivePoll = undefined;
  }
}

/** Tear down Progressive Context entirely (abort the worker + stop polling). */
function stopProgressiveContext(): void {
  stopProgressiveContextPollOnly();
  progressiveController?.dispose();
  progressiveController = undefined;
}

/**
 * Panel "Cancel background processing" → persist the cancel request + abort the local
 * worker. The panel returns to a usable state (never stuck), and polling stops.
 */
async function commandCancelBackground(): Promise<void> {
  const controller = progressiveController;
  if (!controller) return;
  await controller.cancel();
  stopProgressiveContextPollOnly();
}

/**
 * Panel "Refresh Context" → recompute the delivered revision from the PUBLIC status
 * with the SAME baseContextId, record it in the session manifest, and update the shown
 * Context Revision. Never re-scans or re-prepares.
 */
async function commandRefreshContext(): Promise<void> {
  await progressiveController?.refresh();
}

async function commandPrepare(target?: vscode.Uri): Promise<void> {
  if (currentIsPreparedWorkspace || reviewingOpenedPreparedWorkspace) {
    const root = firstWorkspaceRoot();
    if (root) await showPreparedWorkspaceRecovery(root);
    return;
  }
  const start = target?.fsPath ?? firstWorkspaceRoot();
  if (!start) {
    void vscode.window.showInformationMessage("Yuhi: open a folder to prepare.");
    return;
  }
  const root = resolveConfigDir(start);
  if (!root) {
    void vscode.window.showInformationMessage("Yuhi: could not locate a workspace to prepare.");
    return;
  }

  try {
    const report = await prepareWorkspaceForLaunch(root);
    if (!report) return;

    lastReport = report;
    lastReportRoot = root;
    activityProvider?.setPrepared(buildPreparedMetrics(report), undefined, true, activityDetail(report));

    // Outcome: Complete / Complete with warnings / Partial / Failed (failures visible).
    const outcome = classifyOutcome(report);
    setStatus(outcome === "Failed" ? "failed" : "ready-for-review");
    // v0.3.4 — offer the agent picker (Claude Code / Codex) on the Ready surface,
    // reusing this one prepared run. Availability is resolved with a short timeout.
    if (outcome !== "Failed") void refreshAgentPicker();

    if (outcome === "Failed") {
      void vscode.window
        .showErrorMessage(
          "Yuhi: preparation Failed — no files could be prepared. Nothing is ready to send. Run Doctor for the reason.",
          "Run Doctor",
        )
        .then((c) => {
          if (c === "Run Doctor") void vscode.commands.executeCommand("yuhi.doctor");
        });
      return;
    }

    // Success (incl. Partial): open Context Savings automatically, then offer next actions.
    await commandReview();

    const pct = Math.round(report.report.percentReduction * 100);
    const avoided = report.report.tokensSaved.toLocaleString();
    const errs = report.errors.length;
    const blocked = report.blocked.length;
    const warn =
      (errs > 0 ? ` · ${errs} failed` : "") + (blocked > 0 ? ` · ${blocked} kept back by safety check` : "");
    const summary = `Yuhi: ${outcome} · Estimated Claude input avoided ~${avoided} tokens (${pct}%) · source files modified: 0${warn}.`;
    const NEXT = ["Review Prepared Context", "Open Prepared Workspace", "Copy Prepared Path", "Run Again"];
    const choice =
      outcome === "Partial"
        ? await vscode.window.showWarningMessage(summary, ...NEXT)
        : await vscode.window.showInformationMessage(summary, ...NEXT);
    if (choice === "Review Prepared Context") await commandReview();
    else if (choice === "Open Prepared Workspace")
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(report.outDir));
    else if (choice === "Copy Prepared Path") {
      await vscode.env.clipboard.writeText(report.outDir);
      void vscode.window.showInformationMessage("Yuhi: prepared path copied to clipboard.");
    } else if (choice === "Run Again") await commandPrepare();
  } catch (e) {
    setStatus("failed");
    void vscode.window.showErrorMessage(`Yuhi: preparation failed — ${errText(e)}`, "Run Doctor").then((c) => {
      if (c === "Run Doctor") void vscode.commands.executeCommand("yuhi.doctor");
    });
  }
}

function launchHost(): LaunchHost {
  return {
    openFolder: async (folderPath, newWindow) => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Opening Claude Code",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "Opening Claude Code in the Prepared Workspace." });
          await vscode.commands.executeCommand(
            "vscode.openFolder",
            vscode.Uri.file(folderPath),
            newWindow,
          );
        },
      );
    },
    isExtensionInstalled: (id) => vscode.extensions.getExtension(id) !== undefined,
    createTerminal: (name, cwd) => vscode.window.createTerminal({ name, cwd }),
    openExternal: async (url) => await vscode.env.openExternal(vscode.Uri.parse(url)),
    showInfo: async (message, ...actions) => await vscode.window.showInformationMessage(message, ...actions),
    showWarning: async (message, ...actions) => await vscode.window.showWarningMessage(message, ...actions),
    showError: async (message, ...actions) => await vscode.window.showErrorMessage(message, ...actions),
  };
}

async function rememberReport(root: string): Promise<PrepareReport | undefined> {
  const report = await prepareWorkspaceForLaunch(root);
  if (report) {
    agentSessionStarted = false;
    lastReport = report;
    lastReportRoot = root;
    activityProvider?.setPrepared(buildPreparedMetrics(report), undefined, true, activityDetail(report));
    setStatus("ready-for-review");
    await extensionContext?.globalState.update(LAST_ORIGINAL_WORKSPACE_KEY, root);
    sourceAgentChangeWatcher?.dispose();
    sourceAgentChangeWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(report.outDir, "**/*"),
    );
    const changed = (uri: vscode.Uri) => {
      if (!agentSessionStarted || agentReviewMutationRunning || Date.now() < suppressAgentWatcherUntil) return;
      const relpath = path.relative(report.outDir, uri.fsPath).split(path.sep).join("/");
      if (
        relpath === "manifest.json" || relpath === "CLAUDE.md" || relpath === "AGENTS.md" ||
        relpath.startsWith(".yuhi/") ||
        relpath.startsWith(".claude/") ||
        relpath.startsWith(".vscode/")
      ) return;
      setStatus("agent-changes");
      activityProvider?.setAgentChangesDetected();
    };
    extensionContext?.subscriptions.push(
      sourceAgentChangeWatcher,
      sourceAgentChangeWatcher.onDidCreate(changed),
      sourceAgentChangeWatcher.onDidChange(changed),
      sourceAgentChangeWatcher.onDidDelete(changed),
    );
  }
  return report;
}

async function currentPreparedRunId(root: string): Promise<string | undefined> {
  try {
    const session = JSON.parse(
      await readFile(path.join(root, ".yuhi", "session.json"), "utf8"),
    ) as { runId?: unknown };
    return typeof session.runId === "string" ? session.runId : undefined;
  } catch {
    return undefined;
  }
}

async function commandReviewAgentChanges(): Promise<void> {
  const activeRoot = firstWorkspaceRoot();
  const preparedRoot = activeRoot && isManagedYuhiWorkspace(activeRoot)
    ? activeRoot
    : lastReport?.outDir;
  if (!preparedRoot || !extensionContext) {
    await vscode.window.showWarningMessage(
      "Prepare and launch an agent with Yuhi before reviewing changes.",
    );
    return;
  }
  const runId = await currentPreparedRunId(preparedRoot) ?? lastReport?.runId;
  if (!runId) {
    await vscode.window.showWarningMessage(
      "Yuhi cannot find the pre-agent baseline for this run. Apply is unavailable.",
    );
    return;
  }
  let state: PrivatePatchSessionState;
  try {
    state = await loadPatchSession(managedWorkspaceBaseDir(), runId);
  } catch {
    await vscode.window.showWarningMessage(
      "Yuhi cannot find the private pre-agent snapshot for this run. Start the agent from Yuhi and try again.",
    );
    return;
  }
  let review = await reviewPatchSession(state);
  if (!agentReviewPanel) {
    agentReviewPanel = vscode.window.createWebviewPanel(
      "yuhi.agentChanges",
      "Claude Code with Yuhi — Changes",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    agentReviewPanel.onDidDispose(() => {
      agentReviewPanel = undefined;
    });
    agentReviewPanel.webview.onDidReceiveMessage((message) => {
      void handleAgentReviewMessage(message, state, preparedRoot, review);
    });
  }
  const agentName = review.patch.agentId === "codex" ? "Codex" : "Claude Code";
  agentReviewPanel.webview.html = renderAgentChangeReviewHtml(review, agentName);
  agentReviewPanel.reveal();
}

async function handleAgentReviewMessage(
  message: { type?: unknown; relpaths?: unknown; hunkSelections?: unknown },
  state: PrivatePatchSessionState,
  preparedRoot: string,
  currentReview: PatchReviewResult,
): Promise<void> {
  if (message.type === "stopYuhi") {
    agentReviewPanel?.dispose();
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(state.sourceRoot),
      false,
    );
    return;
  }
  if (message.type === "switchWorkspace") {
    agentReviewPanel?.dispose();
    if (extensionContext) await commandRestartFlow(extensionContext);
    return;
  }
  if (message.type === "discard") {
    const choice = await vscode.window.showWarningMessage(
      `Discard ${currentReview.changes.length} agent change(s) and restore the Prepared Workspace baseline?`,
      { modal: true },
      "Discard Changes",
    );
    if (choice !== "Discard Changes") return;
    const baselineRoot = path.join(
      privatePatchSessionDir(managedWorkspaceBaseDir(), state.runId, state.sessionId),
      "prepared-baseline",
    );
    agentReviewMutationRunning = true;
    try {
      await discardPreparedChanges(preparedRoot, baselineRoot, currentReview.changes);
    } finally {
      agentReviewMutationRunning = false;
      suppressAgentWatcherUntil = Date.now() + 1_000;
    }
    activityProvider?.clearAgentChangesDetected();
    agentReviewPanel?.dispose();
    await vscode.window.showInformationMessage(
      "Yuhi discarded the agent changes. Published background context was preserved.",
    );
    return;
  }
  if (message.type === "diff") {
    const picked = await vscode.window.showQuickPick(
      currentReview.changes
        .filter((change) =>
          change.kind !== "deleted" &&
          change.applyEligibility !== "blocked" &&
          !change.reasonCodes.includes("patch-pii-added"),
        )
        .map((change) => ({ label: change.relpath, change })),
      { title: "Open an agent change diff" },
    );
    if (!picked) return;
    const diff = currentReview.diffsByRelpath[picked.change.relpath];
    if (!diff) {
      await vscode.window.showWarningMessage("Yuhi could not create a metadata-safe diff for this change.");
      return;
    }
    const prepared = await vscode.workspace.openTextDocument({ content: diff.after });
    if (picked.change.kind === "added") {
      await vscode.window.showTextDocument(prepared, { preview: true });
    } else {
      const original = await vscode.workspace.openTextDocument({ content: diff.before });
      await vscode.commands.executeCommand(
        "vscode.diff",
        original.uri,
        prepared.uri,
        `Prepared baseline ↔ Agent · ${picked.change.relpath}`,
      );
    }
    return;
  }
  if (message.type !== "apply") return;
  const selected = Array.isArray(message.relpaths)
    ? message.relpaths.filter((value): value is string => typeof value === "string")
    : [];
  const fresh = await reviewPatchSession(state);
  const applicable = selectedApplicableChanges(fresh, selected);
  if (applicable.length === 0) {
    agentReviewPanel!.webview.html = renderAgentChangeReviewHtml(
      fresh,
      fresh.patch.agentId === "codex" ? "Codex" : "Claude Code",
    );
    await vscode.window.showWarningMessage("Select at least one eligible reviewed change to apply.");
    return;
  }
  const hunkSelections: Record<string, string[]> = {};
  if (message.hunkSelections && typeof message.hunkSelections === "object") {
    for (const [relpath, ids] of Object.entries(message.hunkSelections)) {
      if (!selected.includes(relpath) || !Array.isArray(ids)) continue;
      hunkSelections[relpath] = ids.filter((id): id is string => typeof id === "string");
    }
  }
  const choice = await vscode.window.showWarningMessage(
    `Apply ${applicable.length} selected reviewed agent change(s) to the Original Workspace?`,
    {
      modal: true,
      detail:
        "Yuhi rescanned the exact prepared output and checked the Original Workspace for conflicts. " +
        "No change is applied without this confirmation.",
    },
    "Apply Changes",
    "Cancel",
  );
  if (choice !== "Apply Changes") return;
  agentReviewMutationRunning = true;
  const result = await applyPatchSession({
    managedBase: managedWorkspaceBaseDir(),
    runId: state.runId,
    sessionId: state.sessionId,
    selectedRelpaths: selected,
    hunkSelections,
    expectedPatchId: fresh.patch.patchId,
    expectedSnapshotId: fresh.snapshotId,
    expectedSourceBaselineId: fresh.patch.sourceBaselineId,
    expectedPreparedWorkingTreeId: fresh.preparedWorkingTreeId,
  }).catch(() => undefined).finally(() => { agentReviewMutationRunning = false; });
  if (!result) {
    const updated = await reviewPatchSession(state);
    agentReviewPanel!.webview.html = renderAgentChangeReviewHtml(
      updated,
      updated.patch.agentId === "codex" ? "Codex" : "Claude Code",
    );
    await vscode.window.showErrorMessage(
      "Apply blocked. The reviewed files changed or no longer pass Yuhi security checks. Refresh Review Agent Changes and try again.",
    );
    return;
  }
  if (result.status !== "applied") {
    const updated = await reviewPatchSession(state);
    agentReviewPanel!.webview.html = renderAgentChangeReviewHtml(
      updated,
      updated.patch.agentId === "codex" ? "Codex" : "Claude Code",
    );
    if (result.recoveryRequired) {
      await vscode.window.showErrorMessage(
        "Apply recovery required. Yuhi retained local recovery material and did not report success. Review the Original Workspace before retrying.",
      );
    } else if (result.rolledBack.length > 0) {
      await vscode.window.showWarningMessage(
        "Apply failed, and Yuhi restored and verified all completed mutations. Run Review Agent Changes again before retrying.",
      );
    } else {
      await vscode.window.showErrorMessage(
        "Apply blocked. The Original Workspace changed or the output did not pass Yuhi security checks.",
      );
    }
    return;
  }
  agentReviewPanel?.dispose();
  activityProvider?.clearAgentChangesDetected();
  const blockedCount = fresh.changes.filter((change) => change.applyEligibility === "blocked").length;
  const skippedCount = fresh.changes.length - applicable.length - blockedCount;
  const next = await vscode.window.showInformationMessage(
    `${result.applied.length} files applied safely · ${skippedCount} skipped · ${blockedCount} blocked.`,
    "Open Source Repository",
    "Undo Patch",
  );
  if (next === "Open Source Repository") {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(state.sourceRoot), false);
  } else if (next === "Undo Patch") {
    const undone = await undoPatch(
      path.join(managedWorkspaceBaseDir(), ".internal"),
      result.patchId,
    );
    if (undone.status === "undone") {
      await vscode.window.showInformationMessage(`Yuhi safely undid ${undone.applied.length} applied change(s).`);
    } else {
      await vscode.window.showWarningMessage(
        "Undo blocked because the Original Workspace changed after Apply. Review it before retrying.",
      );
    }
  }
}

async function confirmPreparedLaunch(
  summary: ReturnType<typeof buildSummary>,
  primary: string,
): Promise<"open" | "review" | "cancel"> {
  const title =
    primary === "Open with Claude Code"
      ? "Open this Yuhi Prepared Workspace with Claude Code?"
      : "Open this Yuhi Prepared Workspace in a new window?";
  const choice = await vscode.window.showInformationMessage(
    title,
    {
      modal: true,
      detail:
        "Prepared by Yuhi\n\n" +
        formatSummaryDetail(summary) +
        "\n\nYuhi has prepared the initial context, but does not currently restrict Claude Code's filesystem access after launch." +
        "\n\nEstimated from the Prepared Workspace content. Actual model input usage may differ because agents add system prompts, tool output, cached context, and conversation history.",
    },
    primary,
    "Review Prepared Context",
    "Cancel",
  );
  if (choice === primary) return "open";
  if (choice === "Review Prepared Context") return "review";
  return "cancel";
}

async function confirmHighRiskOverride(count: number): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    "Yuhi found unresolved high-risk values",
    {
      modal: true,
      detail:
        `${count} high-risk finding(s) would be included unchanged. ` +
        "Review the file decisions before continuing. This exception will be recorded in the local launch audit.",
    },
    "Override and continue",
    "Cancel",
  );
  return choice === "Override and continue";
}

async function commandPrepareAndOpen(): Promise<void> {
  if (reviewingOpenedPreparedWorkspace) {
    await commandPrepare();
    return;
  }
  const host = launchHost();
  await runPrepareAndOpen({
    host,
    getWorkspaceRoot: firstWorkspaceRoot,
    prepare: rememberReport,
    reviewBlocked: () => commandReview(),
    confirmHighRiskOverride,
    confirmOpen: async (summary) => {
      while (true) {
        const choice = await confirmPreparedLaunch(summary, "Open Prepared Workspace");
        if (choice === "review") {
          await commandReview();
          continue;
        }
        return choice === "open";
      }
    },
  });
}

type YuhiLaunchTargetId = "claude-vscode" | "claude-cli" | "codex" | "gemini" | "qwen";
interface YuhiLaunchTarget {
  id: YuhiLaunchTargetId;
  mode: ClaudeMode;
  label: string;
  command?: string;
  available: boolean;
}

/** Choose the actual agent surface BEFORE preparation starts. Detection is local and
 * bounded: VS Code extension registration plus synchronous PATH lookup only. */
async function pickYuhiLaunchTarget(
  context: vscode.ExtensionContext,
): Promise<YuhiLaunchTarget | undefined> {
  const previous = context.globalState.get<YuhiLaunchTargetId>(
    "yuhi.launchTarget",
    "claude-vscode",
  );
  const targets: YuhiLaunchTarget[] = [
    {
      id: "claude-vscode",
      mode: "extension",
      label: "Claude Code — VS Code extension",
      available: vscode.extensions.getExtension("anthropic.claude-code") !== undefined,
    },
    { id: "claude-cli", mode: "cli", label: "Claude Code — CLI", command: "claude", available: lookupOnPath("claude") !== null },
    { id: "codex", mode: "cli", label: "OpenAI Codex — CLI", command: "codex", available: lookupOnPath("codex") !== null },
    { id: "gemini", mode: "cli", label: "Gemini — CLI", command: "gemini", available: lookupOnPath("gemini") !== null },
    { id: "qwen", mode: "cli", label: "Qwen Code — CLI", command: "qwen", available: lookupOnPath("qwen") !== null },
  ];
  const items = targets.map((target) => ({
    label: target.available ? `$(check) ${target.label}` : `$(circle-slash) ${target.label}`,
    description: target.id === previous ? "Last used" : target.available ? "Installed" : "Not detected",
    detail: target.available
      ? target.mode === "extension"
        ? "Opens in the Yuhi Prepared Workspace window."
        : "Runs in a terminal with the Yuhi Prepared Workspace as its working directory."
      : "This target is not currently installed or available on PATH.",
    target,
  }));
  while (true) {
    const picked = await vscode.window.showQuickPick(items, {
      title: "Start an AI agent with Yuhi",
      placeHolder: "Choose an installed agent before Yuhi prepares the workspace",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return undefined;
    if (!picked.target.available) {
      await vscode.window.showWarningMessage(`${picked.target.label} is not installed or could not be detected.`);
      continue;
    }
    await context.globalState.update("yuhi.launchTarget", picked.target.id);
    return picked.target;
  }
}

async function sourceWorkspaceForClaudeLaunch(
  title = "Choose a folder to prepare with Yuhi",
  openLabel = "Prepare this folder",
  allowFromPreparedWorkspace = false,
): Promise<string | undefined> {
  const openRoot = firstWorkspaceRoot();
  if (openRoot && isManagedYuhiWorkspace(openRoot) && !allowFromPreparedWorkspace) {
    await showPreparedWorkspaceRecovery(openRoot);
    return undefined;
  }
  const selected = await vscode.window.showOpenDialog({
    title,
    openLabel,
    ...(!reviewingOpenedPreparedWorkspace && openRoot
      ? { defaultUri: vscode.Uri.file(openRoot) }
      : {}),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  if (!selected?.[0]) {
    await vscode.window.showInformationMessage(
      "Yuhi did not start because no source folder was selected.",
    );
    return undefined;
  }
  const selectedRoot = path.resolve(selected[0].fsPath);
  if (isManagedYuhiWorkspace(selectedRoot)) {
    await vscode.window.showErrorMessage(
      "Choose an original source folder, not a Yuhi Prepared Workspace.",
    );
    return undefined;
  }
  return selectedRoot;
}

async function startClaudeFromSourceWorkspace(
  context: vscode.ExtensionContext,
  sourceRoot: string,
  target: YuhiLaunchTarget,
): Promise<void> {
  const host = launchHost();
  await runPrepareAndStartClaude({
    host,
    getWorkspaceRoot: () => sourceRoot,
    prepare: rememberReport,
    reviewBlocked: () => commandReview(),
    // The user chose VS Code or CLI BEFORE preparation. Once the workspace is
    // launchable, preserve that choice and open Yuhi Mode directly — no second picker
    // or confirmation click after the potentially long preparation step.
    autoLaunch: true,
    pickMode: () => Promise.resolve(target.mode),
    resolveCliFile: () => target.command ? lookupOnPath(target.command) : null,
    confirmLaunch: (summary) => confirmPreparedLaunch(summary, "Open with Claude Code"),
    reviewDetails: () => commandReview(true),
    confirmHighRiskOverride,
  });
}

async function commandPrepareAndStartClaude(context: vscode.ExtensionContext): Promise<void> {
  const current = firstWorkspaceRoot();
  if (current && isManagedYuhiWorkspace(current)) {
    await showPreparedWorkspaceRecovery(current);
    return;
  }
  // Make the launch destination explicit before any preparation starts. This keeps
  // the workflow predictable: choose VS Code or CLI → choose source → prepare → open.
  const target = await pickYuhiLaunchTarget(context);
  if (!target) return;
  const sourceRoot = await sourceWorkspaceForClaudeLaunch();
  if (!sourceRoot) return;
  await startClaudeFromSourceWorkspace(context, sourceRoot, target);
}

async function commandOpenClaudeHere(): Promise<void> {
  const currentRoot = firstWorkspaceRoot();
  if (reviewingOpenedPreparedWorkspace && preparedSandboxVerified && currentRoot) {
    appendSafeRecoveryCheckpoint("state-validation-started", "open-claude");
    const state = await reconcilePreparedWorkspace(currentRoot, lastReport?.outDir);
    appendSafeRecoveryCheckpoint("state-validation-result", state.kind);
    if (state.kind === "recovery-required") {
      await showRecoveryRequired(state.reason, state.message);
      return;
    }
    await openClaudeInPreparedWorkspace();
    return;
  }
  // Prepared in THIS session from the original workspace (sidebar "Ready" → Start):
  // open the Prepared Workspace directly. File-level exclusions never block this —
  // only a genuine workspace-level failure does (handled inside the launch).
  if (lastReport && lastReportRoot && !currentIsPreparedWorkspace) {
    await launchPreparedReportFromReview(lastReportRoot, lastReport);
    return;
  }
  // The in-memory report is gone (e.g. after a window reload) but the panel still
  // shows Ready. Don't dead-end: re-prepare the current folder and auto-transition
  // straight into Yuhi Mode instead of showing a recovery wall.
  if (currentRoot && !isManagedYuhiWorkspace(currentRoot) && extensionContext) {
    const target = await pickYuhiLaunchTarget(extensionContext);
    if (!target) return;
    await startClaudeFromSourceWorkspace(extensionContext, currentRoot, target);
    return;
  }
  await showRecoveryRequired(
    recoveryReason ?? "unexpected-workspace",
    "Previous Prepared Workspace is no longer available",
  );
}

async function commandSwitchWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const target = await pickYuhiLaunchTarget(context);
  if (!target) return;
  const sourceRoot = await sourceWorkspaceForClaudeLaunch(
    "Switch Claude Code with Yuhi to another workspace",
    "Prepare and switch",
  );
  if (!sourceRoot) return;
  await startClaudeFromSourceWorkspace(context, sourceRoot, target);
}

async function commandExitYuhiWorkspace(): Promise<void> {
  if (!currentIsPreparedWorkspace) {
    await vscode.window.showInformationMessage(
      "This window is not a Yuhi Prepared Workspace.",
    );
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    "Exit this Yuhi Prepared Workspace?",
    {
      modal: true,
      detail:
        "Claude Code with Yuhi will stop in this window. The generated Prepared Workspace remains local until you remove it separately.",
    },
    "Exit Yuhi Workspace",
    "Cancel",
  );
  if (choice !== "Exit Yuhi Workspace") return;
  await vscode.commands.executeCommand("workbench.action.closeFolder");
}

async function commandRestartFlow(context: vscode.ExtensionContext): Promise<void> {
  if (restartFlowRunning) {
    await vscode.window.showInformationMessage("Yuhi is already recovering. Follow the active folder picker or progress.");
    return;
  }
  restartFlowRunning = true;
  try {
  activePrepareController?.abort();
  await activePrepareDone;
  pendingReviewDecision?.("cancel");
  pendingReviewDecision = undefined;
  reviewPanel?.dispose();
  reviewPanel = undefined;
  lastReport = undefined;
  lastReportRoot = undefined;
  visibleCommandRunning = false;
  setStatus("ready");
  activityProvider?.setNotPrepared();
  void vscode.window.showInformationMessage(
    "Yuhi flow reset. Choose the original source folder to start again.",
  );
  const sourceRoot = await sourceWorkspaceForClaudeLaunch(
    "Choose another Original Workspace",
    "Start with Yuhi",
    true,
  );
  if (sourceRoot) {
    const target = await pickYuhiLaunchTarget(context);
    if (target) await startClaudeFromSourceWorkspace(context, sourceRoot, target);
  }
  } finally {
    restartFlowRunning = false;
  }
}

async function commandOpenSourceWorkspace(): Promise<void> {
  const currentRunId = lastReport?.runId ??
    (firstWorkspaceRoot() ? await currentPreparedRunId(firstWorkspaceRoot()!) : undefined);
  if (await returnToOriginalWorkspace(currentRunId)) return;
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: "Choose the original source workspace",
    openLabel: "Open Source Workspace",
  });
  if (!selected?.[0]) {
    setStatus(recoveryReason ? "recovery-required" : "ready");
    return;
  }
  const selectedRoot = selected[0].fsPath;
  if (isManagedYuhiWorkspace(selectedRoot)) {
    await vscode.window.showErrorMessage(
      "Yuhi internal storage cannot be opened as a source workspace. Choose the original project folder.",
    );
    setStatus("recovery-required");
    return;
  }
  await vscode.commands.executeCommand("vscode.openFolder", selected[0], true);
}

async function commandDismissPreviousRun(): Promise<void> {
  lastReport = undefined;
  lastReportRoot = undefined;
  recoveryReason = undefined;
  reviewPanel?.dispose();
  reviewPanel = undefined;
  setStatus("ready");
  activityProvider?.setNotPrepared();
  await vscode.window.showInformationMessage(
    "Previous Yuhi run dismissed. Choose a source folder when you are ready.",
  );
}

async function runVisibleCommand(task: () => Promise<unknown>): Promise<void> {
  if (visibleCommandRunning) {
    await vscode.window.showInformationMessage(
      "Yuhi is already preparing or opening Claude Code. Follow the active Yuhi progress notification.",
    );
    return;
  }
  visibleCommandRunning = true;
  const startedAt = Date.now();
  appendSafeLaunchDiagnostic("post-prepare-validation", "started", 0);
  let retry = false;
  try {
    const result = await runVisibleLaunchCommand(task, async (message, kind, diagnostic) => {
      setStatus("failed");
      appendSafeLaunchDiagnostic(kind, "failed", Date.now() - startedAt);
      // Make the actual cause diagnosable in the LOCAL Output (redacted of the home
      // path) instead of leaving only an opaque category.
      if (diagnostic) yuhiOutput?.appendLine(`[prepare-error] ${kind}: ${diagnostic}`);
      // Modal so the recovery choices can't be missed or auto-dismissed. Retry is the
      // primary action; the user is never trapped on a failed run.
      const choice = await vscode.window.showErrorMessage(
        `${message} Error category: ${kind}.`,
        { modal: true, detail: diagnostic ? `Details: ${diagnostic}` : undefined },
        "Retry",
        "Switch Workspace",
        "View Yuhi Output",
      );
      if (choice === "View Yuhi Output") yuhiOutput?.show(true);
      else if (choice === "Switch Workspace") {
        // Never trap the user on a failed run — let them pick a different folder.
        void vscode.commands.executeCommand("yuhi.switchWorkspace");
      }
      retry = choice === "Retry";
    });
    if (result === "completed") {
      appendSafeLaunchDiagnostic("post-prepare-validation", "completed", Date.now() - startedAt);
    }
  } catch (error) {
    // Any unexpected throw (not a categorized VisibleLaunchError) must surface as a
    // visible message — never an unhandled rejection that looks like a crash.
    setStatus("failed");
    appendSafeLaunchDiagnostic("post-prepare-validation", "failed", Date.now() - startedAt);
    reportLaunchFailure(error);
  } finally {
    visibleCommandRunning = false;
  }
  if (retry) await runVisibleCommand(task);
}

function appendSafeLaunchDiagnostic(
  stage: VisibleLaunchFailureKind,
  result: "started" | "completed" | "failed",
  elapsedMs: number,
): void {
  yuhiOutput?.appendLine(
    JSON.stringify({
      runId: lastReport?.runId ?? "not-available",
      stage,
      errorCategory: result === "failed" ? stage : "none",
      elapsedMs,
      result,
    }),
  );
}

// ---- review prepared ----
function toReviewData(
  report: PrepareReport,
  root: string,
  preparedTree: string[],
  launchDecisionEnabled: boolean,
): ReviewData {
  const est = (chars: number) => Math.ceil(chars / 4); // matches @yuhi/shared estimateTokens heuristic
  const decisions = new Map(buildPreparedFileDecisions(report).map((d) => [d.relativePath, d]));
  let restrictedIndex = 0;
  let blockedIndex = 0;
  let unsupportedIndex = 0;
  const files = report.files.map((f: PreparedFileEntry) => {
    const d = decisions.get(f.relpath);
    const restricted = d?.sensitivityLevel === "Restricted";
    const blocked = f.status === "error" || f.status === "blocked";
    // Always show the user their OWN file name. The review panel is the user's own
    // local window; masking kept-local files to "Blocked file N" only hid which file
    // needed a decision. The filename is not the sensitive payload — the content is,
    // and content is never shown here.
    const displayPath = f.relpath;
    return {
      path: displayPath,
      action: f.action,
      status: f.status,
      omitted: !!f.omitted,
      beforeTokens: est(f.beforeChars),
      afterTokens: f.omitted ? 0 : est(f.afterChars),
      diffable:
        !restricted && !blocked && !reviewingOpenedPreparedWorkspace &&
        f.status === "ok" && !f.omitted,
      sensitivity: d?.sensitivityLevel ?? "Unknown",
      findingCategoryCounts: d?.findingCategoryCounts ?? {},
      findingCount: d?.findingCount ?? 0,
      rule: d?.matchedRule ?? "preparation result",
      reason: d?.reason ?? "",
      classificationSource: d?.classificationSource ?? "fallback",
      included: d?.included ?? false,
      claudeReceives: d?.agentReceives ?? "No",
      transformed: d?.transformed ?? false,
      transformations: d?.transformationKinds ?? [],
      unresolvedHighRiskCount: d?.unresolvedHighRiskCount ?? 0,
      outcome: d?.outcome ?? "failed",
      fileType: d?.fileType ?? "Unknown",
      ...(d?.failureCategory ? { failureCategory: d.failureCategory } : {}),
      inspectionStatus: d?.inspectionStatus ?? "Incomplete",
      limitationShown: d?.limitationShown ?? false,
      ...(f.inspection?.documentStatus
        ? { documentStatus: f.inspection.documentStatus }
        : {}),
      ...(f.inspection?.extractionMethod
        ? { extractionMethod: f.inspection.extractionMethod }
        : {}),
      ...(f.inspection?.pageCount !== undefined
        ? { pageCount: f.inspection.pageCount }
        : {}),
      ...(f.inspection?.summaryStatus
        ? { summaryStatus: f.inspection.summaryStatus }
        : {}),
      ...(f.inspection?.summaryRelpath
        ? { summaryRelpath: f.inspection.summaryRelpath }
        : {}),
      ...(f.inspection?.summaryStatus
        ? { summaryStatus: f.inspection.summaryStatus }
        : {}),
      ...(f.inspection?.summaryRelpath
        ? { summaryRelpath: f.inspection.summaryRelpath }
        : {}),
    };
  });
  const r = report.report;
  const metrics = buildPreparedMetrics(report);
  const safeSummary = buildSafePreparedRunSummary(report);
  const acceptance = report.tabularAcceptance ?? {
    entitiesPseudonymized: 0,
    identifierColumnsTransformed: 0,
    analyticalColumnsPreserved: 0,
    postTransformScanPassed: false,
    malformedTables: report.errors.filter((file) =>
      file.error?.startsWith("Malformed delimited table:")
    ).length,
    unverifiedTransformations: report.errors.filter((file) =>
      !file.error?.startsWith("Malformed delimited table:")
    ).length,
    rawFallbackUsed: false as const,
    launchAllowed: false,
    claudeCodeStarted: false as const,
    unsupportedOrUnverifiedFiles: 0,
    restrictedUnresolvedFiles: 0,
    hasLimitations: false,
    pdfInspected: 0,
    ocrProcessed: 0,
    unverifiedDocuments: 0,
    documentSummariesCreated: 0,
    documentSummariesRejected: 0,
    documentContextBeforeTokens: 0,
    documentContextAfterTokens: 0,
    textDocumentsInspected: 0,
    agentHandoffCreated: false,
    localModelRequests: 0,
    localModelSucceeded: 0,
    localModelFailed: 0,
    localModelInputChars: 0,
    localModelOutputChars: 0,
    localModelElapsedMs: 0,
    localModelMaxConcurrency: 0,
    localModelConfiguredParallelism: 0,
  };
  const projectFiles = files.filter((file) => file.included).map((file) => file.path).sort();
  const actualProjectFileSet = new Set(
    report.files.filter((file) => file.status === "ok" && !file.omitted).map((file) => file.relpath),
  );
  const metadataFiles = preparedTree.filter((file) => !actualProjectFileSet.has(file));
  return {
    launchDecisionEnabled:
      acceptance.launchAllowed &&
      !reviewingOpenedPreparedWorkspace &&
      (launchDecisionEnabled || !currentIsPreparedWorkspace),
    openClaudeHereEnabled:
      reviewingOpenedPreparedWorkspace && !launchDecisionEnabled && acceptance.launchAllowed,
    project: path.basename(root),
    agent: "Claude Code",
    // The Safety Mode / Context Detail THIS review was prepared under. v0.3 uses the
    // applied defaults; the *selectors* that let the user change them arrive in 2b-2b.
    // The webview labels these honestly as the applied defaults.
    safetyMode: DEFAULT_DISCLOSURE_SAFETY_MODE,
    contextDetail: DEFAULT_CONTEXT_DETAIL,
    // Real @yuhi/core Safety Mode for the selector + dirty-state. The prepared
    // run's mode is the one the extension passed to prepareWorkspace (fallback to
    // the current setting for older runs opened via activation).
    preparedSafetyMode: lastReportSafetyMode ?? currentSafetyMode(),
    selectedSafetyMode: currentSafetyMode(),
    runId: report.runId,
    outcome: classifyOutcome(report),
    osSandboxEnabled: false,
    outDir: "Yuhi-managed workspace",
    report: {
      beforeTokens: r.beforeTokens,
      afterTokens: r.afterTokens,
      tokensSaved: r.tokensSaved,
      percentReduction: r.percentReduction,
      hasData: r.hasData,
      filesExcluded: r.filesExcluded,
      filesSummarized: r.filesSummarized,
      sensitiveMasked: r.sensitiveMasked,
      sourceModified: report.sourceModified,
      approx: r.approx,
    },
    metrics,
    runtime: buildPreparedRuntimeBoundary(
      existsSync(path.join(report.outDir, CLAUDE_SANDBOX_RELPATH))
        ? "claude-code-sandbox"
        : "advisory",
    ),
    acceptance,
    files,
    projectFiles,
    metadataFiles,
    preparedTree: [...projectFiles, ...metadataFiles],
    // The shareable, PUBLIC-SAFE preparation report (aggregate numbers only) —
    // drives the "Repository Ready" card with copy/export. The v0.3.3 Context
    // Compression summary is a SEPARATE aggregate+relpath structure (present only
    // when the run was prepared with compress: true); it drives the review-only
    // Context Compression section and is NEVER routed into the public report bytes.
    preparationReport: safeSummary.preparationReport,
    ...(safeSummary.compression ? { compression: safeSummary.compression } : {}),
    // PDFs still queued for background inspection: "in progress", not failed.
    backgroundDocumentsPending: report.files.filter(
      (file) =>
        !file.omitted &&
        file.inspection?.fileType === "pdf" &&
        !file.inspection.documentStatus,
    ).length,
  };
}

async function listPreparedTree(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) {
      output.push(...(await listPreparedTree(root, absolute)));
    } else if (entry.isFile()) {
      output.push(relative);
    }
  }
  return output;
}

/** Turn any launch failure into a visible, actionable message — never a silent
 *  no-op or an unhandled rejection that can destabilize the extension host. */
function reportLaunchFailure(error: unknown): void {
  if (error instanceof DOMException && error.name === "AbortError") return;
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window
    .showErrorMessage(`Yuhi could not open Claude Code: ${message}`, "Run Doctor")
    .then((choice) => {
      if (choice === "Run Doctor") void vscode.commands.executeCommand("yuhi.doctor");
    });
}

async function launchPreparedReportFromReview(
  root: string,
  report: PrepareReport,
): Promise<void> {
  const outcome = classifyOutcome(report);
  // Visible diagnostic so a stuck launch is never a mystery: log the decision and,
  // when blocked, the exact files that caused it.
  const brokenIncluded = report.files.filter(
    (file) => !file.omitted && (file.status !== "ok" || file.transmission !== "approved"),
  );
  yuhiOutput?.appendLine(
    `[launch] outcome=${outcome} launchAllowed=${report.tabularAcceptance?.launchAllowed} ` +
      `included=${report.files.filter((f) => !f.omitted).length} ` +
      `excluded=${report.files.filter((f) => f.omitted).length} ` +
      `brokenIncluded=${brokenIncluded.length}`,
  );
  // NEVER STOP: a file-level state (excluded, unverified, broken) must not block
  // reaching Yuhi Mode. We always attempt to open the Prepared Workspace; the ONLY
  // thing that can stop us is a genuine workspace-creation/open failure (caught by
  // the try/catch below → recovery). No pre-emptive "Failed"/"Partial" gate.
  if (brokenIncluded.length > 0) {
    yuhiOutput?.appendLine(
      `[launch] proceeding despite broken included file(s): ` +
        brokenIncluded.map((f) => `${f.relpath} [${f.status}/${f.transmission}]`).join(", "),
    );
  }
  if (!CLAUDE_INTEGRATION.extensionIds.some((id) => vscode.extensions.getExtension(id))) {
    const choice = await vscode.window.showWarningMessage(
      "Claude Code is not installed in this VS Code profile.",
      "Install Claude Code",
      "Cancel",
    );
    if (choice === "Install Claude Code") {
      await vscode.env.openExternal(
        vscode.Uri.parse(
          `https://marketplace.visualstudio.com/items?itemName=${CLAUDE_INTEGRATION.marketplaceItemName}`,
        ),
      );
    }
    return;
  }
  try {
    await writePreparedArtifacts(root, report, outcome);
    await appendLaunchAudit(root, report.outDir, report.runId, "launch-approved");
    await openPreparedWorkspace(launchHost(), root, report.outDir);
    await appendLaunchAudit(root, report.outDir, report.runId, "prepared-workspace-opened");
  } catch {
    // A genuine workspace-level failure (cannot write artifacts / verify sandbox /
    // open the folder) is the ONLY thing that blocks launch — surface recovery.
    await showPreparedWorkspaceRecovery(report.outDir);
    return;
  }
  reviewPanel?.dispose();
  // Non-blocking: a file-level exclusion never stops launch — just tell the user
  // what was kept back, with a way to review it. (file blocked ≠ launch blocked)
  const keptLocal = report.files.filter((file) => file.omitted).length;
  const available = report.files.filter((file) => !file.omitted).length;
  const credentialExcluded = report.files.filter(
    (file) => file.omitted && file.failureCategory === "unresolved-secret",
  ).length;
  if (keptLocal > 0) {
    const reason =
      credentialExcluded > 0
        ? `Yuhi excluded ${credentialExcluded} ${credentialExcluded === 1 ? "file" : "files"} because an unresolved credential was detected. ` +
          `Claude Code opened with the remaining ${available} ${available === 1 ? "file" : "files"}.`
        : `Yuhi opened Claude Code with ${available} safe ${available === 1 ? "file" : "files"}. ` +
          `${keptLocal} ${keptLocal === 1 ? "file was" : "files were"} kept on this computer for your protection.`;
    void vscode.window.showInformationMessage(reason, "Review excluded files").then((choice) => {
      if (choice === "Review excluded files") void commandReview();
    });
  }
}

/**
 * Copy the shareable, PUBLIC-SAFE preparation report (Markdown) to the clipboard.
 * Only ever emits aggregate numbers — never a source path, filename, or content.
 */
async function copyPublicPreparationReport(report: PrepareReport): Promise<void> {
  const summary = buildSafePreparedRunSummary(report);
  const markdown = repositoryReadyClipboardText(summary.preparationReport);
  await vscode.env.clipboard.writeText(markdown);
  void vscode.window.showInformationMessage(
    "Yuhi: public preparation report copied (public-safe — aggregate numbers only, no paths or content).",
  );
}

/**
 * Export the PUBLIC-SAFE preparation report as Markdown / JSON / SVG. The user
 * picks a format, then a save location; only aggregate numbers are ever written.
 */
async function exportPublicPreparationReport(root: string, report: PrepareReport): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    REPOSITORY_READY_EXPORT_FORMATS.map((option) => ({ label: option.label, option })),
    {
      title: "Export public preparation report",
      placeHolder: "Choose a format (public-safe — aggregate numbers only)",
    },
  );
  if (!picked) return;
  const summary = buildSafePreparedRunSummary(report);
  const content = repositoryReadyExportText(summary.preparationReport, picked.option.format);
  const target = await vscode.window.showSaveDialog({
    saveLabel: "Export report",
    defaultUri: vscode.Uri.file(
      path.join(root, `yuhi-repository-ready.${picked.option.extension}`),
    ),
    filters: { [picked.option.label]: [picked.option.extension] },
  });
  if (!target) return;
  await writeFile(target.fsPath, content, "utf8");
  void vscode.window.showInformationMessage(
    "Yuhi: public preparation report exported (public-safe — aggregate numbers only).",
  );
}

async function commandReview(awaitDecision = false): Promise<"open" | "cancel" | void> {
  if (!lastReport || !lastReportRoot) {
    const choice = await vscode.window.showInformationMessage(
      "Yuhi: nothing prepared yet. Run “Prepare Workspace” first.",
      "Prepare Workspace",
    );
    if (choice === "Prepare Workspace") await vscode.commands.executeCommand("yuhi.prepareWorkspace");
    return;
  }
  const root = lastReportRoot;
  const report = lastReport;
  const incompleteReview =
    currentIsPreparedWorkspace &&
    (recoveryReason === "preparation-incomplete" || recoveryReason === "unresolved-high-risk");
  if (reviewingOpenedPreparedWorkspace && !incompleteReview) {
    appendSafeRecoveryCheckpoint("state-validation-started", "review");
    const reconciled = await reconcilePreparedWorkspace(report.outDir, report.outDir);
    appendSafeRecoveryCheckpoint("state-validation-result", reconciled.kind);
    if (reconciled.kind === "recovery-required") {
      await showRecoveryRequired(reconciled.reason, reconciled.message);
      return;
    }
  }
  if (!reviewingOpenedPreparedWorkspace) {
    try {
      await appendLaunchAudit(root, report.outDir, report.runId, "review-opened");
    } catch {
      // Reports produced before launch metadata support remain reviewable.
    }
  }

  if (!reviewPanel) {
    reviewPanel = vscode.window.createWebviewPanel(
      "yuhi.review",
      "Yuhi — Context Savings",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    reviewPanel.onDidDispose(() => {
      reviewPanel = undefined;
      pendingReviewDecision?.("cancel");
      pendingReviewDecision = undefined;
    });
    reviewPanel.webview.onDidReceiveMessage((msg) => {
     try {
      if (msg?.type === "diff" && typeof msg.path === "string") {
        openDiff(root, report, msg.path).catch(reportLaunchFailure);
      }
      if (msg?.type === "openClaudeHere" && reviewingOpenedPreparedWorkspace) {
        openClaudeInPreparedWorkspace().catch(reportLaunchFailure);
      }
      if (msg?.type === "chooseSource") {
        void vscode.commands.executeCommand("yuhi.restartFlow");
      }
      if (msg?.type === "copyPublicReport") {
        void copyPublicPreparationReport(report);
      }
      if (msg?.type === "exportPublicReport") {
        void exportPublicPreparationReport(root, report);
      }
      if (msg?.type === "setSafetyMode" && isSafetyMode(msg.value)) {
        void (async () => {
          // Persist the choice to the workspace setting, then re-render the review
          // into its dirty / "Re-prepare required" state. This NEVER auto-launches
          // and does NOT auto-prepare — lastReport/lastReportSafetyMode stay as the
          // prepared run, so the selector now differs from the prepared mode.
          await vscode.workspace
            .getConfiguration("yuhi")
            .update("safetyMode", msg.value, vscode.ConfigurationTarget.Workspace);
          reviewPanel?.dispose();
          reviewPanel = undefined;
          await commandReview();
        })();
      }
      if (
        msg?.type === "fileDecision" &&
        typeof msg.path === "string" &&
        (msg.action === "keep-local" ||
          msg.action === "include-warning" ||
          msg.action === "always-include" ||
          msg.action === "always-exclude")
      ) {
        void (async () => {
          const file = report.files.find((candidate) => candidate.relpath === msg.path);
          if (!file || reviewingOpenedPreparedWorkspace) {
            await vscode.window.showInformationMessage(
              "Return to the Original Workspace to change this file decision and prepare again.",
            );
            return;
          }
          if (msg.action === "include-warning" || msg.action === "always-include") {
            const key = `${report.runId}:${msg.path}`;
            if (!confirmedWarningIncludes.has(key)) {
              const confirmed = await vscode.window.showWarningMessage(
                "Include this file before inspection is complete? It will be available to the agent as unverified content.",
                { modal: true },
                "Include with warning",
              );
              if (confirmed !== "Include with warning") return;
              confirmedWarningIncludes.add(key);
            }
          }
          if (msg.action === "always-include" || msg.action === "always-exclude") {
            const extension = path.extname(msg.path).toLowerCase();
            if (!extension) {
              await vscode.window.showInformationMessage(
                "This file has no extension. Use the per-file decision instead.",
              );
              return;
            }
            const config = vscode.workspace.getConfiguration("yuhi");
            const key = msg.action === "always-include"
              ? "alwaysIncludeWarningExtensions"
              : "alwaysExcludeExtensions";
            const opposite = msg.action === "always-include"
              ? "alwaysExcludeExtensions"
              : "alwaysIncludeWarningExtensions";
            const values = new Set(config.get<string[]>(key) ?? []);
            values.add(extension);
            const oppositeValues = (config.get<string[]>(opposite) ?? [])
              .filter((value) => value !== extension);
            await config.update(key, [...values].sort(), vscode.ConfigurationTarget.Workspace);
            await config.update(opposite, oppositeValues, vscode.ConfigurationTarget.Workspace);
          }
          const next = msg.action === "keep-local"
            ? await prepareWorkspaceForLaunch(root, [msg.path], currentSafetyMode())
            : await prepareWorkspaceForLaunch(
                root,
                [],
                currentSafetyMode(),
                msg.action === "include-warning" ? [msg.path] : [],
              );
          if (!next) return;
          lastReport = next;
          lastReportRoot = root;
          activityProvider?.setPrepared(buildPreparedMetrics(next), undefined, true, activityDetail(next));
          reviewPanel?.dispose();
          reviewPanel = undefined;
          await commandReview();
        })();
      }
      if (msg?.type === "reprepare") {
        void (async () => {
          // Explicit re-prepare with the selected Safety Mode. Mirrors
          // retryProtection: re-run preparation, update lastReport, recreate the
          // panel so the fresh run shows a clean Prepared state (banner gone).
          const next = await prepareWorkspaceForLaunch(root, [], currentSafetyMode());
          if (!next) return;
          lastReport = next;
          lastReportRoot = root;
          activityProvider?.setPrepared(buildPreparedMetrics(next), undefined, true, activityDetail(next));
          reviewPanel?.dispose();
          reviewPanel = undefined;
          await commandReview();
        })();
      }
      if (msg?.type === "retryProtection") {
        void (async () => {
          const next = await prepareWorkspaceForLaunch(root);
          if (!next) return;
          if (next.runId === report.runId) {
            await vscode.window.showErrorMessage(
              "Yuhi could not create a new recovery run. The previous run was not changed.",
            );
            return;
          }
          lastReport = next;
          lastReportRoot = root;
          activityProvider?.setPrepared(buildPreparedMetrics(next), undefined, true, activityDetail(next));
          reviewPanel?.dispose();
          reviewPanel = undefined;
          await commandReview();
        })();
      }
      if (msg?.type === "launch" || msg?.type === "cancel") {
        // Launch gating: never open Claude Code on a run whose Safety Mode no longer
        // matches the selected mode. The UI already disables the button while dirty;
        // this is the host-side guarantee (survives reload / alternate invocation).
        if (msg.type === "launch") {
          const selected = currentSafetyMode();
          const freshness = checkSafetyModeFreshness(report.safetyMode, selected);
          if (!freshness.fresh) {
            void vscode.window.showWarningMessage(
              "The prepared repository is out of date.",
              {
                modal: true,
                detail:
                  `Prepared mode: ${safetyModeLabel(report.safetyMode)}\n` +
                  `Selected mode: ${safetyModeLabel(selected)}\n\n` +
                  "Re-prepare the repository before launching Claude Code.",
              },
              "Re-prepare",
            ).then((choice) => {
              if (choice === "Re-prepare") reviewPanel?.webview.postMessage({ type: "reprepare" });
            });
            return;
          }
        }
        const resolveDecision = pendingReviewDecision;
        pendingReviewDecision = undefined;
        if (resolveDecision) {
          resolveDecision(msg.type === "launch" ? "open" : "cancel");
        } else if (msg.type === "launch" && !currentIsPreparedWorkspace) {
          launchPreparedReportFromReview(root, report).catch(reportLaunchFailure);
        }
        if (msg.type === "cancel") reviewPanel?.dispose();
      }
     } catch (error) {
       reportLaunchFailure(error);
     }
    });
  }
  const preparedTree = await listPreparedTree(report.outDir);
  reviewPanel.webview.html = renderSavingsHtml(
    toReviewData(report, root, preparedTree, awaitDecision),
    reviewPanel.webview.cspSource,
    nonce(),
  );
  reviewPanel.reveal();
  if (awaitDecision) {
    return await new Promise<"open" | "cancel">((resolve) => {
      pendingReviewDecision = resolve;
    });
  }
}

async function activatePreparedWorkspaceBanner(context: vscode.ExtensionContext, root: string): Promise<boolean> {
  const sessionPath = path.join(root, ".yuhi", "session.json");
  const manifestPath = path.join(root, "manifest.json");
  let initialRecovery:
    | { reason: RecoveryReason; message: string }
    | undefined;
  if (isManagedYuhiWorkspace(root)) {
    currentIsPreparedWorkspace = true;
    appendSafeRecoveryCheckpoint("state-validation-started", "activation");
    const reconciled = await reconcilePreparedWorkspace(root, root);
    appendSafeRecoveryCheckpoint("state-validation-result", reconciled.kind);
    if (reconciled.kind === "recovery-required") {
      if (
        reconciled.reason !== "preparation-incomplete" &&
        reconciled.reason !== "unresolved-high-risk"
      ) {
        enterRecovery(reconciled.reason, reconciled.message);
        void showPreparedWorkspaceRecovery(root);
        return true;
      }
      initialRecovery = reconciled;
    }
  }
  if (!existsSync(sessionPath) || !existsSync(manifestPath)) return false;
  try {
    const session = normalizePreparedSession(JSON.parse(await readFile(sessionPath, "utf8")));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      schemaVersion?: 1 | 2;
      runId: string;
      reduction: PrepareReport["report"];
      files: (PreparedFileEntry & {
        ruleName?: string;
        reason?: string;
        findingCategoryCounts?: Record<string, number>;
        findingSeverityCounts?: Record<string, number>;
        unresolvedHighRiskCount?: number;
        /** Legacy only. Descriptions and previews are deliberately ignored. */
        findings?: { detector?: string; severity?: "low" | "medium" | "high" | "critical" }[];
      })[];
      sourceModified: number;
      safetyMode?: SafetyMode;
      /** v0.3.4 deterministic Context ID; absent on legacy runs → no picker. */
      contextId?: unknown;
      compression?: CompressionReport;
      publicSummary?: PublicPreparedContextSummary;
      yuhiModeSummary?: PrepareReport["yuhiModeSummary"];
      tabularAcceptance?: PrepareReport["tabularAcceptance"];
    };
    const metadataFindings = (file: (typeof manifest.files)[number]) => {
      const severities: ("low" | "medium" | "high" | "critical")[] = [];
      for (const severity of ["critical", "high", "medium", "low"] as const) {
        const count = Math.max(0, Math.trunc(file.findingSeverityCounts?.[severity] ?? 0));
        for (let index = 0; index < count; index += 1) severities.push(severity);
      }
      const categories: string[] = [];
      for (const [category, rawCount] of Object.entries(file.findingCategoryCounts ?? {})) {
        const count = Math.max(0, Math.trunc(rawCount));
        for (let index = 0; index < count; index += 1) categories.push(category);
      }
      if (severities.length === 0 && categories.length === 0 && Array.isArray(file.findings)) {
        for (const finding of file.findings) {
          categories.push(typeof finding.detector === "string" ? finding.detector : "legacy");
          severities.push(finding.severity ?? "low");
        }
      }
      const count = Math.max(categories.length, severities.length);
      return Array.from({ length: count }, (_, index) => ({
        detector: categories[index] ?? "metadata-only",
        severity: severities[index] ?? "low",
        path: file.relpath,
        description: "Metadata-only finding category.",
        maskedPreview: "[not stored]",
      }));
    };
    lastReport = {
      runId: manifest.runId,
      outDir: root,
      report: manifest.reduction,
      files: manifest.files,
      blocked: manifest.files.filter((f) => f.status === "blocked"),
      errors: manifest.files.filter((f) => f.status === "error"),
      decisions: manifest.files.map((f) => ({
        relpath: f.relpath,
        action: f.action,
        ruleName: f.ruleName ?? "preparation result",
        reason: f.reason ?? (f.omitted ? "Omitted from the Prepared Workspace." : "Included by policy."),
        destinations: [],
        findings: metadataFindings(f),
      })),
      sourceModified: manifest.sourceModified,
      safetyMode: isSafetyMode(manifest.safetyMode) ? manifest.safetyMode : currentSafetyMode(),
      // v0.3.4 — carry the deterministic Context ID so THIS opened Prepared Workspace
      // window can offer the same agent picker (reused across agents). Legacy or invalid
      // ids are dropped, so `currentPickerSource()` falls back to the single button.
      ...(isContextId(manifest.contextId) ? { contextId: manifest.contextId } : {}),
      ...(manifest.compression ? { compression: manifest.compression } : {}),
      ...(manifest.publicSummary ? { publicSummary: manifest.publicSummary } : {}),
      ...(manifest.yuhiModeSummary ? { yuhiModeSummary: manifest.yuhiModeSummary } : {}),
      ...(manifest.tabularAcceptance
        ? { tabularAcceptance: manifest.tabularAcceptance }
        : {}),
    };
    lastReportRoot = root;
    // Reflect the mode this Prepared Workspace was actually prepared under (from
    // the manifest when present), so the review selector shows a clean state.
    lastReportSafetyMode = lastReport.safetyMode;
    reviewingOpenedPreparedWorkspace = true;
    if (initialRecovery) {
      recoveryReason = initialRecovery.reason;
      preparedSandboxVerified = false;
      setStatus("recovery-required");
      activityProvider?.setRecoveryRequired(
        `${initialRecovery.message} · ${lastReport.errors.length + lastReport.blocked.length} blocked`,
      );
      void showPreparedWorkspaceRecovery(root);
      return true;
    }
    recoveryReason = undefined;
    try {
      await writeAndVerifyClaudeSandboxPolicy(root, root);
      preparedSandboxVerified = true;
    } catch {
      // Strict writer failed (often a path-representation edge case). Verification
      // = the on-disk policy is structurally correct; confirm that directly.
      const diag = await claudeSandboxPolicyDiagnostic(root);
      preparedSandboxVerified = diag.valid;
      if (diag.valid) {
        yuhiOutput?.appendLine("[sandbox] activation: verified from on-disk policy (structural check passed).");
      } else {
        yuhiOutput?.appendLine(
          `[sandbox] activation verification FAILED: present=${diag.present} failedAssertion=${diag.failedAssertion}`,
        );
        activityProvider?.setPrepared(session.metrics, "Sandbox policy not verified · launch blocked", false);
        void vscode.window.showErrorMessage(
          "Yuhi: this Prepared Workspace's sandbox policy could not be verified. See Output → Yuhi for the exact reason.",
        );
      }
    }

    const m = session.metrics;
    if (preparedSandboxVerified) {
      // This window IS the Prepared Workspace and is launchable → show the blue
      // "Yuhi Mode" panel so it's instantly recognizable (not the generic ready view).
      const available = lastReport.publicSummary?.availableFiles ??
        lastReport.files.filter((f) => !f.omitted).length;
      const excluded = lastReport.publicSummary?.excludedForSafetyFiles ??
        lastReport.files.filter((f) => f.omitted && f.outcome !== "background-processing-pending").length;
      const pending = lastReport.publicSummary?.backgroundPendingFiles ??
        lastReport.files.filter((f) => f.outcome === "background-processing-pending").length;
      // v0.3.4 — reconstruct the agent picker from the on-disk manifest's Context ID so
      // this opened Prepared Workspace offers the SAME "Launch with [Claude Code] [Codex]"
      // surface, reusing this window's prepared repo (no re-prepare). A legacy/invalid
      // manifest (no valid contextId) yields no source → the single button is kept.
      const pickerSource = currentPickerSource();
      const yuhiModePicker = pickerSource ? await buildAgentPickerFor(pickerSource) : undefined;
      activityProvider?.setYuhiMode({
        filesAvailable: available,
        filesExcluded: excluded,
        ...(lastReport.publicSummary
          ? {
              verifiedFiles: lastReport.publicSummary.verifiedFiles,
              warningFiles: lastReport.publicSummary.availableWithWarningFiles,
              processingFailedFiles: lastReport.publicSummary.processingFailedFiles,
            }
          : {}),
        documentsPending: pending,
        claudeExtensionAvailable: vscode.extensions.getExtension("anthropic.claude-code") !== undefined,
        maskedValues: m.sensitiveValuesMasked,
        ...(lastReport.publicSummary?.reductionPercent !== null && lastReport.publicSummary?.reductionPercent !== undefined
          ? { reductionPercent: lastReport.publicSummary.reductionPercent }
          : {}),
        ...(lastReport.publicSummary?.originalEstimatedTokens !== null && lastReport.publicSummary?.originalEstimatedTokens !== undefined
          ? { estimatedTokensBefore: lastReport.publicSummary.originalEstimatedTokens }
          : {}),
        ...(lastReport.publicSummary?.preparedEstimatedTokens !== null && lastReport.publicSummary?.preparedEstimatedTokens !== undefined
          ? { estimatedTokensAfter: lastReport.publicSummary.preparedEstimatedTokens }
          : {}),
        ...(lastReport.compression
          ? {
              compression: {
                tokenBudget: lastReport.compression.targetBudget,
                preparedTokens: lastReport.compression.preparedTokens,
                status: lastReport.compression.status,
              },
            }
          : {}),
        filesTransformed: m.preparedFilesModified,
        ...(lastReport.yuhiModeSummary ? { yuhiModeSummary: lastReport.yuhiModeSummary } : {}),
        ...(yuhiModePicker ? { picker: yuhiModePicker } : {}),
      });
      // v0.3.5 — NOW that Yuhi Mode is ready, start Progressive Context fire-and-forget:
      // it runs the deferred background work and drives the panel from the PUBLIC status
      // file only. Building the local provider is best-effort and never blocks launch; a
      // reload re-enters here and resumes (the worker + revision are idempotent).
      const yuhiReport = lastReport;
      void (async () => {
        let provider: LocalModelProvider | undefined;
        try {
          provider = await buildProvider(root);
        } catch {
          // No local provider → summaries are honestly kept local; extraction still runs.
        }
        startProgressiveContext(yuhiReport, available, provider);
      })();
    } else {
      activityProvider?.setPrepared(m, "Launch blocked", false);
    }
    await applyPreparedWorkspaceBranding();
    preparedStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    preparedStatusBar.name = "Claude Code with Yuhi";
    preparedStatusBar.text = preparedSandboxVerified
      ? `$(sparkle) YUHI MODE · ${lastReport.publicSummary?.reductionPercent === null || lastReport.publicSummary?.reductionPercent === undefined ? "reduction not measured" : `${lastReport.publicSummary.reductionPercent.toFixed(1)}% estimated reduction`}`
      : "$(error) YUHI ADVISORY WORKSPACE — CLAUDE BLOCKED";
    // Blue accent so "Yuhi Mode" is instantly recognizable in the Prepared Workspace.
    preparedStatusBar.color = preparedSandboxVerified
      ? new vscode.ThemeColor("charts.blue")
      : new vscode.ThemeColor("statusBarItem.errorForeground");
    preparedStatusBar.tooltip = new vscode.MarkdownString(
      [
        "**Claude Code with Yuhi**",
        "",
        "This window is a Yuhi Prepared Workspace.",
        "",
        ...preparedStatusTooltipLines(session.runId, m, lastReport.publicSummary),
        "",
        "Click to review the prepared context.",
      ].join("  \n"),
    );
    preparedStatusBar.command = "yuhi.reviewPrepared";
    preparedStatusBar.show();
    context.subscriptions.push(preparedStatusBar);
    const agentChangeWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, "**/*"),
    );
    const markAgentChanges = (uri: vscode.Uri) => {
      if (!agentSessionStarted || agentReviewMutationRunning || Date.now() < suppressAgentWatcherUntil) return;
      const relpath = path.relative(root, uri.fsPath).split(path.sep).join("/");
      if (
        relpath === "manifest.json" || relpath === "CLAUDE.md" || relpath === "AGENTS.md" ||
        relpath.startsWith(".yuhi/") ||
        relpath.startsWith(".claude/")
      ) return;
      if (!preparedStatusBar) return;
      preparedStatusBar.text = "$(diff) AGENT CHANGES READY — REVIEW WITH YUHI";
      preparedStatusBar.tooltip = new vscode.MarkdownString(
        [
          "**Claude Code with Yuhi**",
          "",
          "A project file changed inside this Prepared Workspace.",
          "",
          "Click to rescan and review changes. Nothing has been applied to the Original Workspace.",
        ].join("  \n"),
      );
      preparedStatusBar.command = "yuhi.reviewAgentChanges";
      activityProvider?.setAgentChangesDetected();
    };
    context.subscriptions.push(
      agentChangeWatcher,
      agentChangeWatcher.onDidCreate(markAgentChanges),
      agentChangeWatcher.onDidChange(markAgentChanges),
      agentChangeWatcher.onDidDelete(markAgentChanges),
    );
    const welcomeKey = `yuhi.preparedWelcome.${session.runId}`;
    if (!context.workspaceState.get<boolean>(welcomeKey)) {
      await context.workspaceState.update(welcomeKey, true);
      void vscode.window.showInformationMessage(
        "Prepared Workspace opened",
        {
          modal: false,
          detail:
            "Claude Code is ready to use in this window. Open Claude Code from the Activity Bar or Command Palette.",
        },
        "Review Prepared Context",
      ).then((choice) => {
        if (choice === "Review Prepared Context") {
          void vscode.commands.executeCommand("yuhi.reviewPrepared");
        }
      });
    }
    const claudeLaunchKey = `yuhi.claudeOpened.${session.runId}`;
    if (preparedSandboxVerified && !context.workspaceState.get<boolean>(claudeLaunchKey)) {
      void openClaudeInPreparedWorkspace().then(async (opened) => {
        if (opened) await context.workspaceState.update(claudeLaunchKey, true);
      });
    }
    return true;
  } catch (e) {
    void vscode.window.showWarningMessage(`Yuhi: Prepared Workspace metadata could not be validated — ${errText(e)}`);
    return false;
  }
}

async function applyPreparedWorkspaceBranding(): Promise<void> {
  await vscode.workspace
    .getConfiguration("window")
    .update("title", PREPARED_WINDOW_TITLE, vscode.ConfigurationTarget.Workspace);
  const workbench = vscode.workspace.getConfiguration("workbench");
  const existing = workbench.get<Record<string, string>>("colorCustomizations", {});
  await workbench.update(
    "colorCustomizations",
    { ...existing, ...PREPARED_WORKBENCH_COLORS },
    vscode.ConfigurationTarget.Workspace,
  );
}

async function openClaudeInPreparedWorkspace(): Promise<boolean> {
  if (claudeOpenPromise) return claudeOpenPromise;
  claudeOpenPromise = performOpenClaudeInPreparedWorkspace().finally(() => {
    claudeOpenPromise = undefined;
  });
  return claudeOpenPromise;
}

async function performOpenClaudeInPreparedWorkspace(): Promise<boolean> {
  if (!reviewingOpenedPreparedWorkspace) {
    void vscode.window.showWarningMessage(
      "Yuhi: Claude Code can only be opened from this action inside a Prepared Workspace.",
    );
    return false;
  }
  if (!preparedSandboxVerified) {
    // Re-verify on demand rather than trusting a possibly-stale flag (async
    // activation race / path-assertion edge case). The policy file is usually
    // already present and correct — confirm it now instead of dead-ending.
    const root = firstWorkspaceRoot();
    if (root) {
      try {
        await writeAndVerifyClaudeSandboxPolicy(root, root);
        preparedSandboxVerified = true;
      } catch {
        // The strict writer (which also asserts the managed path) can fail on a
        // path-representation edge case even when the policy is correct. That is NOT
        // a verification success — verification means the on-disk policy is
        // structurally correct, which we confirm directly here (honest, not a claim).
        const diag = await claudeSandboxPolicyDiagnostic(root);
        preparedSandboxVerified = diag.valid;
        yuhiOutput?.appendLine(
          diag.valid
            ? "[sandbox] verified from on-disk policy (structural check passed)."
            : `[sandbox] verification FAILED: present=${diag.present} failedAssertion=${diag.failedAssertion}`,
        );
      }
    }
  }
  if (!preparedSandboxVerified) {
    yuhiOutput?.show(true);
    void vscode.window.showErrorMessage(
      "Yuhi: Claude Code launch blocked because the sandbox policy could not be verified. See Output → Yuhi for the exact reason.",
    );
    return false;
  }
  const claude = vscode.extensions.getExtension("anthropic.claude-code");
  if (!claude) {
    const choice = await vscode.window.showWarningMessage(
      "Claude Code is not installed in this VS Code profile.",
      "Install Claude Code",
      "Cancel",
    );
    if (choice === "Install Claude Code") {
      await vscode.env.openExternal(
        vscode.Uri.parse(
          "https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code",
        ),
      );
    }
    return false;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Preparing with Yuhi",
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Opening Claude Code" });
      await claude.activate();
    },
  );
  const commands = new Set(await vscode.commands.getCommands(true));
  const command = CLAUDE_OPEN_COMMANDS.find((candidate) => commands.has(candidate));
  if (!command) {
    void vscode.window.showWarningMessage(
      "Claude Code is installed, but this version does not expose a supported open action. Open Claude Code from the Activity Bar or Command Palette.",
    );
    return false;
  }
  await vscode.commands.executeCommand(command);
  agentSessionStarted = true;
  void vscode.window.showInformationMessage(
    "Claude Code with Yuhi is active in this Prepared Workspace. Yuhi installed and verified the fail-closed Claude Code sandbox policy.",
    "Review Prepared Context",
  ).then((choice) => {
    if (choice === "Review Prepared Context") {
      void vscode.commands.executeCommand("yuhi.reviewPrepared");
    }
  });
  return true;
}

/** Open Original ↔ Prepared for one prepared file. */
async function openDiff(root: string, report: PrepareReport, relpath: string): Promise<void> {
  const entry = report.files.find((f) => f.relpath === relpath);
  if (!entry || entry.status !== "ok" || entry.omitted) {
    void vscode.window.showInformationMessage(`Yuhi: “${relpath}” has no prepared copy to diff.`);
    return;
  }
  const original = vscode.Uri.file(path.join(root, ...relpath.split("/")));
  const prepared = vscode.Uri.file(path.join(report.outDir, ...relpath.split("/")));
  await vscode.commands.executeCommand(
    "vscode.diff",
    original,
    prepared,
    `${relpath} — Original ↔ Prepared`,
  );
}

// ---- misc ----
function nonce(): string {
  let t = "";
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 24; i++) t += c[Math.floor(Math.random() * c.length)];
  return t;
}

function errText(e: unknown): string {
  if (isYuhiError(e)) return e.hint ? `${e.message} (${e.hint})` : e.message;
  return e instanceof Error ? e.message : String(e);
}

async function initializeProject(root: string): Promise<void> {
  const res = runInit(root);
  void vscode.window.showInformationMessage(
    res.alreadyExisted ? "Yuhi: yuhi.yaml already exists." : "Yuhi: created yuhi.yaml.",
  );
  try {
    const doc = await vscode.workspace.openTextDocument(path.join(root, CONFIG_FILENAME));
    await vscode.window.showTextDocument(doc);
  } catch {
    /* non-fatal */
  }
  void refreshStatus(root);
}

/** Gentle, non-modal first-run guidance. */
async function onboard(root: string): Promise<void> {
  if (!existsSync(path.join(root, CONFIG_FILENAME))) {
    const choice = await vscode.window.showInformationMessage(
      "Yuhi: this folder isn’t initialized. Create a yuhi.yaml to control what stays on your machine?",
      "Initialize",
      "Later",
    );
    if (choice === "Initialize") await initializeProject(root);
    return;
  }
  const state = await refreshStatus(root);
  if (state && (state.status === "ollama-missing" || state.status === "model-missing")) {
    const choice = await vscode.window.showInformationMessage(
      `Yuhi: local AI isn’t ready (${STATUS[state.status].text}). Set it up now?`,
      "Setup Local AI",
      "Later",
    );
    if (choice === "Setup Local AI") await vscode.commands.executeCommand("yuhi.setupLocalAI");
  }
}

// ---- activation ----
export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  const syncClaudePolicyDefaults = (): void => {
    const cfg = vscode.workspace.getConfiguration("yuhi");
    const rawPreset = cfg.get<string>("sandboxPreset");
    const rawMode = cfg.get<string>("permissionMode");
    const sandboxPreset: YuhiSandboxPreset =
      rawPreset === "standard" || rawPreset === "locked-down" ? rawPreset : "guarded";
    const permissionMode: ClaudePermissionMode =
      rawMode === "plan" || rawMode === "acceptEdits" || rawMode === "auto" || rawMode === "custom"
        ? rawMode
        : "standard";
    configureClaudeWorkspacePolicyDefaults({ sandboxPreset, permissionMode });
  };
  syncClaudePolicyDefaults();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("yuhi.sandboxPreset") || event.affectsConfiguration("yuhi.permissionMode")) {
        syncClaudePolicyDefaults();
      }
    }),
  );
  yuhiOutput = vscode.window.createOutputChannel("Yuhi");
  context.subscriptions.push(yuhiOutput);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const reconcileOnReveal = (): void => {
    const current = firstWorkspaceRoot();
    if (!current || !isManagedYuhiWorkspace(current)) return;
    void reconcilePreparedWorkspace(current, current).then((state) => {
      if (state.kind === "recovery-required") enterRecovery(state.reason, state.message);
    });
  };
  activityProvider = new YuhiActivityProvider(
    context.workspaceState,
    typeof context.extension.packageJSON?.version === "string"
      ? context.extension.packageJSON.version
      : "",
    reconcileOnReveal,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(YUHI_ACTIVITY_VIEW_ID, activityProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  let preparedWorkspaceCheck = Promise.resolve(false);
  setStatus("ready");

  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand("yuhi.doctor", () => commandDoctor()),
    vscode.commands.registerCommand("yuhi.setupLocalAI", () => commandSetupLocalAI()),
    vscode.commands.registerCommand("yuhi.prepareWorkspace", () => commandPrepare()),
    vscode.commands.registerCommand("yuhi.prepareHere", (uri?: vscode.Uri) => commandPrepare(uri)),
    vscode.commands.registerCommand("yuhi.reviewPrepared", () => commandReview()),
    // v0.3.5 Progressive Context — the panel's Cancel / Refresh Context buttons.
    vscode.commands.registerCommand("yuhi.cancelBackground", () => commandCancelBackground()),
    vscode.commands.registerCommand("yuhi.refreshContext", () => commandRefreshContext()),
    vscode.commands.registerCommand(LAUNCH_COMMANDS.prepareAndOpen, () =>
      runVisibleCommand(commandPrepareAndOpen),
    ),
    vscode.commands.registerCommand(LAUNCH_COMMANDS.prepareAndStartClaude, () =>
      runVisibleCommand(() => commandPrepareAndStartClaude(context)),
    ),
    vscode.commands.registerCommand(DYNAMIC_COMMAND_ID, () =>
      runVisibleCommand(commandLaunchClaudeDynamic),
    ),
    vscode.commands.registerCommand("yuhi.showDynamicStats", () => {
      yuhiOutput?.show(true);
      const view = dynamicPanelView(
        dynamicSession?.state() ?? "complete",
        dynamicSession?.latestStats(),
      );
      for (const row of view.rows) yuhiOutput?.appendLine(`  ${row.label}: ${row.value}`);
      yuhiOutput?.appendLine(`  ${view.footnote}`);
    }),
    watchDynamicTerminalClose(),
    vscode.commands.registerCommand("yuhi.launchAgent", (agentId?: unknown) =>
      commandLaunchAgent(typeof agentId === "string" ? agentId : "").catch(reportLaunchFailure),
    ),
    vscode.commands.registerCommand("yuhi.openClaudeHere", () =>
      runVisibleCommand(commandOpenClaudeHere),
    ),
    vscode.commands.registerCommand("yuhi.switchWorkspace", () =>
      runVisibleCommand(() => commandSwitchWorkspace(context)),
    ),
    vscode.commands.registerCommand("yuhi.exitWorkspace", () =>
      runVisibleCommand(commandExitYuhiWorkspace),
    ),
    // Recovery deliberately bypasses the normal in-progress guard so a user can
    // always escape a stale prompt, cancelled review, or interrupted prepare.
    vscode.commands.registerCommand("yuhi.restartFlow", () =>
      commandRestartFlow(context),
    ),
    vscode.commands.registerCommand("yuhi.openSourceWorkspace", () =>
      runVisibleCommand(commandOpenSourceWorkspace),
    ),
    vscode.commands.registerCommand("yuhi.dismissPreviousRun", () =>
      runVisibleCommand(commandDismissPreviousRun),
    ),
    vscode.commands.registerCommand("yuhi.reviewAgentChanges", () =>
      runVisibleCommand(commandReviewAgentChanges),
    ),
    vscode.commands.registerCommand("yuhi.showRecovery", () =>
      runVisibleCommand(async () => {
        const root = firstWorkspaceRoot();
        if (root && isManagedYuhiWorkspace(root)) await showPreparedWorkspaceRecovery(root);
        else if (extensionContext) await commandRestartFlow(extensionContext);
      }),
    ),
  );

  const root = firstWorkspaceRoot();
  if (root) {
    preparedWorkspaceCheck = activatePreparedWorkspaceBanner(context, root);
    void preparedWorkspaceCheck.then((isPrepared) => {
      if (isPrepared) {
        statusBar.hide();
      } else {
        void onboard(root);
      }
    });
  }
}

export function deactivate(): void {
  // Stop the fire-and-forget background worker + its poll timer on shutdown.
  stopProgressiveContext();
  // A dynamic session outliving the window would leave a listening gateway behind.
  const session = dynamicSession;
  dynamicSession = undefined;
  void session?.close();
  dynamicStatusBar?.dispose();
  dynamicStatusBar = undefined;
}
