/**
 * Native GUI Mode orchestration, with no `vscode` import.
 *
 * Two roles live here because they are two halves of one protocol:
 *
 * - **Originating window** — resolves the workspace, spawns the broker as a detached
 *   process, waits for its handshake, then talks to it over the control channel.
 * - **Isolated window** — discovers the session from `yuhi.nativeSession`, attaches with the
 *   bootstrap token, opens the official Claude panel, and heartbeats.
 *
 * The broker is spawned rather than run in-process on purpose. An extension host owns
 * nothing that must outlive it, so a window reload cannot strand a gateway.
 */

import { createAttachClient, createControlClient, type ControlClient, type NativeSessionSettingValue } from "./attach-client.js";
import { openOfficialClaudePanel, type ClaudeAdapterHost, type ClaudeOpenOutcome } from "./claude-adapter.js";

export const NATIVE_COMMANDS = {
  open: "yuhi.openClaudeDynamicWorkspace",
  showSessions: "yuhi.showNativeDynamicSessions",
  focus: "yuhi.focusNativeDynamicWorkspace",
  stop: "yuhi.stopNativeDynamicSession",
  recover: "yuhi.recoverNativeDynamicSessions",
  diagnostics: "yuhi.showNativeDynamicDiagnostics",
} as const;

export interface BrokerHandshake {
  readonly sessionId: string;
  readonly sessionRoot: string;
  readonly pid: number;
}

export interface NativeControllerHost {
  log(line: string): void;
  showMessage(message: string): void;
  showWarning(message: string): void;
  choose(message: string, choices: readonly string[]): Promise<string | undefined>;
  /** Start the broker detached and return immediately. */
  spawnBroker(configPath: string): void;
  /** Poll for the handshake file the broker writes once its session exists. */
  readHandshake(path: string): Promise<BrokerHandshake | undefined>;
  writeJson(path: string, value: unknown): Promise<void>;
  delay(ms: number): Promise<void>;
  now(): number;
}

export const BROKER_HANDSHAKE_TIMEOUT_MS = 180_000;

export interface StartNativeInput {
  readonly sourceWorkspace: string;
  readonly preparedWorkspace: string;
  readonly deliveryMode: "developer" | "strict";
  readonly retrievalMode: "disabled" | "conditional" | "required";
  readonly configPath: string;
  readonly handshakePath: string;
  readonly vscodeExecutable?: string;
  readonly extensionVersion?: string;
  readonly mcpServerScript?: string;
}

/**
 * Spawn the broker and wait for it to report a live session.
 *
 * The wait is long because the first launch may download the official extension. A timeout
 * here is reported, never swallowed: the alternative is a user staring at a window that will
 * not arrive.
 */
export async function startNativeSessionViaBroker(
  host: NativeControllerHost,
  input: StartNativeInput,
): Promise<BrokerHandshake | undefined> {
  await host.writeJson(input.configPath, {
    sourceWorkspace: input.sourceWorkspace,
    preparedWorkspace: input.preparedWorkspace,
    deliveryMode: input.deliveryMode,
    retrievalMode: input.retrievalMode,
    handshakeFile: input.handshakePath,
    ...(input.vscodeExecutable ? { vscodeExecutable: input.vscodeExecutable } : {}),
    ...(input.extensionVersion ? { extensionVersion: input.extensionVersion } : {}),
    ...(input.mcpServerScript ? { mcpServerScript: input.mcpServerScript } : {}),
  });

  host.spawnBroker(input.configPath);

  const deadline = host.now() + BROKER_HANDSHAKE_TIMEOUT_MS;
  while (host.now() < deadline) {
    const handshake = await host.readHandshake(input.handshakePath);
    if (handshake) {
      host.log(`[native] broker ready (pid ${handshake.pid})`);
      return handshake;
    }
    await host.delay(500);
  }
  host.showWarning(
    "Yuhi: the Native GUI session did not start in time. Nothing was left running; try again, or use Dynamic Terminal Mode.",
  );
  return undefined;
}

export function controlFor(handshake: BrokerHandshake, controlUrl?: string): ControlClient {
  return createControlClient({ sessionId: handshake.sessionId, sessionRoot: handshake.sessionRoot, ...(controlUrl ? { controlUrl } : {}) });
}

// ---------------------------------------------------------------------------
// Isolated window
// ---------------------------------------------------------------------------

export interface IsolatedWindowHost extends ClaudeAdapterHost {
  readonly setting: NativeSessionSettingValue | undefined;
  readonly clientInstanceId: string;
  readonly yuhiExtensionVersion: string;
  readonly vscodeVersion: string;
  readonly preparedWorkspaceHash: string;
  setStatus(text: string, tooltip: string): void;
}

export interface IsolatedWindowSession {
  readonly attached: boolean;
  readonly open: ClaudeOpenOutcome | undefined;
  dispose(reason: string): Promise<void>;
}

/**
 * Bring this window into the session: attach, start beating, open the official panel.
 *
 * Attach failure is fatal for the window's role but NOT for the session — the gateway is
 * already serving whatever the extension launches. So the user is told plainly rather than
 * having the panel refused.
 */
export async function joinNativeSession(host: IsolatedWindowHost): Promise<IsolatedWindowSession | undefined> {
  if (!host.setting?.controlUrl) return undefined;

  const client = createAttachClient({
    setting: host.setting,
    clientInstanceId: host.clientInstanceId,
    yuhiExtensionVersion: host.yuhiExtensionVersion,
    vscodeVersion: host.vscodeVersion,
    claudeExtensionVersion: "",
    preparedWorkspaceHash: host.preparedWorkspaceHash,
    onLost: (status) => host.log(`[native] broker rejected a heartbeat (${status}); this window is no longer attached.`),
  });

  const attached = await client.attach().catch(() => false);
  if (!attached) {
    host.log("[native] could not attach to the Yuhi session for this window.");
    return { attached: false, open: undefined, dispose: async () => client.dispose() };
  }
  client.startHeartbeat();

  const open = await openOfficialClaudePanel(host);
  client.setClaudeReady(open.kind === "opened");
  return {
    attached: true,
    open,
    dispose: async (reason: string) => {
      await client.detach(reason);
      client.dispose();
    },
  };
}

export function describeOpenOutcome(outcome: ClaudeOpenOutcome): string {
  switch (outcome.kind) {
    case "opened":
      return "Claude Code is open in this window and using the Yuhi gateway.";
    case "not-installed":
      return "The official Claude Code extension is not installed in this isolated Yuhi profile.";
    case "contract-broken":
      return "Installed Claude Code extension is incompatible with Yuhi Native GUI Mode.";
    case "no-open-command":
      return "This Claude Code version exposes no command Yuhi can use to open the panel. Open it from the Command Palette; the gateway is already active.";
    case "command-failed":
      return `Yuhi could not open the Claude Code panel (${outcome.command}). Open it from the Command Palette; the gateway is already active.`;
  }
}
