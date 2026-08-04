/**
 * The `vscode`-aware layer for Native GUI Mode. Everything with real logic lives in
 * `controller.ts`, `attach-client.ts` and the gateway package; this file binds them to the
 * editor and owns nothing else.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as vscode from "vscode";

import {
  discoverSessions,
  recoverStaleSessions,
  sessionLayout,
  workspaceHash,
  describeDiscovered,
  type DiscoveredSession,
  type NativeSessionDiagnostics,
} from "@yuhi/context-gateway";

import { createControlClient, type NativeSessionSettingValue } from "./attach-client.js";
import {
  NATIVE_COMMANDS,
  describeOpenOutcome,
  joinNativeSession,
  startNativeSessionViaBroker,
  type BrokerHandshake,
  type NativeControllerHost,
} from "./controller.js";
import { nativeStatus } from "./status-bar.js";
import { nativeSessionPanelView } from "./session-view.js";
import { renderDiagnostics } from "./diagnostics-view.js";

export { NATIVE_COMMANDS };

export interface NativeCommandDeps {
  readonly output: vscode.OutputChannel;
  /** Resolve (or prepare) the Prepared Workspace for the current window. */
  resolvePrepared(): Promise<{ source: string; prepared: string } | undefined>;
  deliveryMode(): "developer" | "strict";
  retrievalMode(): "disabled" | "conditional" | "required";
}

const STATUS_POLL_MS = 3_000;

function brokerScript(context: vscode.ExtensionContext): string {
  return join(context.extensionPath, "dist", "native-broker.js");
}

function controllerHost(output: vscode.OutputChannel, context: vscode.ExtensionContext): NativeControllerHost {
  return {
    log: (line) => output.appendLine(line),
    showMessage: (m) => void vscode.window.showInformationMessage(`Yuhi: ${m}`),
    showWarning: (m) => void vscode.window.showWarningMessage(m),
    choose: async (message, choices) => vscode.window.showInformationMessage(message, ...choices),
    spawnBroker: (configPath) => {
      // Detached and unref'd: the broker must survive this extension host.
      const child = spawn(process.execPath, [brokerScript(context), configPath], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    },
    readHandshake: async (path) => {
      try {
        return JSON.parse(await readFile(path, "utf8")) as BrokerHandshake;
      } catch {
        return undefined;
      }
    },
    writeJson: async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }),
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

/** The `yuhi.nativeSession` setting is the only way an isolated window knows its session. */
export function readNativeSessionSetting(): NativeSessionSettingValue | undefined {
  const value = vscode.workspace.getConfiguration("yuhi").get<unknown>("nativeSession");
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw["sessionId"] !== "string" || typeof raw["sessionRoot"] !== "string") return undefined;
  return {
    sessionId: raw["sessionId"],
    sessionRoot: raw["sessionRoot"],
    ...(typeof raw["controlUrl"] === "string" ? { controlUrl: raw["controlUrl"] } : {}),
  };
}

export function isIsolatedNativeWindow(): boolean {
  return readNativeSessionSetting() !== undefined;
}

// ---------------------------------------------------------------------------
// Originating window
// ---------------------------------------------------------------------------

let activeHandshake: BrokerHandshake | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let poller: NodeJS.Timeout | undefined;

async function commandOpen(context: vscode.ExtensionContext, deps: NativeCommandDeps): Promise<void> {
  if (isIsolatedNativeWindow()) {
    void vscode.window.showInformationMessage("Yuhi: this window is already a Native Claude GUI workspace.");
    return;
  }
  const resolved = await deps.resolvePrepared();
  if (!resolved) {
    void vscode.window.showWarningMessage(
      "Yuhi: open the folder you want to work on first. Native GUI Mode prepares it (or reuses an existing Prepared Workspace) and then opens Claude Code there.",
    );
    return;
  }

  const scratch = await mkdtemp(join(tmpdir(), "yuhi-native-"));
  const configPath = join(scratch, "broker-config.json");
  const handshakePath = join(scratch, "handshake.json");
  const host = controllerHost(deps.output, context);

  const handshake = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Yuhi", cancellable: false },
    async (progress) => {
      progress.report({ message: "Starting the Yuhi gateway and an isolated Claude Code window" });
      return startNativeSessionViaBroker(host, {
        sourceWorkspace: resolved.source,
        preparedWorkspace: resolved.prepared,
        deliveryMode: deps.deliveryMode(),
        retrievalMode: deps.retrievalMode(),
        configPath,
        handshakePath,
      });
    },
  );
  await rm(scratch, { recursive: true, force: true });
  if (!handshake) return;

  activeHandshake = handshake;
  deps.output.appendLine(`[native] session ${handshake.sessionId} started`);
  void vscode.window.showInformationMessage(
    "Yuhi: an isolated Claude Code window is opening. This window and your normal profile are unaffected.",
  );
  startStatusPolling(context, deps);
}

function settingFor(handshake: BrokerHandshake, controlUrl?: string): NativeSessionSettingValue {
  return { sessionId: handshake.sessionId, sessionRoot: handshake.sessionRoot, ...(controlUrl ? { controlUrl } : {}) };
}

/** The control URL lives in the session's private dir; the originating window may read it. */
async function controlUrlFor(handshake: BrokerHandshake): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(handshake.sessionRoot, "private", "attach-endpoint.json"), "utf8"));
    const url = (parsed as Record<string, unknown>)["url"];
    return typeof url === "string" ? url : undefined;
  } catch {
    return undefined;
  }
}

function startStatusPolling(context: vscode.ExtensionContext, deps: NativeCommandDeps): void {
  statusItem ??= vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  context.subscriptions.push(statusItem);
  if (poller) clearInterval(poller);
  poller = setInterval(() => {
    void (async () => {
      if (!activeHandshake) return;
      const url = await controlUrlFor(activeHandshake);
      const status = await createControlClient(settingFor(activeHandshake, url)).status();
      const d = status as NativeSessionDiagnostics | undefined;
      const view = nativeStatus(d, d?.vscodeAttached ?? false);
      if (statusItem) {
        statusItem.text = view.text;
        statusItem.tooltip = view.tooltip;
        statusItem.show();
      }
      if (d && (d.state === "closed" || d.state === "failed")) {
        if (poller) clearInterval(poller);
        poller = undefined;
        activeHandshake = undefined;
        statusItem?.hide();
      }
    })();
  }, STATUS_POLL_MS);
  context.subscriptions.push({ dispose: () => poller && clearInterval(poller) });
}

async function pickSession(): Promise<DiscoveredSession | undefined> {
  const sessions = await discoverSessions();
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage("Yuhi: no Native GUI sessions were found.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    sessions.map((s) => ({ label: s.sessionId, description: describeDiscovered(s), session: s })),
    { title: "Yuhi Native Dynamic Sessions" },
  );
  return picked?.session;
}

export function registerNativeCommands(context: vscode.ExtensionContext, deps: NativeCommandDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(NATIVE_COMMANDS.open, () => commandOpen(context, deps)),

    vscode.commands.registerCommand(NATIVE_COMMANDS.showSessions, async () => {
      const sessions = await discoverSessions();
      deps.output.show(true);
      deps.output.appendLine("Native Dynamic Sessions");
      if (sessions.length === 0) deps.output.appendLine("  none");
      for (const s of sessions) deps.output.appendLine(`  ${describeDiscovered(s)}`);
    }),

    vscode.commands.registerCommand(NATIVE_COMMANDS.focus, async () => {
      const session = activeHandshake ? undefined : await pickSession();
      const handshake = activeHandshake ?? (session ? { sessionId: session.sessionId, sessionRoot: session.layout.root, pid: 0 } : undefined);
      if (!handshake) return;
      const url = await controlUrlFor(handshake);
      const ok = await createControlClient(settingFor(handshake, url)).focus();
      if (!ok) void vscode.window.showWarningMessage("Yuhi: that session is no longer reachable. Run Yuhi: Recover Native Dynamic Sessions.");
    }),

    vscode.commands.registerCommand(NATIVE_COMMANDS.stop, async () => {
      const session = await pickSession();
      if (!session) return;
      const url = await controlUrlFor({ sessionId: session.sessionId, sessionRoot: session.layout.root, pid: 0 });
      const client = createControlClient(settingFor({ sessionId: session.sessionId, sessionRoot: session.layout.root, pid: 0 }, url));
      const stopped = await client.stop("user-request");
      if (!stopped) {
        // Unreachable broker: finish the shutdown from disk instead of leaving it stale.
        await recoverStaleSessions({});
      }
      void vscode.window.showInformationMessage("Yuhi: the Native GUI session has been stopped.");
    }),

    vscode.commands.registerCommand(NATIVE_COMMANDS.recover, async () => {
      const result = await recoverStaleSessions({});
      deps.output.show(true);
      deps.output.appendLine(
        `[native] recovery: inspected ${result.inspected}, recovered ${result.recovered.length}, still live ${result.skippedLive.length}, failed ${result.failed.length}`,
      );
      void vscode.window.showInformationMessage(
        `Yuhi: recovered ${result.recovered.length} stale session(s); ${result.skippedLive.length} still running.`,
      );
    }),

    vscode.commands.registerCommand(NATIVE_COMMANDS.diagnostics, async () => {
      deps.output.show(true);
      const all: NativeSessionDiagnostics[] = [];
      for (const s of await discoverSessions()) {
        const url = await controlUrlFor({ sessionId: s.sessionId, sessionRoot: s.layout.root, pid: 0 });
        const status = await createControlClient(settingFor({ sessionId: s.sessionId, sessionRoot: s.layout.root, pid: 0 }, url)).status();
        if (status) all.push(status as unknown as NativeSessionDiagnostics);
      }
      deps.output.appendLine(renderDiagnostics(all));
    }),
  ];
}

// ---------------------------------------------------------------------------
// Isolated window
// ---------------------------------------------------------------------------

/** Called from activate() when this window is a Yuhi Native GUI window. */
export async function activateIsolatedWindow(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<void> {
  const setting = readNativeSessionSetting();
  if (!setting) return;

  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(item);
  const connecting = nativeStatus(undefined, false);
  item.text = connecting.text;
  item.tooltip = connecting.tooltip;
  item.show();

  const session = await joinNativeSession({
    setting,
    clientInstanceId: `${process.pid}`,
    yuhiExtensionVersion: (context.extension.packageJSON as { version?: string }).version ?? "unknown",
    vscodeVersion: vscode.version,
    preparedWorkspaceHash: workspaceHash(folder),
    getExtension: (id) => {
      const ext = vscode.extensions.getExtension(id);
      return ext ? { id: ext.id, isActive: ext.isActive, packageJSON: ext.packageJSON, activate: async () => ext.activate() } : undefined;
    },
    executeCommand: (command, ...args) => Promise.resolve(vscode.commands.executeCommand(command, ...args)),
    getCommands: () => Promise.resolve(vscode.commands.getCommands(true)),
    log: (line) => output.appendLine(line),
    setStatus: (text, tooltip) => {
      item.text = text;
      item.tooltip = tooltip;
    },
  });

  if (!session) return;
  if (session.open) {
    const message = describeOpenOutcome(session.open);
    if (session.open.kind === "opened") output.appendLine(`[native] ${message}`);
    else void vscode.window.showWarningMessage(`Yuhi: ${message}`);
  }

  // Poll our own broker for stats so the isolated window shows the same numbers the
  // originating window does.
  const layout = sessionLayout(setting.sessionId);
  void layout;
  const tick = setInterval(() => {
    void (async () => {
      const status = await createControlClient(setting).status();
      const d = status as NativeSessionDiagnostics | undefined;
      const view = nativeStatus(d, session.attached);
      item.text = view.text;
      item.tooltip = view.tooltip;
    })();
  }, STATUS_POLL_MS);

  context.subscriptions.push({
    dispose: () => {
      clearInterval(tick);
      void session.dispose("window-closed");
    },
  });
}

export { nativeSessionPanelView };
