import * as vscode from "vscode";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, access, mkdir, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { spawn, execFile } from "node:child_process";
import {
  buildPreparedMetrics,
  buildPreparedFileDecisions,
  buildPreparedRuntimeBoundary,
  lookupOnPath,
  prepareWorkspace,
  runInit,
  type PrepareReport,
  type PreparedFileEntry,
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
  CLAUDE_INTEGRATION,
  LAUNCH_COMMANDS,
  appendLaunchAudit,
  buildSummary,
  formatSummaryDetail,
  formatPreparedStatusText,
  normalizePreparedSession,
  preparedStatusTooltipLines,
  runPrepareAndOpen,
  runPrepareAndStartClaude,
  type ClaudeMode,
  type LaunchHost,
} from "./launch.js";

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
  | "failed";

const STATUS: Record<StatusState, { text: string; icon: string; command?: string; tip: string }> = {
  ready: { text: "Yuhi ready", icon: "shield", command: "yuhi.prepareWorkspace", tip: "Prepare this workspace locally before sending to Claude." },
  "ollama-missing": { text: "Ollama missing", icon: "warning", command: "yuhi.setupLocalAI", tip: "Local AI runtime not found. Run Setup Local AI." },
  "ollama-stopped": { text: "Ollama stopped", icon: "debug-disconnect", command: "yuhi.doctor", tip: "Ollama is installed but not running. Start it, then run Doctor." },
  "model-missing": { text: "Model missing", icon: "cloud-download", command: "yuhi.setupLocalAI", tip: "No local model installed. Run Setup Local AI." },
  "inference-failed": { text: "Inference failed", icon: "error", command: "yuhi.doctor", tip: "Ollama is installed but generation failed. Run Doctor for the reason and fixes." },
  preparing: { text: "Preparing…", icon: "sync~spin", tip: "Preparing your workspace locally…" },
  "ready-for-review": { text: "Ready for review", icon: "eye", command: "yuhi.reviewPrepared", tip: "Preparation complete. Review what would be sent." },
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
let reviewPanel: vscode.WebviewPanel | undefined;
let preparedStatusBar: vscode.StatusBarItem | undefined;
let reviewingOpenedPreparedWorkspace = false;

// ---- helpers ----
function firstWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
async function prepareWorkspaceForLaunch(root: string): Promise<PrepareReport | undefined> {
  // Onboarding gates: config + local AI must be ready before preparing.
  if (!existsSync(path.join(root, CONFIG_FILENAME))) {
    const init = await vscode.window.showInformationMessage(
      "Yuhi is not initialized here. Create a yuhi.yaml to define what stays local?",
      "Initialize",
    );
    if (init === "Initialize") await initializeProject(root);
    return undefined;
  }
  const state = await runDoctorChecks(root);
  if (state.status !== "ready") {
    setStatus(state.status);
    const fix = await vscode.window.showWarningMessage(
      `Yuhi: local AI is not ready (${STATUS[state.status].text}).`,
      "Setup Local AI",
      "Run Doctor",
    );
    if (fix === "Setup Local AI") await vscode.commands.executeCommand("yuhi.setupLocalAI");
    else if (fix === "Run Doctor") await vscode.commands.executeCommand("yuhi.doctor");
    return undefined;
  }

  setStatus("preparing");
  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Yuhi: preparing workspace locally",
        cancellable: true,
      },
      async (progress, token) => {
        const provider = await buildProvider(root);
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return prepareWorkspace(root, {
          provider,
          signal: controller.signal,
          onProgress: (msg) => progress.report({ message: msg }),
        });
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

async function commandPrepare(target?: vscode.Uri): Promise<void> {
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

    // Outcome: Complete / Complete with warnings / Partial / Failed (failures visible).
    const errs = report.errors.length;
    const blocked = report.blocked.length;
    const preparedOk = report.files.filter((f) => f.status === "ok" && !f.omitted).length;
    const outcome =
      preparedOk === 0 && (errs > 0 || blocked > 0)
        ? "Failed"
        : errs > 0
          ? "Partial"
          : blocked > 0
            ? "Complete with warnings"
            : "Complete";
    setStatus(outcome === "Failed" ? "failed" : "ready-for-review");

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
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(folderPath), newWindow);
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
    lastReport = report;
    lastReportRoot = root;
    setStatus("ready-for-review");
  }
  return report;
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
  const host = launchHost();
  await runPrepareAndOpen({
    host,
    getWorkspaceRoot: firstWorkspaceRoot,
    prepare: rememberReport,
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

async function pickClaudeMode(context: vscode.ExtensionContext): Promise<ClaudeMode | undefined> {
  const previous = context.globalState.get<ClaudeMode>("yuhi.claudeLaunchMode", "extension");
  const items: (vscode.QuickPickItem & { mode?: ClaudeMode })[] = [
    {
      label: "VS Code extension — open with Claude Code",
      description: previous === "extension" ? "Last used" : undefined,
      mode: "extension",
    },
    {
      label: "CLI — run Claude Code in terminal",
      description: previous === "cli" ? "Last used" : undefined,
      mode: "cli",
    },
    { label: "Cancel" },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Yuhi: Prepare and Start Claude Code",
    placeHolder: "Choose how Claude Code should start from the Prepared Workspace",
  });
  if (!picked?.mode) return undefined;
  await context.globalState.update("yuhi.claudeLaunchMode", picked.mode);
  return picked.mode;
}

async function commandPrepareAndStartClaude(context: vscode.ExtensionContext): Promise<void> {
  const host = launchHost();
  await runPrepareAndStartClaude({
    host,
    getWorkspaceRoot: firstWorkspaceRoot,
    prepare: rememberReport,
    pickMode: () => pickClaudeMode(context),
    resolveCliFile: () => lookupOnPath(CLAUDE_INTEGRATION.cliCommand),
    confirmLaunch: (summary) => confirmPreparedLaunch(summary, "Open with Claude Code"),
    reviewDetails: commandReview,
    confirmHighRiskOverride,
  });
}

// ---- review prepared ----
function toReviewData(report: PrepareReport, root: string, preparedTree: string[]): ReviewData {
  const est = (chars: number) => Math.ceil(chars / 4); // matches @yuhi/shared estimateTokens heuristic
  const decisions = new Map(buildPreparedFileDecisions(report).map((d) => [d.relativePath, d]));
  const files = report.files.map((f: PreparedFileEntry) => {
    const d = decisions.get(f.relpath);
    return {
      path: f.relpath,
      action: f.action,
      status: f.status,
      omitted: !!f.omitted,
      beforeTokens: est(f.beforeChars),
      afterTokens: f.omitted ? 0 : est(f.afterChars),
      diffable: !reviewingOpenedPreparedWorkspace && f.status === "ok" && !f.omitted,
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
    };
  });
  const r = report.report;
  const metrics = buildPreparedMetrics(report);
  return {
    project: path.basename(root),
    agent: "Claude Code",
    runId: report.runId,
    outcome: report.errors.length > 0 ? "Partial" : report.blocked.length > 0 ? "Complete with warnings" : "Complete",
    osSandboxEnabled: false,
    outDir: path.relative(root, report.outDir),
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
    runtime: buildPreparedRuntimeBoundary(),
    files,
    preparedTree,
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

async function commandReview(): Promise<void> {
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
    reviewPanel.onDidDispose(() => (reviewPanel = undefined));
    reviewPanel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "diff" && typeof msg.path === "string") void openDiff(root, report, msg.path);
    });
  }
  const preparedTree = await listPreparedTree(report.outDir);
  reviewPanel.webview.html = renderSavingsHtml(
    toReviewData(report, root, preparedTree),
    reviewPanel.webview.cspSource,
    nonce(),
  );
  reviewPanel.reveal();
}

async function activatePreparedWorkspaceBanner(context: vscode.ExtensionContext, root: string): Promise<boolean> {
  const sessionPath = path.join(root, ".yuhi", "session.json");
  const manifestPath = path.join(root, "manifest.json");
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
    };
    lastReportRoot = root;
    reviewingOpenedPreparedWorkspace = true;

    const m = session.metrics;
    preparedStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    preparedStatusBar.text = formatPreparedStatusText(m);
    preparedStatusBar.tooltip = new vscode.MarkdownString(
      preparedStatusTooltipLines(session.runId, m).join("  \n"),
    );
    preparedStatusBar.command = "yuhi.reviewPrepared";
    preparedStatusBar.show();
    context.subscriptions.push(preparedStatusBar);
    return true;
  } catch (e) {
    void vscode.window.showWarningMessage(`Yuhi: Prepared Workspace metadata could not be validated — ${errText(e)}`);
    return false;
  }
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
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  setStatus("ready");

  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand("yuhi.doctor", () => commandDoctor()),
    vscode.commands.registerCommand("yuhi.setupLocalAI", () => commandSetupLocalAI()),
    vscode.commands.registerCommand("yuhi.prepareWorkspace", () => commandPrepare()),
    vscode.commands.registerCommand("yuhi.prepareHere", (uri?: vscode.Uri) => commandPrepare(uri)),
    vscode.commands.registerCommand("yuhi.reviewPrepared", () => commandReview()),
    vscode.commands.registerCommand(LAUNCH_COMMANDS.prepareAndOpen, () => commandPrepareAndOpen()),
    vscode.commands.registerCommand(LAUNCH_COMMANDS.prepareAndStartClaude, () =>
      commandPrepareAndStartClaude(context),
    ),
  );

  const root = firstWorkspaceRoot();
  if (root) {
    void activatePreparedWorkspaceBanner(context, root).then((isPrepared) => {
      if (isPrepared) statusBar.hide();
      else void onboard(root);
    });
  }
}

export function deactivate(): void {
  /* nothing to clean up */
}
